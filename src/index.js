// src/index.js — V2 Market Maker Engine (Websocket) — WITH TRAILING STOP
const { LunoStream } = require('./stream');
const { CompetitorTracker } = require('./competitor');
const rest = require('./rest');
const telegram = require('./telegram');
const config = require('./config');
const http = require('http');

// === STATE ===
const state = {
  ngnBalance: 0,
  usdtBalance: 0,
  btcBalance: 0,
  buyOrderId: null,
  sellOrderId: null,
  buyOrderPrice: 0,
  sellOrderPrice: 0,
  buyOrderVolume: 0,
  sellOrderVolume: 0,
  lastBuyFillPrice: 0,
  lastBuyFillTime: 0,
  lastSellFillPrice: 0,
  dailyPnl: 0,
  dailyRotations: 0,
  startingCapital: 0,
  _buyFails: 0,
  _sellFails: 0,
  _buyCooldownUntil: 0,
  _sellCooldownUntil: 0,
  _lastBalanceCheck: 0,
  _lastLogTime: 0,
  _lastTradeAction: 0,
  _actionLock: false,
  // Trailing stop
  _priceHistory: [],        // { time, midPrice }
  _stopLossTriggered: false,
};

// Trailing stop config
const STOP_LOSS = {
  MAX_LOSS_PER_USDT: 1.00,       // absolute max loss — sell if price drops ₦1.00 below cost
  FAST_DUMP_DROP: 0.50,           // ₦0.50 drop
  FAST_DUMP_WINDOW_MS: 300000,    // in 5 minutes = fast dump, sell immediately
  PRICE_HISTORY_MS: 600000,       // track last 10 minutes of prices
};

const competitor = new CompetitorTracker();
let lastBook = null;
let isRunning = true;

function log(msg) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] ${msg}`);
}

// === BALANCE ===
async function updateBalances() {
  try {
    const res = await rest.getBalances();
    for (const acc of (res.balance || [])) {
      const cur = acc.asset || acc.currency || '';
      const avail = parseFloat(acc.balance || 0) - parseFloat(acc.reserved || 0);
      if (cur === 'NGN') state.ngnBalance = avail;
      if (cur === 'USDT') state.usdtBalance = avail;
      if (cur === 'XBT') state.btcBalance = avail;
    }
  } catch (err) {}
}

// === TRAILING STOP — should we cut our loss? ===
function checkTrailingStop(currentMid) {
  const now = Date.now();

  // Track price history
  state._priceHistory.push({ time: now, price: currentMid });
  // Trim old entries
  state._priceHistory = state._priceHistory.filter(p => now - p.time < STOP_LOSS.PRICE_HISTORY_MS);

  // Only check if we have a buy position to protect
  if (state.lastBuyFillPrice <= 0 || state.usdtBalance < 5) return false;

  const costBasis = state.lastBuyFillPrice;
  const currentLoss = costBasis - currentMid;

  // Check 1: absolute max loss
  if (currentLoss >= STOP_LOSS.MAX_LOSS_PER_USDT) {
    log(`🛑 STOP LOSS: price ₦${currentMid.toFixed(2)} is ₦${currentLoss.toFixed(2)} below cost ₦${costBasis.toFixed(2)} — MAX LOSS HIT`);
    return true;
  }

  // Check 2: fast dump detection
  const fiveMinAgo = state._priceHistory.find(p => now - p.time >= STOP_LOSS.FAST_DUMP_WINDOW_MS - 10000);
  if (fiveMinAgo) {
    const recentDrop = fiveMinAgo.price - currentMid;
    if (recentDrop >= STOP_LOSS.FAST_DUMP_DROP && currentLoss > 0) {
      log(`🛑 STOP LOSS: fast dump detected — dropped ₦${recentDrop.toFixed(2)} in 5min, cost ₦${costBasis.toFixed(2)}, now ₦${currentMid.toFixed(2)}`);
      return true;
    }
  }

  return false;
}

// === EMERGENCY SELL — sell USDT at best ask to cut loss ===
async function emergencySell(book) {
  if (state.usdtBalance < 5) return;

  // Cancel any existing sell order
  if (state.sellOrderId && state.sellOrderId !== 'COOLDOWN') {
    try { await rest.cancelOrder(state.sellOrderId); } catch(e) {}
    state.sellOrderId = null;
  }
  // Cancel buy order too — don't buy more during a dump
  if (state.buyOrderId && state.buyOrderId !== 'COOLDOWN') {
    try { await rest.cancelOrder(state.buyOrderId); } catch(e) {}
    state.buyOrderId = null;
  }

  const sellVol = Math.floor(state.usdtBalance * 0.95 * 100) / 100;
  const sellPrice = Math.floor(book.bestBid * 100) / 100; // sell at best bid for instant fill

  if (sellVol >= 5) {
    try {
      const res = await rest.createOrder('USDTNGN', 'ASK', sellVol, sellPrice, false); // NOT post-only
      log(`🚨 EMERGENCY SELL ${sellVol} @ ₦${sellPrice} — cutting loss`);
      state.sellOrderId = null;
      state.lastBuyFillPrice = 0; // reset cost basis
      state._stopLossTriggered = true;
      // Cooldown 60 seconds after stop loss before resuming
      state._buyCooldownUntil = Date.now() + 60000;
      state._sellCooldownUntil = Date.now() + 60000;
      await updateBalances();
    } catch (err) {
      log(`Emergency sell failed: ${err.message}`);
    }
  }
}

// === CHECK FILLS ===
async function checkFills() {
  if (state.buyOrderId && state.buyOrderId !== 'COOLDOWN') {
    try {
      const order = await rest.getOrder(state.buyOrderId);
      if (order.state === 'COMPLETE') {
        state.lastBuyFillPrice = state.buyOrderPrice;
        state.lastBuyFillTime = Date.now();
        state._stopLossTriggered = false; // reset stop loss for new position
        log(`✅ BUY FILLED @ ₦${state.buyOrderPrice}`);
        state.buyOrderId = null;
        await updateBalances();
      } else if (order.state === 'CANCELLED' || order.state === 'EXPIRED') {
        state.buyOrderId = null;
      }
    } catch (e) { state.buyOrderId = null; }
  }

  if (state.sellOrderId && state.sellOrderId !== 'COOLDOWN') {
    try {
      const order = await rest.getOrder(state.sellOrderId);
      if (order.state === 'COMPLETE') {
        state.lastSellFillPrice = state.sellOrderPrice;
        log(`✅ SELL FILLED @ ₦${state.sellOrderPrice}`);

        if (state.lastBuyFillPrice > 0) {
          const profit = (state.lastSellFillPrice - state.lastBuyFillPrice) * state.sellOrderVolume;
          state.dailyPnl += profit;
          state.dailyRotations++;
          log(`🔄 ROTATION #${state.dailyRotations} | Profit: ₦${profit.toFixed(2)} | Total: ₦${state.dailyPnl.toFixed(2)}`);
        }
        state.sellOrderId = null;
        state.lastBuyFillPrice = 0; // reset — this rotation is done
        await updateBalances();
      } else if (order.state === 'CANCELLED' || order.state === 'EXPIRED') {
        state.sellOrderId = null;
      }
    } catch (e) { state.sellOrderId = null; }
  }
}

// === CANCEL ALL ===
async function cancelAll() {
  if (state.buyOrderId && state.buyOrderId !== 'COOLDOWN') {
    try { await rest.cancelOrder(state.buyOrderId); } catch(e) {}
    state.buyOrderId = null;
  }
  if (state.sellOrderId && state.sellOrderId !== 'COOLDOWN') {
    try { await rest.cancelOrder(state.sellOrderId); } catch(e) {}
    state.sellOrderId = null;
  }
}

// === CANCEL LEFTOVER ORDERS ON STARTUP ===
async function cancelLeftovers() {
  try {
    const orders = await rest.listOrders('USDTNGN', 'PENDING');
    if (orders.orders) {
      for (const o of orders.orders) {
        await rest.cancelOrder(o.order_id);
        log(`Cancelled leftover: ${o.order_id}`);
      }
    }
  } catch(e) {}
}

// === PLACE ORDER WITH COOLDOWN ===
async function placeBuy(pair, volume, price) {
  if (state.buyOrderId) return;
  if (Date.now() < state._buyCooldownUntil) return;

  try {
    const res = await rest.createOrder(pair, 'BID', volume, price, true);
    state.buyOrderId = res.order_id;
    state.buyOrderPrice = price;
    state.buyOrderVolume = volume;
    state._buyFails = 0;
    log(`📗 BUY ${volume} @ ₦${price}`);
  } catch (err) {
    if (err.message.includes('ErrOrderCanceled')) {
      state._buyFails++;
      if (state._buyFails >= config.POST_ONLY_FAIL_LIMIT) {
        state._buyCooldownUntil = Date.now() + config.POST_ONLY_COOLDOWN_MS;
        state._buyFails = 0;
      }
    }
  }
}

async function placeSell(pair, volume, price) {
  if (state.sellOrderId) return;
  if (Date.now() < state._sellCooldownUntil) return;

  try {
    const res = await rest.createOrder(pair, 'ASK', volume, price, true);
    state.sellOrderId = res.order_id;
    state.sellOrderPrice = price;
    state.sellOrderVolume = volume;
    state._sellFails = 0;
    log(`📕 SELL ${volume} @ ₦${price}`);
  } catch (err) {
    if (err.message.includes('ErrOrderCanceled')) {
      state._sellFails++;
      if (state._sellFails >= config.POST_ONLY_FAIL_LIMIT) {
        state._sellCooldownUntil = Date.now() + config.POST_ONLY_COOLDOWN_MS;
        state._sellFails = 0;
      }
    }
  }
}

// === TRADING LOGIC — throttled ===
async function executeTrading(book) {
  const now = Date.now();

  if (now - state._lastTradeAction < 500) return;
  if (state._actionLock) return;

  state._actionLock = true;
  state._lastTradeAction = now;

  try {
    // Balance check (every 5 seconds)
    if (now - state._lastBalanceCheck > config.BALANCE_CHECK_MS) {
      await updateBalances();
      state._lastBalanceCheck = now;
      await checkFills();
    }

    // === TRAILING STOP CHECK ===
    if (checkTrailingStop(book.midPrice)) {
      await emergencySell(book);
      return;
    }

    // === BLOCK TRADING IF SPREAD IS NEGATIVE OR ZERO ===
    if (book.spread <= 0) {
      if (state.buyOrderId && state.buyOrderId !== 'COOLDOWN') {
        try { await rest.cancelOrder(state.buyOrderId); } catch(e) {}
        state.buyOrderId = null;
      }
      return;
    }

    // === CALCULATE PRICES ===
    const tick = config.PRICE_TICK;
    let buyPrice, sellPrice;

    if (book.spread < tick * 3) {
      buyPrice = book.bestBid;
      sellPrice = book.bestAsk;
    } else {
      buyPrice = Math.floor((book.bestBid + tick) * 100) / 100;
      sellPrice = Math.ceil((book.bestAsk - tick) * 100) / 100;
    }

    // === SMART SELL — never sell below cost ===
    if (state.lastBuyFillPrice > 0) {
      const minSellPrice = Math.ceil((state.lastBuyFillPrice + config.SMART_SELL_MARGIN) * 100) / 100;
      if (sellPrice < minSellPrice) {
        sellPrice = minSellPrice;
      }
    }

    // === SAFETY ===
    if (sellPrice <= buyPrice) return;

    buyPrice = Math.floor(buyPrice * 100) / 100;
    sellPrice = Math.ceil(sellPrice * 100) / 100;

    // === CAPITAL UTILIZATION — 35% to 70% ===
    const spreadRatio = Math.min(book.spread / config.SPREAD_SCALE, 1.0);
    const capPct = Math.max(0.35, 0.70 * spreadRatio);

    let buyVol = Math.floor((state.ngnBalance * capPct / buyPrice) * 100) / 100;
    let sellVol = Math.floor(state.usdtBalance * capPct * 100) / 100;
    buyVol = Math.min(Math.max(buyVol, 0), config.MAX_ORDER_USDT);
    sellVol = Math.min(Math.max(sellVol, 0), config.MAX_ORDER_USDT);

    // === REBALANCE ===
    const totalNgn = state.ngnBalance + (state.usdtBalance * book.midPrice);
    const invRatio = totalNgn > 0 ? (state.usdtBalance * book.midPrice) / totalNgn : 0.5;

    if (invRatio > config.REBALANCE_THRESHOLD) {
      sellVol = Math.floor(state.usdtBalance * 0.80 * 100) / 100;
      sellVol = Math.min(sellVol, config.MAX_ORDER_USDT);
    } else if (invRatio < (1 - config.REBALANCE_THRESHOLD)) {
      buyVol = Math.floor((state.ngnBalance * 0.80 / buyPrice) * 100) / 100;
      buyVol = Math.min(buyVol, config.MAX_ORDER_USDT);
    }

    // === REFRESH ===
    if (state.buyOrderId && state.buyOrderId !== 'COOLDOWN') {
      if (state.buyOrderPrice < buyPrice - 0.005) {
        try { await rest.cancelOrder(state.buyOrderId); } catch(e) {}
        state.buyOrderId = null;
      }
    }

    if (state.sellOrderId && state.sellOrderId !== 'COOLDOWN') {
      if (state.sellOrderPrice > sellPrice + 0.005) {
        const minSell = state.lastBuyFillPrice > 0 ? state.lastBuyFillPrice + config.SMART_SELL_MARGIN : 0;
        if (sellPrice >= minSell) {
          try { await rest.cancelOrder(state.sellOrderId); } catch(e) {}
          state.sellOrderId = null;
        }
      }
    }

    // === PLACE ORDERS ===
    if (buyVol >= config.MIN_ORDER_USDT) {
      await placeBuy('USDTNGN', buyVol, buyPrice);
    }
    if (sellVol >= config.MIN_ORDER_USDT) {
      await placeSell('USDTNGN', sellVol, sellPrice);
    }

  } finally {
    state._actionLock = false;
  }
}

// === THE BRAIN ===
async function onBookUpdate(book, trades) {
  if (!isRunning) return;
  lastBook = book;

  competitor.update(book);

  for (const t of trades) {
    if (state.buyOrderId && (t.makerOrderId === state.buyOrderId || t.takerOrderId === state.buyOrderId)) {
      await checkFills();
    }
    if (state.sellOrderId && (t.makerOrderId === state.sellOrderId || t.takerOrderId === state.sellOrderId)) {
      await checkFills();
    }
  }

  await executeTrading(book);

  // Log
  const now = Date.now();
  if (now - state._lastLogTime > 10000) {
    state._lastLogTime = now;
    const totalNgn = state.ngnBalance + (state.usdtBalance * book.midPrice);
    const invRatio = totalNgn > 0 ? (state.usdtBalance * book.midPrice) / totalNgn : 0.5;
    const comp = competitor.getStats();
    const costInfo = state.lastBuyFillPrice > 0 ? ` Cost: ₦${state.lastBuyFillPrice.toFixed(2)}` : '';
    log(
      `${config.PRIMARY_PAIR} | Spread: ₦${book.spread.toFixed(2)} | ` +
      `Inv: ${(invRatio * 100).toFixed(0)}% | ` +
      `P&L: ₦${state.dailyPnl.toFixed(2)} | Rot: ${state.dailyRotations} | ` +
      `Buy: ${state.buyOrderId ? '✅' : '❌'} Sell: ${state.sellOrderId ? '✅' : '❌'} | ` +
      `NGN: ₦${state.ngnBalance.toFixed(0)} USDT: ${state.usdtBalance.toFixed(1)}${costInfo}`
    );
  }
}

// === MAIN ===
async function main() {
  if (!config.LUNO_API_KEY || !config.LUNO_API_SECRET) {
    console.error('❌ Missing LUNO_API_KEY_ID or LUNO_API_SECRET');
    process.exit(1);
  }

  await telegram.startup();
  log('🚀 V2 Bot starting — Websocket + Trailing Stop');

  log('Cancelling leftover orders...');
  await cancelLeftovers();
  await new Promise(r => setTimeout(r, 2000));

  await updateBalances();
  state.startingCapital = state.ngnBalance + (state.usdtBalance * 1387);
  log(`Capital: ₦${state.startingCapital.toFixed(0)} | NGN: ₦${state.ngnBalance.toFixed(2)} | USDT: ${state.usdtBalance.toFixed(2)}`);

  const stream = new LunoStream(config.PRIMARY_PAIR, onBookUpdate);
  stream.connect();

  const PORT = process.env.PORT || 3000;
  http.createServer((req, res) => {
    res.writeHead(200);
    res.end(JSON.stringify({
      status: 'running',
      version: 'v2-trailing-stop',
      spread: lastBook ? lastBook.spread.toFixed(2) : 'N/A',
      pnl: state.dailyPnl.toFixed(2),
      rotations: state.dailyRotations,
      costBasis: state.lastBuyFillPrice,
      competitor: competitor.getStats(),
    }));
  }).listen(PORT, () => log(`Health check on port ${PORT}`));
}

async function shutdown(signal) {
  log(`${signal} — shutting down...`);
  isRunning = false;
  await cancelAll();
  await telegram.shutdown(signal);
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
