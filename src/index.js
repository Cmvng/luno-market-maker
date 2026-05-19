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
    for (const acc of res.balance) {
      if (acc.asset === 'NGN') state.ngnBalance = parseFloat(acc.balance) - parseFloat(acc.reserved);
      if (acc.asset === 'USDT') state.usdtBalance = parseFloat(acc.balance) - parseFloat(acc.reserved);
      if (acc.asset === 'XBT') state.btcBalance = parseFloat(acc.balance) - parseFloat(acc.reserved);
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
  if (isUsdt) {
    buyPrice = Math.round(buyPrice * 10000) / 10000;
    sellPrice = Math.round(sellPrice * 10000) / 10000;
  } else {
    buyPrice = Math.round(buyPrice);
    sellPrice = Math.round(sellPrice);
  }

  // === CALCULATE ORDER SIZE ===
  let buyVolume, sellVolume;

  if (isUsdt) {
    // Buy side: how much USDT can we buy with available NGN?
    buyVolume = Math.floor((state.ngnBalance * 0.95 / buyPrice) * 10000) / 10000; // use 95% of available
    buyVolume = Math.min(buyVolume, config.MAX_ORDER_USDT);
    buyVolume = Math.max(buyVolume, 0);

    // Sell side: how much USDT do we have?
    sellVolume = Math.floor(state.usdtBalance * 0.95 * 10000) / 10000;
    sellVolume = Math.min(sellVolume, config.MAX_ORDER_USDT);
    sellVolume = Math.max(sellVolume, 0);
  } else {
    // BTC
    buyVolume = Math.floor((state.ngnBalance * 0.95 / buyPrice) * 100000000) / 100000000;
    buyVolume = Math.min(buyVolume, config.MAX_ORDER_BTC);
    buyVolume = Math.max(buyVolume, 0);

    sellVolume = Math.floor(state.btcBalance * 0.95 * 100000000) / 100000000;
    sellVolume = Math.min(sellVolume, config.MAX_ORDER_BTC);
    sellVolume = Math.max(sellVolume, 0);
  }

  const minVol = isUsdt ? config.MIN_ORDER_USDT : config.MIN_ORDER_BTC;

  // === PLACE BUY ORDER ===
  if (!state.buyOrderId && buyVolume >= minVol) {
    try {
      const res = await luno.createOrder(pair, 'BID', buyVolume, buyPrice, true);
      state.buyOrderId = res.order_id;
      state.buyOrderPrice = buyPrice;
      state.buyOrderVolume = buyVolume;
      log(`📗 BUY placed: ${buyVolume} @ ₦${buyPrice} [${res.order_id}]`);
    } catch (err) {
      log(`Failed to place buy: ${err.message}`);
      state.consecutiveErrors++;
    }
  }

  // === PLACE SELL ORDER ===
  if (!state.sellOrderId && sellVolume >= minVol) {
    try {
      const res = await luno.createOrder(pair, 'ASK', sellVolume, sellPrice, true);
      state.sellOrderId = res.order_id;
      state.sellOrderPrice = sellPrice;
      state.sellOrderVolume = sellVolume;
      log(`📕 SELL placed: ${sellVolume} @ ₦${sellPrice} [${res.order_id}]`);
    } catch (err) {
      log(`Failed to place sell: ${err.message}`);
      state.consecutiveErrors++;
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

  // If our buy is no longer at the top, cancel and replace
  if (state.buyOrderId && Math.abs(state.buyOrderPrice - idealBuy) > tick * 2) {
    try {
      await luno.cancelOrder(state.buyOrderId);
      state.buyOrderId = null;
      log(`Refreshing buy order — was ₦${state.buyOrderPrice}, ideal is ₦${idealBuy}`);
    } catch (err) { state.buyOrderId = null; }
  }

  // Same for sell
  if (state.sellOrderId && Math.abs(state.sellOrderPrice - idealSell) > tick * 2) {
    try {
      await luno.cancelOrder(state.sellOrderId);
      state.sellOrderId = null;
      log(`Refreshing sell order — was ₦${state.sellOrderPrice}, ideal is ₦${idealSell}`);
    } catch (err) { state.sellOrderId = null; }
  }
}

// === MAIN LOOP ===

async function mainLoop() {
  await telegram.startup();
  log('🚀 Bot starting...');
  log(`Primary pair: ${config.PRIMARY_PAIR} | Secondary: ${config.SECONDARY_PAIR}`);

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

      // === UPDATE BALANCES (every few cycles) ===
      if (state.dailyRotations % 3 === 0 || !state.buyOrderId || !state.sellOrderId) {
        await updateBalances();
      }

      // === REFRESH ORDERS TO STAY ON TOP ===
      await refreshOrders(spread);

      // === PLACE NEW ORDERS IF NEEDED ===
      await placeOrders(spread);

      // === LOG STATUS ===
      log(
        `${state.state} | ${state.activePair} | ` +
        `Spread: ₦${spread.spreadNgn.toFixed(4)} (${spread.spreadPct.toFixed(3)}%) | ` +
        `Inv: ${(state.getInventoryRatio() * 100).toFixed(0)}% crypto | ` +
        `P&L: ₦${state.dailyPnl.toFixed(2)} | ` +
        `Rot: ${state.dailyRotations}`
      );

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
