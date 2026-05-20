// src/index.js — Main Bot Engine
const { LunoClient } = require('./luno');
const { TelegramBot } = require('./telegram');
const { StateEngine } = require('./state');
const config = require('./config');

// === INIT ===
const luno = new LunoClient(config.LUNO_API_KEY, config.LUNO_API_SECRET);
const telegram = new TelegramBot(config.TELEGRAM_BOT_TOKEN, config.TELEGRAM_CHAT_ID);
const state = new StateEngine();

let isRunning = true;
let lastDailyReset = new Date().getDate();

// === HELPER FUNCTIONS ===

function log(msg) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] ${msg}`);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// === CORE: FETCH ORDER BOOK & CALCULATE SPREAD ===

async function getSpread(pair) {
  try {
    const book = await luno.getOrderBook(pair);
    if (!book.asks || !book.bids || book.asks.length === 0 || book.bids.length === 0) {
      return null;
    }
    const bestBid = parseFloat(book.bids[0].price);
    const bestAsk = parseFloat(book.asks[0].price);
    const midPrice = (bestBid + bestAsk) / 2;
    const spreadNgn = bestAsk - bestBid;
    const spreadPct = (spreadNgn / midPrice) * 100;

    return {
      bestBid,
      bestAsk,
      midPrice,
      spreadNgn,
      spreadPct,
      bidVolume: parseFloat(book.bids[0].volume),
      askVolume: parseFloat(book.asks[0].volume),
    };
  } catch (err) {
    log(`Error fetching ${pair} order book: ${err.message}`);
    return null;
  }
}

// === CORE: PAIR SELECTION ===

async function selectBestPair() {
  const usdtSpread = await getSpread(config.PRIMARY_PAIR);
  const btcSpread = await getSpread(config.SECONDARY_PAIR);

  log(`USDT spread: ${usdtSpread ? `₦${usdtSpread.spreadNgn.toFixed(4)} (${usdtSpread.spreadPct.toFixed(4)}%)` : 'unavailable'}`);
  log(`BTC spread:  ${btcSpread ? `₦${btcSpread.spreadNgn.toLocaleString()} (${btcSpread.spreadPct.toFixed(4)}%)` : 'unavailable'}`);

  // Prefer USDT if spread is acceptable
  if (usdtSpread && usdtSpread.spreadPct >= config.USDT_MIN_SPREAD_PCT) {
    return { pair: config.PRIMARY_PAIR, spread: usdtSpread };
  }

  // Fall back to BTC if its spread is good enough
  if (btcSpread && btcSpread.spreadPct >= config.BTC_MIN_SPREAD_PCT) {
    return { pair: config.SECONDARY_PAIR, spread: btcSpread };
  }

  // Neither pair is worth trading
  return null;
}

// === CORE: UPDATE BALANCES ===

async function updateBalances() {
  try {
    const res = await luno.getBalances();
    
    // Debug: log raw response structure on first call
    if (state.dailyRotations === 0 && state.ngnBalance === 0) {
      log(`DEBUG balance response keys: ${JSON.stringify(Object.keys(res))}`);
      if (res.balance && res.balance.length > 0) {
        log(`DEBUG first account: ${JSON.stringify(res.balance[0])}`);
      }
    }
    
    const accounts = res.balance || [];
    for (const acc of accounts) {
      // Luno API may use 'asset' or 'currency' depending on version
      const currency = acc.asset || acc.currency || '';
      const bal = parseFloat(acc.balance || 0);
      const reserved = parseFloat(acc.reserved || 0);
      const available = bal - reserved;
      
      if (currency === 'NGN') state.ngnBalance = available;
      if (currency === 'USDT') state.usdtBalance = available;
      if (currency === 'XBT') state.btcBalance = available;
    }
    log(`Balances — NGN: ₦${state.ngnBalance.toFixed(2)} | USDT: ${state.usdtBalance.toFixed(4)} | BTC: ${state.btcBalance.toFixed(8)}`);
  } catch (err) {
    log(`Error fetching balances: ${err.message}`);
  }
}

// === CORE: CHECK IF OUR ORDERS WERE FILLED ===

async function checkOrderFills() {
  let buyFilled = false;
  let sellFilled = false;

  if (state.buyOrderId) {
    try {
      const order = await luno.getOrder(state.buyOrderId);
      if (order.state === 'COMPLETE') {
        buyFilled = true;
        log(`✅ BUY FILLED @ ₦${state.buyOrderPrice}`);
        await telegram.fill('BUY', state.activePair, state.buyOrderPrice, state.buyOrderVolume);
        state.buyOrderId = null;
      } else if (order.state === 'CANCELLED' || order.state === 'EXPIRED') {
        state.buyOrderId = null;
      }
    } catch (err) {
      // Order might not exist anymore
      state.buyOrderId = null;
    }
  }

  if (state.sellOrderId) {
    try {
      const order = await luno.getOrder(state.sellOrderId);
      if (order.state === 'COMPLETE') {
        sellFilled = true;
        log(`✅ SELL FILLED @ ₦${state.sellOrderPrice}`);
        await telegram.fill('SELL', state.activePair, state.sellOrderPrice, state.sellOrderVolume);
        state.sellOrderId = null;
      } else if (order.state === 'CANCELLED' || order.state === 'EXPIRED') {
        state.sellOrderId = null;
      }
    } catch (err) {
      state.sellOrderId = null;
    }
  }

  // If both sides completed = full rotation
  if (buyFilled && sellFilled) {
    const profit = (state.sellOrderPrice - state.buyOrderPrice) * state.buyOrderVolume;
    state.recordRotation(profit);
    log(`🔄 ROTATION COMPLETE — Profit: ₦${profit.toFixed(2)} | Daily P&L: ₦${state.dailyPnl.toFixed(2)} | Rotations: ${state.dailyRotations}`);
  }

  return { buyFilled, sellFilled };
}

// === CORE: CANCEL ALL OPEN ORDERS ===

async function cancelAllOrders() {
  if (state.buyOrderId) {
    try {
      await luno.cancelOrder(state.buyOrderId);
      log(`Cancelled buy order ${state.buyOrderId}`);
    } catch (err) { /* already cancelled or filled */ }
    state.buyOrderId = null;
  }
  if (state.sellOrderId) {
    try {
      await luno.cancelOrder(state.sellOrderId);
      log(`Cancelled sell order ${state.sellOrderId}`);
    } catch (err) { /* already cancelled or filled */ }
    state.sellOrderId = null;
  }
}

// === CORE: PLACE ORDERS ===

async function placeOrders(spread) {
  const pair = state.activePair;
  const isUsdt = pair === 'USDTNGN';
  const tick = isUsdt ? config.PRICE_TICK_USDT : config.PRICE_TICK_BTC;
  const minSpread = isUsdt ? config.USDT_MIN_SPREAD_NGN : spread.midPrice * config.BTC_MIN_SPREAD_PCT / 100;

  // === COMPETITOR-AWARE PRICING ===
  // Based on observed patterns:
  // - Other bot's ask floor: ~1386.40 (they won't sell below this)
  // - Other bot's bid ceiling: ~1386.10 (they won't buy above this)
  // - Other bot undercuts by 0.16 per cycle until they hit floor
  //
  // STRATEGY: Place our orders at THEIR limits
  // - Our sell sits at their floor — they chase down to us, we're already there
  // - Our buy sits at their ceiling — we catch fills at the best price they'll allow

  // Dynamic pricing: use order book but with competitor floor/ceiling awareness
  let buyPrice = spread.bestBid + tick;
  let sellPrice = spread.bestAsk - tick;

  // Don't cross mid
  if (buyPrice >= spread.midPrice) buyPrice = spread.midPrice - tick;
  if (sellPrice <= spread.midPrice) sellPrice = spread.midPrice + tick;

  // === KEY INSIGHT: Don't chase below competitor floor ===
  // If our sell would go below 1386.40, stay at 1386.40
  // The other bot will come to us
  if (isUsdt) {
    const COMPETITOR_ASK_FLOOR = spread.midPrice - (spread.spreadNgn * 0.15);
    if (sellPrice < COMPETITOR_ASK_FLOOR) sellPrice = COMPETITOR_ASK_FLOOR;
    
    // On buy side, be aggressive up to near mid but not past it
    const COMPETITOR_BID_CEILING = spread.midPrice + (spread.spreadNgn * 0.15);
    if (buyPrice > COMPETITOR_BID_CEILING) buyPrice = COMPETITOR_BID_CEILING;
  }

  // Safety: maintain minimum spread between our buy and sell
  if (sellPrice - buyPrice < minSpread * 0.8) return;

  // === CAUTION MODE ===
  if (state.state === 'CAUTION') {
    buyPrice -= isUsdt ? 1.5 : spread.midPrice * 0.003;
    sellPrice += isUsdt ? 1.5 : spread.midPrice * 0.003;
  }

  // === ROUND ===
  if (isUsdt) {
    buyPrice = Math.floor(buyPrice * 100) / 100;
    sellPrice = Math.ceil(sellPrice * 100) / 100;
  } else {
    buyPrice = Math.floor(buyPrice);
    sellPrice = Math.ceil(sellPrice);
  }

  // === ORDER SIZE ===
  const CAP = 0.48;
  let buyVolume, sellVolume;
  if (isUsdt) {
    buyVolume = Math.floor((state.ngnBalance * CAP / buyPrice) * 100) / 100;
    sellVolume = Math.floor(state.usdtBalance * CAP * 100) / 100;
    buyVolume = Math.min(Math.max(buyVolume, 0), config.MAX_ORDER_USDT);
    sellVolume = Math.min(Math.max(sellVolume, 0), config.MAX_ORDER_USDT);
  } else {
    buyVolume = Math.floor((state.ngnBalance * CAP / buyPrice) * 1000000) / 1000000;
    sellVolume = Math.floor(state.btcBalance * CAP * 1000000) / 1000000;
    buyVolume = Math.min(Math.max(buyVolume, 0), config.MAX_ORDER_BTC);
    sellVolume = Math.min(Math.max(sellVolume, 0), config.MAX_ORDER_BTC);
  }
  const minVol = isUsdt ? config.MIN_ORDER_USDT : config.MIN_ORDER_BTC;

  // === INVENTORY PROTECTION ===
  const invRatio = state.getInventoryRatio();
  const skipBuy = invRatio > config.IMBALANCE_CRITICAL_RATIO;
  const skipSell = invRatio < (1 - config.IMBALANCE_CRITICAL_RATIO);

  // === PLACE BUY ===
  if (!state.buyOrderId && buyVolume >= minVol && !skipBuy) {
    try {
      const res = await luno.createOrder(pair, 'BID', buyVolume, buyPrice, true);
      state.buyOrderId = res.order_id;
      state.buyOrderPrice = buyPrice;
      state.buyOrderVolume = buyVolume;
      state._buyFails = 0;
      log('📗 BUY ' + buyVolume + ' @ ₦' + buyPrice);
    } catch (err) {
      if (err.message.includes('ErrOrderCanceled')) {
        state._buyFails = (state._buyFails || 0) + 1;
        if (state._buyFails >= 3) {
          state.buyOrderId = 'COOLDOWN';
          setTimeout(() => { state.buyOrderId = null; }, 10000);
          state._buyFails = 0;
        }
      } else {
        state.consecutiveErrors++;
      }
    }
  }

  // === PLACE SELL ===
  if (!state.sellOrderId && sellVolume >= minVol && !skipSell) {
    try {
      const res = await luno.createOrder(pair, 'ASK', sellVolume, sellPrice, true);
      state.sellOrderId = res.order_id;
      state.sellOrderPrice = sellPrice;
      state.sellOrderVolume = sellVolume;
      state._sellFails = 0;
      log('📕 SELL ' + sellVolume + ' @ ₦' + sellPrice);
    } catch (err) {
      if (err.message.includes('ErrOrderCanceled')) {
        state._sellFails = (state._sellFails || 0) + 1;
        if (state._sellFails >= 3) {
          state.sellOrderId = 'COOLDOWN';
          setTimeout(() => { state.sellOrderId = null; }, 10000);
          state._sellFails = 0;
        }
      } else {
        state.consecutiveErrors++;
      }
    }
  }
}

// === CORE: CHECK IF ORDERS NEED REPLACING (stay on top) ===

async function refreshOrders(spread) {
  const pair = state.activePair;
  const isUsdt = pair === 'USDTNGN';
  const tick = isUsdt ? config.PRICE_TICK_USDT : config.PRICE_TICK_BTC;

  const idealBuy = spread.bestBid + tick;
  const idealSell = spread.bestAsk - tick;
  const minSpread = isUsdt ? config.USDT_MIN_SPREAD_NGN : spread.midPrice * config.BTC_MIN_SPREAD_PCT / 100;

  // Don't refresh if spread is too tight — both sides stay cancelled
  if (spread.spreadNgn < minSpread) return;

  // Safety: our buy and sell must maintain minimum distance
  if (idealSell - idealBuy < minSpread) return;

  // BUY SIDE: aggressive — if we're not top bid, refresh
  if (state.buyOrderId && state.buyOrderPrice < idealBuy - 0.005) {
    try {
      await luno.cancelOrder(state.buyOrderId);
      state.buyOrderId = null;
    } catch (err) { state.buyOrderId = null; }
  }

  // SELL SIDE: aggressive — if we're not top ask, refresh
  // But only if our new sell price would still be ABOVE our buy price by minSpread
  if (state.sellOrderId && state.sellOrderPrice > idealSell + 0.005) {
    const newSellWouldBeProfit = idealSell > (state.buyOrderPrice || idealBuy - tick) + minSpread * 0.5;
    if (newSellWouldBeProfit) {
      try {
        await luno.cancelOrder(state.sellOrderId);
        state.sellOrderId = null;
      } catch (err) { state.sellOrderId = null; }
    }
  }
}

// === MAIN LOOP ===

async function mainLoop() {
  await telegram.startup();
  log('🚀 Bot starting...');
  log(`Primary pair: ${config.PRIMARY_PAIR} | Secondary: ${config.SECONDARY_PAIR}`);

  // Cancel any leftover orders from previous run
  log('Cancelling any leftover orders from previous run...');
  try {
    const usdtOrders = await luno.listOrders('USDTNGN', 'PENDING');
    if (usdtOrders.orders) {
      for (const order of usdtOrders.orders) {
        await luno.cancelOrder(order.order_id);
        log(`Cancelled leftover USDT order: ${order.order_id}`);
      }
    }
    const btcOrders = await luno.listOrders('XBTNGN', 'PENDING');
    if (btcOrders.orders) {
      for (const order of btcOrders.orders) {
        await luno.cancelOrder(order.order_id);
        log(`Cancelled leftover BTC order: ${order.order_id}`);
      }
    }
  } catch (err) {
    log(`Warning: Could not cancel leftover orders: ${err.message}`);
  }

  // Wait for orders to settle
  await sleep(2000);

  // Initial balance fetch
  await updateBalances();
  state.startingCapitalNgn = state.ngnBalance + (state.usdtBalance * 1385) + (state.btcBalance * 106000000);
  log(`Starting capital estimate: ₦${state.startingCapitalNgn.toFixed(0)}`);

  while (isRunning) {
    try {
      // === DAILY RESET ===
      const today = new Date().getDate();
      if (today !== lastDailyReset) {
        await telegram.dailySummary({
          rotations: state.dailyRotations,
          totalPnl: state.dailyPnl,
          avgPnl: state.dailyRotations > 0 ? state.dailyPnl / state.dailyRotations : 0,
          activePair: state.activePair,
          inventoryRatio: `${((1 - state.getInventoryRatio()) * 100).toFixed(0)}/${(state.getInventoryRatio() * 100).toFixed(0)} NGN/Crypto`,
        });
        await updateBalances();
        state.resetDaily(state.ngnBalance + (state.usdtBalance * 1385));
        lastDailyReset = today;
      }

      // === CHECK SLEEP ===
      if (state.checkSleep()) {
        log('💤 Sleeping — spreads too tight...');
        await sleep(10000);
        continue;
      }

      // === CHECK DAILY LOSS LIMIT ===
      if (state.isDailyLossLimitHit()) {
        await cancelAllOrders();
        await telegram.shutdown(`Daily loss limit hit: ₦${state.dailyPnl.toFixed(2)}`);
        log('⛔ Daily loss limit hit. Stopping.');
        isRunning = false;
        break;
      }

      // === CHECK CONSECUTIVE ERRORS ===
      if (state.consecutiveErrors >= config.MAX_CONSECUTIVE_ERRORS) {
        await cancelAllOrders();
        await telegram.error(`${state.consecutiveErrors} consecutive errors. Pausing 60s.`);
        state.consecutiveErrors = 0;
        await sleep(60000);
        continue;
      }

      // === PAIR SELECTION (every 30s) ===
      if (state.shouldCheckPairSwitch()) {
        state.markPairChecked();
        const best = await selectBestPair();

        if (!best) {
          log('😴 No pair with sufficient spread. Sleeping...');
          await cancelAllOrders();
          state.sleep();
          continue;
        }

        if (best.pair !== state.activePair) {
          const oldPair = state.activePair;
          await cancelAllOrders();
          state.activePair = best.pair;
          state.priceHistory = []; // reset price history for new pair
          await telegram.pairSwitch(oldPair, best.pair, `Spread: ${best.spread.spreadPct.toFixed(4)}%`);
          log(`🔄 Switched to ${best.pair}`);
        }
      }

      // === FETCH CURRENT SPREAD ===
      const spread = await getSpread(state.activePair);
      if (!spread) {
        state.consecutiveErrors++;
        await sleep(config.LOOP_INTERVAL_MS);
        continue;
      }
      state.consecutiveErrors = 0; // reset on success

      // === UPDATE PRICE HISTORY & STATE ===
      state.addPrice(spread.midPrice);
      const stateResult = state.updateState();

      if (stateResult.changed) {
        await telegram.stateChange(
          state.state === stateResult.state ? 'CALM' : state.state,
          stateResult.state,
          `Rate change: ${stateResult.rateChange.toFixed(4)}%`
        );
      }

      // === DANGER MODE: PULL EVERYTHING ===
      if (state.state === 'DANGER') {
        await cancelAllOrders();
        log(`🔴 DANGER — Rate change: ${stateResult.rateChange.toFixed(4)}%. Orders cancelled. Waiting...`);
        await sleep(config.LOOP_INTERVAL_MS * 3);
        continue;
      }

      // === CHECK FOR FILLS ===
      await checkOrderFills();

      // === UPDATE BALANCES (every 5 seconds at 1s loop speed) ===
      if (!state._balanceCounter) state._balanceCounter = 0;
      state._balanceCounter++;
      if (state._balanceCounter >= 5 || !state.buyOrderId || !state.sellOrderId) {
        await updateBalances();
        state._balanceCounter = 0;
      }

      // === REFRESH ORDERS TO STAY ON TOP ===
      await refreshOrders(spread);

      // === PLACE NEW ORDERS IF NEEDED ===
      await placeOrders(spread);

      // === LOG STATUS (every 10 seconds to reduce noise) ===
      if (Date.now() % 10000 < config.LOOP_INTERVAL_MS) {
        log(
          `${state.state} | ${state.activePair} | ` +
          `Spread: ₦${spread.spreadNgn.toFixed(2)} | ` +
          `Inv: ${(state.getInventoryRatio() * 100).toFixed(0)}% | ` +
          `P&L: ₦${state.dailyPnl.toFixed(2)} | ` +
          `Rot: ${state.dailyRotations} | ` +
          `Buy: ${state.buyOrderId ? '✅' : '❌'} Sell: ${state.sellOrderId ? '✅' : '❌'}`
        );
      }

    } catch (err) {
      log(`❌ Loop error: ${err.message}`);
      state.consecutiveErrors++;
      await telegram.error(err.message);
    }

    await sleep(config.LOOP_INTERVAL_MS);
  }
}

// === GRACEFUL SHUTDOWN ===

async function shutdown(signal) {
  log(`\n${signal} received. Shutting down gracefully...`);
  isRunning = false;
  await cancelAllOrders();
  await telegram.shutdown(`Bot stopped (${signal})`);
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// === START ===

if (!config.LUNO_API_KEY || !config.LUNO_API_SECRET) {
  console.error('❌ Missing LUNO_API_KEY_ID or LUNO_API_SECRET environment variables.');
  console.error('Set them in your Railway dashboard or .env file.');
  process.exit(1);
}

// Keep-alive HTTP server so Railway doesn't kill the container
const http = require('http');
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200);
  res.end(JSON.stringify({
    status: 'running',
    pair: state.activePair,
    state: state.state,
    pnl: state.dailyPnl,
    rotations: state.dailyRotations,
  }));
}).listen(PORT, () => {
  console.log(`Health check server on port ${PORT}`);
});

mainLoop().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
