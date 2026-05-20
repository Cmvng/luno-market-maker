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

  let buyPrice = spread.bestBid + tick; // one tick above best bid
  let sellPrice = spread.bestAsk - tick; // one tick below best ask

  // === BOT WAR PROTECTION ===
  const maxBidPrice = spread.midPrice * (1 - config.MAX_BID_DISTANCE_PCT / 100);
  const minAskPrice = spread.midPrice * (1 + config.MAX_ASK_DISTANCE_PCT / 100);

  // Don't bid too high or ask too low
  if (buyPrice > spread.midPrice) buyPrice = spread.midPrice - tick;
  if (sellPrice < spread.midPrice) sellPrice = spread.midPrice + tick;

  // Ensure minimum spread between our buy and sell
  const ourSpread = sellPrice - buyPrice;
  const minSpread = isUsdt ? config.USDT_MIN_SPREAD_NGN : spread.midPrice * config.BTC_MIN_SPREAD_PCT / 100;
  if (ourSpread < minSpread) {
    log(`Spread too tight after adjustments (₦${ourSpread.toFixed(4)}). Skipping.`);
    return;
  }

  // === INVENTORY SKEW ===
  const skew = state.getInventorySkew();
  const skewAmount = isUsdt ? config.INVENTORY_SKEW_NGN : spread.midPrice * 0.001;

  if (skew === 'SELL_SKEW') {
    sellPrice -= skewAmount; // lower sell to exit crypto faster
  } else if (skew === 'SELL_URGENT') {
    sellPrice -= skewAmount * 3;
  } else if (skew === 'BUY_SKEW') {
    buyPrice += skewAmount; // raise buy to enter crypto faster
  } else if (skew === 'BUY_URGENT') {
    buyPrice += skewAmount * 3;
  }

  // === CAUTION MODE: widen spread ===
  if (state.state === 'CAUTION') {
    const widen = isUsdt ? 1.5 : spread.midPrice * 0.003;
    buyPrice -= widen;
    sellPrice += widen;
  }

  // Round prices appropriately
  // Luno USDT/NGN accepts 2 decimal places for price and volume
  if (isUsdt) {
    buyPrice = Math.floor(buyPrice * 100) / 100;    // round DOWN for buy
    sellPrice = Math.ceil(sellPrice * 100) / 100;    // round UP for sell
  } else {
    buyPrice = Math.floor(buyPrice);                  // whole numbers for BTC/NGN
    sellPrice = Math.ceil(sellPrice);
  }

  // === CALCULATE ORDER SIZE ===
  // Use only 50% of available balance per side to keep both sides funded
  let buyVolume, sellVolume;
  const CAPITAL_PER_SIDE = 0.48; // use 48% of available (leaves room for rounding)

  if (isUsdt) {
    // Buy side: how much USDT can we buy with available NGN?
    buyVolume = Math.floor((state.ngnBalance * CAPITAL_PER_SIDE / buyPrice) * 100) / 100;
    buyVolume = Math.min(buyVolume, config.MAX_ORDER_USDT);
    buyVolume = Math.max(buyVolume, 0);

    // Sell side: how much USDT do we have?
    sellVolume = Math.floor(state.usdtBalance * CAPITAL_PER_SIDE * 100) / 100;
    sellVolume = Math.min(sellVolume, config.MAX_ORDER_USDT);
    sellVolume = Math.max(sellVolume, 0);
  } else {
    // BTC — 6 decimal places for volume
    buyVolume = Math.floor((state.ngnBalance * CAPITAL_PER_SIDE / buyPrice) * 1000000) / 1000000;
    buyVolume = Math.min(buyVolume, config.MAX_ORDER_BTC);
    buyVolume = Math.max(buyVolume, 0);

    sellVolume = Math.floor(state.btcBalance * CAPITAL_PER_SIDE * 1000000) / 1000000;
    sellVolume = Math.min(sellVolume, config.MAX_ORDER_BTC);
    sellVolume = Math.max(sellVolume, 0);
  }

  const minVol = isUsdt ? config.MIN_ORDER_USDT : config.MIN_ORDER_BTC;

  // === INVENTORY PROTECTION: don't buy more if already overloaded ===
  const invRatio = state.getInventoryRatio();
  const skipBuy = invRatio > config.IMBALANCE_CRITICAL_RATIO;   // too much crypto, stop buying
  const skipSell = invRatio < (1 - config.IMBALANCE_CRITICAL_RATIO); // too much NGN, stop selling

  // === PLACE BUY ORDER ===
  if (!state.buyOrderId && buyVolume >= minVol && !skipBuy) {
    try {
      const res = await luno.createOrder(pair, 'BID', buyVolume, buyPrice, true);
      state.buyOrderId = res.order_id;
      state.buyOrderPrice = buyPrice;
      state.buyOrderVolume = buyVolume;
      log(`📗 BUY ${buyVolume} @ ₦${buyPrice} [${res.order_id}]`);
    } catch (err) {
      if (!err.message.includes('ErrOrderCanceled')) {
        log(`Failed buy: ${err.message} (vol=${buyVolume} price=${buyPrice})`);
        state.consecutiveErrors++;
      }
    }
  }

  // === PLACE SELL ORDER ===
  if (!state.sellOrderId && sellVolume >= minVol && !skipSell) {
    try {
      const res = await luno.createOrder(pair, 'ASK', sellVolume, sellPrice, true);
      state.sellOrderId = res.order_id;
      state.sellOrderPrice = sellPrice;
      state.sellOrderVolume = sellVolume;
      log(`📕 SELL ${sellVolume} @ ₦${sellPrice} [${res.order_id}]`);
    } catch (err) {
      if (!err.message.includes('ErrOrderCanceled')) {
        log(`Failed sell: ${err.message} (vol=${sellVolume} price=${sellPrice})`);
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

  // AGGRESSIVE: cancel and replace if we're NOT exactly at top of book
  // Any deviation = instant refresh
  if (state.buyOrderId && state.buyOrderPrice < idealBuy - 0.001) {
    try {
      await luno.cancelOrder(state.buyOrderId);
      state.buyOrderId = null;
    } catch (err) { state.buyOrderId = null; }
  }

  if (state.sellOrderId && state.sellOrderPrice > idealSell + 0.001) {
    try {
      await luno.cancelOrder(state.sellOrderId);
      state.sellOrderId = null;
    } catch (err) { state.sellOrderId = null; }
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

mainLoop().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
