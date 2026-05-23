// src/index.js — V2.4 — Periodic order cleanup + accurate P&L
const { LunoStream } = require('./stream');
const { CompetitorTracker } = require('./competitor');
const rest = require('./rest');
const telegram = require('./telegram');
const config = require('./config');
const http = require('http');

const STOP = {
  MAX_LOSS: 0.50, FAST_DROP: 0.30, FAST_WINDOW: 300000,
  HISTORY: 600000, STALE_MS: 600000, STALE_GAP: 0.20,
};

const state = {
  ngnBalance: 0, usdtBalance: 0, btcBalance: 0,
  buyOrderId: null, sellOrderId: null,
  buyOrderPrice: 0, sellOrderPrice: 0,
  buyOrderVolume: 0, sellOrderVolume: 0,
  lastBuyFillPrice: 0, lastBuyFillTime: 0, lastSellFillPrice: 0,
  dailyPnl: 0, dailyRotations: 0, startingCapital: 0,
  _buyFails: 0, _sellFails: 0,
  _buyCooldown: 0, _sellCooldown: 0,
  _lastBal: 0, _lastLog: 0, _lastAct: 0, _lock: false,
  _prices: [], _negSince: null,
  _lastSellRefresh: 0, _lastBuyRefresh: 0,
  _lastCleanup: 0, _sellPlacedAt: 0,
};

const competitor = new CompetitorTracker();
let lastBook = null;
let isRunning = true;

function log(m) { console.log(`[${new Date().toISOString().slice(11,19)}] ${m}`); }

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

// === PERIODIC CLEANUP — cancel ALL orders on Luno and reset state ===
// This catches orphaned orders the bot lost track of
async function periodicCleanup() {
  try {
    const orders = await rest.listOrders('USDTNGN', 'PENDING');
    if (orders.orders && orders.orders.length > 0) {
      let cancelled = 0;
      for (const o of orders.orders) {
        // Only cancel if it's NOT our tracked order
        if (o.order_id !== state.buyOrderId && o.order_id !== state.sellOrderId) {
          await rest.cancelOrder(o.order_id);
          cancelled++;
        }
      }
      if (cancelled > 0) {
        log(`🧹 Cleanup: cancelled ${cancelled} orphaned orders`);
        await updateBalances();
      }
    }
  } catch(e) {}
}

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
        // Track P&L accurately — always count profit/loss
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

async function cancelAll() {
  if (state.buyOrderId&&state.buyOrderId!=='COOLDOWN') { try{await rest.cancelOrder(state.buyOrderId)}catch(e){} state.buyOrderId=null; }
  if (state.sellOrderId&&state.sellOrderId!=='COOLDOWN') { try{await rest.cancelOrder(state.sellOrderId)}catch(e){} state.sellOrderId=null; }
}

async function cancelLeftovers() {
  try { const o=await rest.listOrders('USDTNGN','PENDING'); if(o.orders) for(const x of o.orders) { await rest.cancelOrder(x.order_id); log(`Cancelled: ${x.order_id}`); } } catch(e){}
  try { const o=await rest.listOrders('XBTNGN','PENDING'); if(o.orders) for(const x of o.orders) { await rest.cancelOrder(x.order_id); log(`Cancelled: ${x.order_id}`); } } catch(e){}
}

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
      // Track the loss in P&L
      if (state.lastBuyFillPrice > 0) {
        const loss = (price - state.lastBuyFillPrice) * vol;
        state.dailyPnl += loss;
        log(`🚨 EMERGENCY SELL ${vol} @ ₦${price} | Loss: ₦${loss.toFixed(2)}`);
      } else {
        log(`🚨 EMERGENCY SELL ${vol} @ ₦${price}`);
      }
      state.lastBuyFillPrice = 0;
      state._buyCooldown = Date.now() + 60000;
      state._sellCooldown = Date.now() + 60000;
      await updateBalances();
    } catch(e) { log(`Emergency failed: ${e.message}`); }
  }
}

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
    if (e.message.includes('ErrOrderCanceled')) { state._sellFails++; if(state._sellFails>=3){state._sellCooldown=Date.now()+10000;state._sellFails=0;} }
  }
}

async function executeTrade(book) {
  const now = Date.now();
  if (now - state._lastAct < 500 || state._lock) return;
  state._lock = true; state._lastAct = now;

  try {
    // Balance + fills
    if (now - state._lastBal > config.BALANCE_CHECK_MS) {
      await updateBalances(); state._lastBal = now; await checkFills();
    }

    // === PERIODIC CLEANUP — every 5 minutes ===
    if (now - state._lastCleanup > 300000) {
      state._lastCleanup = now;
      await periodicCleanup();
    }

    // === STALE ORDERS ===
    if (state.sellOrderId && state.sellOrderId !== 'COOLDOWN' && state.lastBuyFillTime > 0) {
      const age = now - state.lastBuyFillTime;
      const gap = state.sellOrderPrice - book.bestAsk;
      if (age > STOP.STALE_MS && gap > STOP.STALE_GAP) {
        log(`⏰ Stale sell @ ₦${state.sellOrderPrice} — market ₦${book.bestAsk.toFixed(2)}. Cancelling.`);
        try { await rest.cancelOrder(state.sellOrderId); } catch(e) {}
        state.sellOrderId = null;
        // DON'T reset cost basis — keep it so P&L tracks the loss when the new sell fills
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

    // === NEGATIVE SPREAD ===
    if (book.spread <= 0) {
      if (!state._negSince) state._negSince = now;
      if (state.buyOrderId && state.buyOrderId !== 'COOLDOWN') {
        try { await rest.cancelOrder(state.buyOrderId); } catch(e) {}
        state.buyOrderId = null;
      }
      if (now - state._negSince > 30000 && global._stream) {
        log('🔄 Spread negative for 30s — reconnecting websocket...');
        state._negSince = null;
        global._stream.close();
        return;
      }
      if (state.usdtBalance > 10 && !state.sellOrderId) {
        const sv = Math.floor(state.usdtBalance * 0.99 * 100) / 100;
        const sp = Math.ceil(book.bestAsk * 100) / 100;
        if (sv >= config.MIN_ORDER_USDT) await placeSell('USDTNGN', sv, sp);
      }
      if (state.sellOrderId && state.sellOrderId !== 'COOLDOWN') {
        if (state.sellOrderPrice > book.bestAsk + 0.005 && now - state._lastSellRefresh > 3000) {
          try { await rest.cancelOrder(state.sellOrderId); } catch(e) {}
          state.sellOrderId = null;
          state._lastSellRefresh = now;
        }
      }
      return;
    }
    state._negSince = null;

    // === SELL STRATEGY: PLACE AND WAIT ===
    //
    // 1. Calculate sell price ONCE — close to bid where competitors won't go
    // 2. Place sell and LOCK for 60 seconds — no cancel, no replace
    // 3. After lock expires, only adjust if price moved ₦0.50+
    // 4. Post-only rejection → 10 second cooldown
    //

    const tick = config.PRICE_TICK;

    // === BUY PRICE — aggressive, one tick above best bid ===
    let bp;
    if (book.spread < tick * 3) { bp = book.bestBid; }
    else { bp = Math.floor((book.bestBid + tick) * 100) / 100; }
    bp = Math.floor(bp * 100) / 100;

    // === SELL PRICE — place near the bid, where competitors won't go ===
    // Strategy: bestBid + small margin. Not bestAsk - tick.
    // This puts us at the bottom of the ask side where no one wants to compete.
    let sp;
    const comp = competitor.getStats();
    const compFloor = parseFloat(comp.askFloor) || 0;

    if (compFloor > 0 && compFloor > book.bestBid + tick) {
      // Competitor floor is known — place AT their floor
      sp = Math.ceil(compFloor * 100) / 100;
    } else if (book.spread > 0.50) {
      // Wide spread — place in the lower third of the spread
      sp = Math.ceil((book.bestBid + book.spread * 0.3) * 100) / 100;
    } else {
      // Tight spread — place at bestAsk
      sp = book.bestAsk;
    }

    // Smart sell — never below cost + margin
    if (state.lastBuyFillPrice > 0) {
      const minSell = Math.ceil((state.lastBuyFillPrice + config.SMART_SELL_MARGIN) * 100) / 100;
      if (sp < minSell) sp = minSell;
    }
    if (sp <= bp) return;
    sp = Math.ceil(sp * 100) / 100;

    // === INVENTORY ===
    const tot = state.ngnBalance + state.usdtBalance * book.midPrice;
    const inv = tot > 0 ? (state.usdtBalance * book.midPrice) / tot : 0.5;

    // === SIZING ===
    let bv = 0, sv2 = 0;
    if (inv > 0.65) {
      sv2 = Math.floor(state.usdtBalance * 0.99 * 100) / 100;
      bv = 0;
    } else if (inv > 0.55) {
      sv2 = Math.floor(state.usdtBalance * 0.70 * 100) / 100;
      bv = Math.floor((state.ngnBalance * 0.30 / bp) * 100) / 100;
    } else if (inv > 0.45) {
      sv2 = Math.floor(state.usdtBalance * 0.50 * 100) / 100;
      bv = Math.floor((state.ngnBalance * 0.50 / bp) * 100) / 100;
    } else if (inv > 0.35) {
      sv2 = Math.floor(state.usdtBalance * 0.30 * 100) / 100;
      bv = Math.floor((state.ngnBalance * 0.70 / bp) * 100) / 100;
    } else {
      sv2 = Math.floor(state.usdtBalance * 0.99 * 100) / 100;
      bv = Math.floor((state.ngnBalance * 0.70 / bp) * 100) / 100;
    }
    bv = Math.min(Math.max(bv, 0), config.MAX_ORDER_USDT);
    sv2 = Math.min(Math.max(sv2, 0), config.MAX_ORDER_USDT);

    // === BUY REFRESH — every 3 seconds if outbid ===
    const now2 = Date.now();
    if (state.buyOrderId && state.buyOrderId !== 'COOLDOWN' && state.buyOrderPrice < bp - 0.005 && now2 - state._lastBuyRefresh > 3000) {
      try { await rest.cancelOrder(state.buyOrderId); } catch(e) {}
      state.buyOrderId = null; state._lastBuyRefresh = now2;
    }

    // === SELL: PLACE AND WAIT — 60 SECOND LOCK ===
    if (state.sellOrderId && state.sellOrderId !== 'COOLDOWN') {
      // Sell is placed — check if lock has expired
      const sellAge = now2 - (state._sellPlacedAt || 0);

      if (sellAge < 60000) {
        // LOCKED — do nothing, let it sit in the queue
        // No cancel, no refresh, no matter what
      } else {
        // Lock expired — only refresh if price moved significantly (₦0.50+)
        const drift = Math.abs(state.sellOrderPrice - sp);
        if (drift > 0.50) {
          const ok = !state.lastBuyFillPrice || sp > state.lastBuyFillPrice + config.SMART_SELL_MARGIN - 0.005;
          if (ok) {
            log('🔄 Sell lock expired, price drifted ₦' + drift.toFixed(2) + ' — replacing');
            try { await rest.cancelOrder(state.sellOrderId); } catch(e) {}
            state.sellOrderId = null;
          }
        }
        // If drift < ₦0.50, extend the lock — leave it alone
      }
    }

    // === PLACE ORDERS ===
    if (bv >= config.MIN_ORDER_USDT) await placeBuy('USDTNGN', bv, bp);
    if (sv2 >= config.MIN_ORDER_USDT) {
      if (!state.sellOrderId) {
        await placeSell('USDTNGN', sv2, sp);
        if (state.sellOrderId) {
          state._sellPlacedAt = now2;
          // Don't set _lastSellRefresh — use _sellPlacedAt for the lock
        }
      }
    }

  } finally { state._lock = false; }
}

async function onBookUpdate(book, trades) {
  if (!isRunning) return;
  lastBook = book;
  competitor.update(book);
  for (const t of trades) {
    if (state.buyOrderId && (t.makerOrderId===state.buyOrderId || t.takerOrderId===state.buyOrderId)) await checkFills();
    if (state.sellOrderId && (t.makerOrderId===state.sellOrderId || t.takerOrderId===state.sellOrderId)) await checkFills();
  }
  await executeTrade(book);
  const now = Date.now();
  if (now - state._lastLog > 10000) {
    state._lastLog = now;
    const tot = state.ngnBalance + state.usdtBalance * (book.midPrice||1385);
    const inv = tot>0?(state.usdtBalance*(book.midPrice||1385))/tot:0.5;
    const cost = state.lastBuyFillPrice>0?` Cost:₦${state.lastBuyFillPrice.toFixed(2)}`:'';
    log(
      `Spread:₦${book.spread.toFixed(2)} Inv:${(inv*100).toFixed(0)}% ` +
      `P&L:₦${state.dailyPnl.toFixed(2)} Rot:${state.dailyRotations} ` +
      `B:${state.buyOrderId?'✅':'❌'} S:${state.sellOrderId?'✅':'❌'} ` +
      `NGN:₦${state.ngnBalance.toFixed(0)} USDT:${state.usdtBalance.toFixed(1)}${cost}`
    );
  }
}

async function main() {
  if (!config.LUNO_API_KEY || !config.LUNO_API_SECRET) { console.error('❌ Missing API keys'); process.exit(1); }
  await telegram.startup();
  log('🚀 V2.4 — Periodic cleanup + accurate P&L');
  log('Cancelling ALL leftovers...');
  await cancelLeftovers();
  await new Promise(r => setTimeout(r, 2000));
  await updateBalances();
  state.startingCapital = state.ngnBalance + (state.usdtBalance * 1385);
  log(`Capital:₦${state.startingCapital.toFixed(0)} NGN:₦${state.ngnBalance.toFixed(2)} USDT:${state.usdtBalance.toFixed(2)}`);
  const stream = new LunoStream(config.PRIMARY_PAIR, onBookUpdate);
  global._stream = stream;
  stream.connect();
  const PORT = process.env.PORT || 3000;
  http.createServer((req, res) => {
    res.writeHead(200);
    res.end(JSON.stringify({ v:'v2.4', spread:lastBook?lastBook.spread.toFixed(2):'N/A', pnl:state.dailyPnl.toFixed(2), rot:state.dailyRotations, cost:state.lastBuyFillPrice }));
  }).listen(PORT, () => log(`Port ${PORT}`));
}

async function shutdown(s) { log(`${s} — stopping`); isRunning=false; await cancelAll(); await telegram.shutdown(s); process.exit(0); }
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
main().catch(e => { console.error('Fatal:', e); process.exit(1); });
