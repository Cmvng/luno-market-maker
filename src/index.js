// src/index.js — V2.3 — All issues fixed
const { LunoStream } = require('./stream');
const { CompetitorTracker } = require('./competitor');
const rest = require('./rest');
const telegram = require('./telegram');
const config = require('./config');
const http = require('http');

const STOP = {
  MAX_LOSS: 0.50,
  FAST_DROP: 0.30,
  FAST_WINDOW: 300000,
  HISTORY: 600000,
  STALE_MS: 600000,
  STALE_GAP: 0.20,
};

const state = {
  ngnBalance: 0, usdtBalance: 0, btcBalance: 0,
  buyOrderId: null, sellOrderId: null,
  buyOrderPrice: 0, sellOrderPrice: 0,
  buyOrderVolume: 0, sellOrderVolume: 0,
  lastBuyFillPrice: 0, lastBuyFillTime: 0,
  lastSellFillPrice: 0,
  dailyPnl: 0, dailyRotations: 0, startingCapital: 0,
  _buyFails: 0, _sellFails: 0,
  _buyCooldown: 0, _sellCooldown: 0,
  _lastBal: 0, _lastLog: 0, _lastAct: 0, _lock: false,
  _prices: [],
  _lastSellRefresh: 0,  // throttle sell refreshes separately
  _lastBuyRefresh: 0,   // throttle buy refreshes separately
};

const competitor = new CompetitorTracker();
let lastBook = null;
let isRunning = true;

function log(m) { console.log(`[${new Date().toISOString().slice(11,19)}] ${m}`); }

// === BALANCE ===
async function updateBalances() {
  try {
    const r = await rest.getBalances();
    for (const a of (r.balance||[])) {
      const c = a.asset||a.currency||'';
      const v = parseFloat(a.balance||0) - parseFloat(a.reserved||0);
      if (c==='NGN') state.ngnBalance=v;
      if (c==='USDT') state.usdtBalance=v;
      if (c==='XBT') state.btcBalance=v;
    }
  } catch(e) {}
}

// === CHECK FILLS ===
async function checkFills() {
  if (state.buyOrderId && state.buyOrderId !== 'COOLDOWN') {
    try {
      const o = await rest.getOrder(state.buyOrderId);
      if (o.state==='COMPLETE') {
        state.lastBuyFillPrice = state.buyOrderPrice;
        state.lastBuyFillTime = Date.now();
        log(`✅ BUY FILLED @ ₦${state.buyOrderPrice}`);
        state.buyOrderId = null;
        await updateBalances();
      } else if (o.state==='CANCELLED'||o.state==='EXPIRED') { state.buyOrderId=null; }
    } catch(e) { state.buyOrderId=null; }
  }
  if (state.sellOrderId && state.sellOrderId !== 'COOLDOWN') {
    try {
      const o = await rest.getOrder(state.sellOrderId);
      if (o.state==='COMPLETE') {
        state.lastSellFillPrice = state.sellOrderPrice;
        log(`✅ SELL FILLED @ ₦${state.sellOrderPrice}`);
        if (state.lastBuyFillPrice > 0) {
          const profit = (state.lastSellFillPrice - state.lastBuyFillPrice) * state.sellOrderVolume;
          state.dailyPnl += profit;
          state.dailyRotations++;
          log(`🔄 ROT #${state.dailyRotations} | P: ₦${profit.toFixed(2)} | Total: ₦${state.dailyPnl.toFixed(2)}`);
        }
        state.sellOrderId = null;
        state.lastBuyFillPrice = 0;
        await updateBalances();
      } else if (o.state==='CANCELLED'||o.state==='EXPIRED') { state.sellOrderId=null; }
    } catch(e) { state.sellOrderId=null; }
  }
}

// === CANCEL ===
async function cancelAll() {
  if (state.buyOrderId&&state.buyOrderId!=='COOLDOWN') { try{await rest.cancelOrder(state.buyOrderId)}catch(e){} state.buyOrderId=null; }
  if (state.sellOrderId&&state.sellOrderId!=='COOLDOWN') { try{await rest.cancelOrder(state.sellOrderId)}catch(e){} state.sellOrderId=null; }
}

async function cancelLeftovers() {
  try { const o=await rest.listOrders('USDTNGN','PENDING'); if(o.orders) for(const x of o.orders) { await rest.cancelOrder(x.order_id); log(`Cancelled: ${x.order_id}`); } } catch(e){}
  try { const o=await rest.listOrders('XBTNGN','PENDING'); if(o.orders) for(const x of o.orders) { await rest.cancelOrder(x.order_id); log(`Cancelled: ${x.order_id}`); } } catch(e){}
}

// === TRAILING STOP ===
function checkStop(mid) {
  const now = Date.now();
  state._prices.push({t:now, p:mid});
  state._prices = state._prices.filter(x => now-x.t < STOP.HISTORY);
  if (state.lastBuyFillPrice <= 0 || state.usdtBalance < 5) return false;
  const loss = state.lastBuyFillPrice - mid;
  if (loss >= STOP.MAX_LOSS) { log(`🛑 MAX LOSS: cost ₦${state.lastBuyFillPrice.toFixed(2)} now ₦${mid.toFixed(2)}`); return true; }
  const old = state._prices.find(x => now-x.t >= STOP.FAST_WINDOW-10000);
  if (old && old.p - mid >= STOP.FAST_DROP && loss > 0) { log(`🛑 FAST DUMP: dropped ₦${(old.p-mid).toFixed(2)} in 5min`); return true; }
  return false;
}

async function emergencySell(book) {
  if (state.usdtBalance < 5) return;
  await cancelAll();
  const vol = Math.floor(state.usdtBalance * 0.95 * 100) / 100;
  const price = Math.floor(book.bestBid * 100) / 100;
  if (vol >= 5) {
    try {
      await rest.createOrder('USDTNGN','ASK',vol,price,false);
      log(`🚨 EMERGENCY SELL ${vol} @ ₦${price}`);
      state.lastBuyFillPrice = 0;
      state._buyCooldown = Date.now() + 60000;
      state._sellCooldown = Date.now() + 60000;
      await updateBalances();
    } catch(e) { log(`Emergency failed: ${e.message}`); }
  }
}

// === PLACE ORDERS ===
async function placeBuy(pair, vol, price) {
  if (state.buyOrderId || Date.now() < state._buyCooldown) return;
  try {
    const r = await rest.createOrder(pair,'BID',vol,price,true);
    state.buyOrderId=r.order_id; state.buyOrderPrice=price; state.buyOrderVolume=vol; state._buyFails=0;
    log(`📗 BUY ${vol} @ ₦${price}`);
  } catch(e) {
    if (e.message.includes('ErrOrderCanceled')) { state._buyFails++; if(state._buyFails>=5){state._buyCooldown=Date.now()+5000;state._buyFails=0;} }
  }
}

async function placeSell(pair, vol, price) {
  if (state.sellOrderId || Date.now() < state._sellCooldown) return;
  try {
    const r = await rest.createOrder(pair,'ASK',vol,price,true);
    state.sellOrderId=r.order_id; state.sellOrderPrice=price; state.sellOrderVolume=vol; state._sellFails=0;
    log(`📕 SELL ${vol} @ ₦${price}`);
  } catch(e) {
    if (e.message.includes('ErrOrderCanceled')) { state._sellFails++; if(state._sellFails>=5){state._sellCooldown=Date.now()+5000;state._sellFails=0;} }
  }
}

// === MAIN TRADING LOGIC ===
async function executeTrade(book) {
  const now = Date.now();
  if (now - state._lastAct < 500 || state._lock) return;
  state._lock = true; state._lastAct = now;

  try {
    // Balance + fills check every 5 seconds
    if (now - state._lastBal > config.BALANCE_CHECK_MS) {
      await updateBalances(); state._lastBal = now; await checkFills();
    }

    // === STALE ORDER DETECTION ===
    if (state.sellOrderId && state.sellOrderId !== 'COOLDOWN' && state.lastBuyFillTime > 0) {
      const age = now - state.lastBuyFillTime;
      const gap = state.sellOrderPrice - book.bestAsk;
      if (age > STOP.STALE_MS && gap > STOP.STALE_GAP) {
        log(`⏰ Stale sell @ ₦${state.sellOrderPrice} — market ₦${book.bestAsk.toFixed(2)}. Cancelling.`);
        try { await rest.cancelOrder(state.sellOrderId); } catch(e) {}
        state.sellOrderId = null;
        state.lastBuyFillPrice = 0;
      }
    }
    if (state.buyOrderId && state.buyOrderId !== 'COOLDOWN') {
      if (book.bestBid - state.buyOrderPrice > 0.50) {
        log(`⏰ Stale buy @ ₦${state.buyOrderPrice} — market ₦${book.bestBid.toFixed(2)}. Cancelling.`);
        try { await rest.cancelOrder(state.buyOrderId); } catch(e) {}
        state.buyOrderId = null;
      }
    }

    // === TRAILING STOP ===
    if (checkStop(book.midPrice)) { await emergencySell(book); return; }

    // === NEGATIVE SPREAD — stop all trading ===
    if (book.spread <= 0) {
      if (state.buyOrderId && state.buyOrderId !== 'COOLDOWN') {
        try { await rest.cancelOrder(state.buyOrderId); } catch(e) {}
        state.buyOrderId = null;
      }
      return;
    }

    // === CALCULATE PRICES ===
    const tick = config.PRICE_TICK;
    let bp, sp;
    if (book.spread < tick * 3) {
      bp = book.bestBid;
      sp = book.bestAsk;
    } else {
      bp = Math.floor((book.bestBid + tick) * 100) / 100;
      sp = Math.ceil((book.bestAsk - tick) * 100) / 100;
    }

    // Smart sell — never below cost + ₦0.01
    if (state.lastBuyFillPrice > 0) {
      const minSell = Math.ceil((state.lastBuyFillPrice + config.SMART_SELL_MARGIN) * 100) / 100;
      if (sp < minSell) sp = minSell;
    }

    // Safety: sell must be above buy
    if (sp <= bp) return;
    bp = Math.floor(bp * 100) / 100;
    sp = Math.ceil(sp * 100) / 100;

    // === INVENTORY ===
    const tot = state.ngnBalance + state.usdtBalance * book.midPrice;
    const inv = tot > 0 ? (state.usdtBalance * book.midPrice) / tot : 0.5;

    // === ORDER SIZING ===
    //
    // RULE 1: Sell side scales up when heavy on USDT (up to 90%)
    // RULE 2: Buy side NEVER exceeds 50% — prevents buying back what we just sold
    // RULE 3: When >80% USDT, completely stop buying
    // RULE 4: When >70% USDT, buy only 15% (small buys to stay on book)
    //
    let bv = 0;
    let sv = 0;

    if (inv > 0.80) {
      // VERY HEAVY USDT — sell everything, don't buy
      sv = Math.floor(state.usdtBalance * 0.90 * 100) / 100;
      bv = 0;
    } else if (inv > 0.70) {
      // HEAVY USDT — big sell, tiny buy
      sv = Math.floor(state.usdtBalance * 0.80 * 100) / 100;
      bv = Math.floor((state.ngnBalance * 0.15 / bp) * 100) / 100;
    } else if (inv > 0.55) {
      // SLIGHTLY HEAVY USDT — sell more, buy less
      sv = Math.floor(state.usdtBalance * 0.60 * 100) / 100;
      bv = Math.floor((state.ngnBalance * 0.30 / bp) * 100) / 100;
    } else if (inv > 0.45) {
      // BALANCED — equal both sides
      sv = Math.floor(state.usdtBalance * 0.45 * 100) / 100;
      bv = Math.floor((state.ngnBalance * 0.45 / bp) * 100) / 100;
    } else if (inv > 0.30) {
      // SLIGHTLY HEAVY NGN — buy more, sell less
      sv = Math.floor(state.usdtBalance * 0.30 * 100) / 100;
      bv = Math.floor((state.ngnBalance * 0.50 / bp) * 100) / 100;
    } else {
      // VERY HEAVY NGN — big buy, small sell
      sv = Math.floor(state.usdtBalance * 0.15 * 100) / 100;
      bv = Math.floor((state.ngnBalance * 0.50 / bp) * 100) / 100;
    }

    bv = Math.min(Math.max(bv, 0), config.MAX_ORDER_USDT);
    sv = Math.min(Math.max(sv, 0), config.MAX_ORDER_USDT);

    // === REFRESH LOGIC ===
    //
    // Buy side: refresh every 3 seconds if outbid
    // Sell side: refresh every 10 seconds if outbid (prevents chase-down)
    //   — when heavy on USDT, refresh every 30 seconds (place and wait)
    //
    const sellRefreshInterval = inv > 0.70 ? 30000 : 10000;
    const buyRefreshInterval = 3000;

    if (state.buyOrderId && state.buyOrderId !== 'COOLDOWN') {
      if (state.buyOrderPrice < bp - 0.005 && now - state._lastBuyRefresh > buyRefreshInterval) {
        try { await rest.cancelOrder(state.buyOrderId); } catch(e) {}
        state.buyOrderId = null;
        state._lastBuyRefresh = now;
      }
    }

    if (state.sellOrderId && state.sellOrderId !== 'COOLDOWN') {
      if (state.sellOrderPrice > sp + 0.005 && now - state._lastSellRefresh > sellRefreshInterval) {
        // Only refresh if new price is still above cost
        const ok = !state.lastBuyFillPrice || sp > state.lastBuyFillPrice + config.SMART_SELL_MARGIN - 0.005;
        if (ok) {
          try { await rest.cancelOrder(state.sellOrderId); } catch(e) {}
          state.sellOrderId = null;
          state._lastSellRefresh = now;
        }
      }
    }

    // === PLACE ORDERS ===
    if (bv >= config.MIN_ORDER_USDT) await placeBuy('USDTNGN', bv, bp);
    if (sv >= config.MIN_ORDER_USDT) await placeSell('USDTNGN', sv, sp);

  } finally { state._lock = false; }
}

// === WEBSOCKET HANDLER ===
async function onBookUpdate(book, trades) {
  if (!isRunning) return;
  lastBook = book;
  competitor.update(book);

  // Check fills from trade stream
  for (const t of trades) {
    if (state.buyOrderId && (t.makerOrderId===state.buyOrderId || t.takerOrderId===state.buyOrderId)) await checkFills();
    if (state.sellOrderId && (t.makerOrderId===state.sellOrderId || t.takerOrderId===state.sellOrderId)) await checkFills();
  }

  await executeTrade(book);

  // Log every 10 seconds
  const now = Date.now();
  if (now - state._lastLog > 10000) {
    state._lastLog = now;
    const tot = state.ngnBalance + state.usdtBalance * (book.midPrice || 1385);
    const inv = tot > 0 ? (state.usdtBalance * (book.midPrice || 1385)) / tot : 0.5;
    const cost = state.lastBuyFillPrice > 0 ? ` Cost:₦${state.lastBuyFillPrice.toFixed(2)}` : '';
    log(
      `Spread:₦${book.spread.toFixed(2)} Inv:${(inv*100).toFixed(0)}% ` +
      `P&L:₦${state.dailyPnl.toFixed(2)} Rot:${state.dailyRotations} ` +
      `B:${state.buyOrderId?'✅':'❌'} S:${state.sellOrderId?'✅':'❌'} ` +
      `NGN:₦${state.ngnBalance.toFixed(0)} USDT:${state.usdtBalance.toFixed(1)}${cost}`
    );
  }
}

// === MAIN ===
async function main() {
  if (!config.LUNO_API_KEY || !config.LUNO_API_SECRET) {
    console.error('❌ Missing API keys');
    process.exit(1);
  }

  await telegram.startup();
  log('🚀 V2.3 — Fixed sizing + sell throttle');
  log('Cancelling leftovers...');
  await cancelLeftovers();
  await new Promise(r => setTimeout(r, 2000));

  await updateBalances();
  state.startingCapital = state.ngnBalance + (state.usdtBalance * 1385);
  log(`Capital:₦${state.startingCapital.toFixed(0)} NGN:₦${state.ngnBalance.toFixed(2)} USDT:${state.usdtBalance.toFixed(2)}`);

  const stream = new LunoStream(config.PRIMARY_PAIR, onBookUpdate);
  stream.connect();

  const PORT = process.env.PORT || 3000;
  http.createServer((req, res) => {
    res.writeHead(200);
    res.end(JSON.stringify({
      v: 'v2.3',
      spread: lastBook ? lastBook.spread.toFixed(2) : 'N/A',
      pnl: state.dailyPnl.toFixed(2),
      rot: state.dailyRotations,
      cost: state.lastBuyFillPrice,
    }));
  }).listen(PORT, () => log(`Port ${PORT}`));
}

async function shutdown(s) {
  log(`${s} — stopping`);
  isRunning = false;
  await cancelAll();
  await telegram.shutdown(s);
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
main().catch(e => { console.error('Fatal:', e); process.exit(1); });
