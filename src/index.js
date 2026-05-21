// src/index.js — V2 Market Maker Engine (Websocket) — FIXED
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

// === CHECK FILLS ===
async function checkFills() {
  if (state.buyOrderId && state.buyOrderId !== 'COOLDOWN') {
    try {
      const order = await rest.getOrder(state.buyOrderId);
      if (order.state === 'COMPLETE') {
        state.lastBuyFillPrice = state.buyOrderPrice;
        log(`✅ BUY FILLED @ ₦${state.buyOrderPrice}`);
        state.buyOrderId = null;
        // Immediately update balances so sell side knows we have USDT
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
        // Immediately update balances so buy side knows we have NGN
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

// === TRADING LOGIC — throttled, runs max every 500ms ===
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

    // === BLOCK TRADING IF SPREAD IS NEGATIVE OR ZERO ===
    if (book.spread <= 0) {
      // Inverted book — cancel everything and wait
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
      // Never sell below cost + margin, no matter what
      if (sellPrice < minSellPrice) {
        sellPrice = minSellPrice;
      }
    }

    // === SAFETY: sell must be above buy ===
    if (sellPrice <= buyPrice) {
      // Don't trade — spread is too tight for profit
      return;
    }

    // Round to 2 decimals
    buyPrice = Math.floor(buyPrice * 100) / 100;
    sellPrice = Math.ceil(sellPrice * 100) / 100;

    // === CAPITAL UTILIZATION — use MORE capital ===
    // Base: 48% of available balance per side
    // When spread is wider, go up to 70%
    const spreadRatio = Math.min(book.spread / config.SPREAD_SCALE, 1.0);
    const capPct = Math.max(0.35, 0.70 * spreadRatio); // minimum 35%, max 70%

    let buyVol = Math.floor((state.ngnBalance * capPct / buyPrice) * 100) / 100;
    let sellVol = Math.floor(state.usdtBalance * capPct * 100) / 100;
    buyVol = Math.min(Math.max(buyVol, 0), config.MAX_ORDER_USDT);
    sellVol = Math.min(Math.max(sellVol, 0), config.MAX_ORDER_USDT);

    // === REBALANCE when heavy on one side ===
    const totalNgn = state.ngnBalance + (state.usdtBalance * book.midPrice);
    const invRatio = totalNgn > 0 ? (state.usdtBalance * book.midPrice) / totalNgn : 0.5;

    if (invRatio > config.REBALANCE_THRESHOLD) {
      // Heavy on USDT — sell MORE
      sellVol = Math.floor(state.usdtBalance * 0.80 * 100) / 100;
      sellVol = Math.min(sellVol, config.MAX_ORDER_USDT);
    } else if (invRatio < (1 - config.REBALANCE_THRESHOLD)) {
      // Heavy on NGN — buy MORE
      buyVol = Math.floor((state.ngnBalance * 0.80 / buyPrice) * 100) / 100;
      buyVol = Math.min(buyVol, config.MAX_ORDER_USDT);
    }

    // === REFRESH: cancel if not on top ===
    if (state.buyOrderId && state.buyOrderId !== 'COOLDOWN') {
      if (state.buyOrderPrice < buyPrice - 0.005) {
        try { await rest.cancelOrder(state.buyOrderId); } catch(e) {}
        state.buyOrderId = null;
      }
    }

    if (state.sellOrderId && state.sellOrderId !== 'COOLDOWN') {
      if (state.sellOrderPrice > sellPrice + 0.005) {
        // Only refresh if still profitable
        const minSell = state.lastBuyFillPrice > 0 ? state.lastBuyFillPrice + config.SMART_SELL_MARGIN : 0;
        if (sellPrice >= minSell) {
          try { await rest.cancelOrder(state.sellOrderId); } catch(e) {}
          state.sellOrderId = null;
        }
      }
    }

    // === PLACE BOTH SIDES — always try to have both on book ===
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

// === THE BRAIN — called on EVERY websocket update ===
async function onBookUpdate(book, trades) {
  if (!isRunning) return;
  lastBook = book;

  // Track competitor (instant)
  competitor.update(book);

  // Quick fill check from trade updates
  for (const t of trades) {
    if (state.buyOrderId && (t.makerOrderId === state.buyOrderId || t.takerOrderId === state.buyOrderId)) {
      await checkFills();
    }
    if (state.sellOrderId && (t.makerOrderId === state.sellOrderId || t.takerOrderId === state.sellOrderId)) {
      await checkFills();
    }
  }

  // Execute trading logic (throttled)
  await executeTrading(book);

  // Log (every 10 seconds)
  const now = Date.now();
  if (now - state._lastLogTime > 10000) {
    state._lastLogTime = now;
    const totalNgn = state.ngnBalance + (state.usdtBalance * book.midPrice);
    const invRatio = totalNgn > 0 ? (state.usdtBalance * book.midPrice) / totalNgn : 0.5;
    const comp = competitor.getStats();
    log(
      `${config.PRIMARY_PAIR} | Spread: ₦${book.spread.toFixed(2)} | ` +
      `Inv: ${(invRatio * 100).toFixed(0)}% | ` +
      `P&L: ₦${state.dailyPnl.toFixed(2)} | Rot: ${state.dailyRotations} | ` +
      `Buy: ${state.buyOrderId ? '✅' : '❌'} Sell: ${state.sellOrderId ? '✅' : '❌'} | ` +
      `NGN: ₦${state.ngnBalance.toFixed(0)} USDT: ${state.usdtBalance.toFixed(1)} | ` +
      `Floor: ₦${comp.askFloor} Ceil: ₦${comp.bidCeiling}`
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
  log('🚀 V2 Bot starting — Websocket mode');

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
      version: 'v2-websocket',
      spread: lastBook ? lastBook.spread.toFixed(2) : 'N/A',
      pnl: state.dailyPnl.toFixed(2),
      rotations: state.dailyRotations,
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
