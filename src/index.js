// index.js — Triangle bot: Route 1 (USDC/NGN spread) + Route 2 (USDC/USDT)
// Each route tracks its OWN USDC by order volume — routes never touch each other's coins.
const { Stream } = require('./stream');
const rest = require('./rest');
const config = require('./config');
const http = require('http');

const books = {
  [config.PAIR_USDC_NGN]: null,
  [config.PAIR_USDT_NGN]: null,
  [config.PAIR_USDC_USDT]: null,
};

const bal = { NGN: 0, USDT: 0, USDC: 0 };

// Each route tracks its own held USDC (name tags on the coins)
const R1 = {
  buyId: null, buyPrice: 0, buyVol: 0,
  sellId: null, sellPrice: 0,
  ownUsdc: 0,            // USDC this route bought and now holds
  lastBuyRefresh: 0,
};
const R2 = {
  usdcBuyId: null, usdcBuyPrice: 0, usdcBuyVol: 0,
  sellId: null, sellPrice: 0,
  ownUsdc: 0,            // USDC this route bought and now holds
  lastRefresh: 0,
};

let running = true;
let lock = false;
let lastAct = 0, lastBal = 0, lastLog = 0;

function log(m) { console.log(`[${new Date().toISOString().slice(11,19)}] ${m}`); }
function r2(n) { return Math.round(n * 100) / 100; }
function r5(n) { return Math.round(n * 100000) / 100000; }

async function updateBalances() {
  try {
    const res = await rest.getBalances();
    for (const a of (res.balance || [])) {
      const c = a.asset || a.currency;
      const avail = (+a.balance || 0) - (+a.reserved || 0);
      if (c === 'NGN') bal.NGN = avail;
      if (c === 'USDT') bal.USDT = avail;
      if (c === 'USDC') bal.USDC = avail;
    }
  } catch (e) {}
}

async function cancelEverything() {
  for (const pair of [config.PAIR_USDC_NGN, config.PAIR_USDT_NGN, config.PAIR_USDC_USDT]) {
    try {
      const res = await rest.listOrders(pair, 'PENDING');
      if (res.orders) {
        for (const o of res.orders) {
          try { await rest.cancelOrder(o.order_id); log(`cancelled ${o.order_id} on ${pair}`); } catch (e) {}
        }
      }
    } catch (e) {}
  }
}

async function orderState(id) {
  try { const o = await rest.getOrder(id); return o.state; } catch (e) { return 'UNKNOWN'; }
}

// ============ ROUTE 1: USDC/NGN spread ============
async function runRoute1(capital) {
  const book = books[config.PAIR_USDC_NGN];
  const usdtBook = books[config.PAIR_USDT_NGN];
  if (!book || !usdtBook || book.bestBid === 0 || usdtBook.bestBid === 0) return;
  const now = Date.now();
  const gap = book.spread;

  // Buy filled? -> record OUR USDC as the volume we bought
  if (R1.buyId) {
    const st = await orderState(R1.buyId);
    if (st === 'COMPLETE') {
      R1.ownUsdc = R1.buyVol;                 // name tag: this much USDC is Route 1's
      log(`R1 ✅ BUY filled @ ₦${R1.buyPrice} — hold ${R1.ownUsdc} USDC`);
      R1.buyId = null;
      await updateBalances();
    } else if (st === 'CANCELLED' || st === 'UNKNOWN') {
      R1.buyId = null;
    }
  }

  // Sell filled? -> our USDC is gone, naira back
  if (R1.sellId) {
    const st = await orderState(R1.sellId);
    if (st === 'COMPLETE') {
      log(`R1 ✅ SELL filled @ ₦${R1.sellPrice} — naira back`);
      R1.sellId = null; R1.ownUsdc = 0;
      await updateBalances();
    } else if (st === 'CANCELLED' || st === 'UNKNOWN') {
      R1.sellId = null;
    }
  }

  // Holding OUR USDC -> sell it (priced off USDT), only sell what THIS route owns
  if (R1.ownUsdc >= config.MIN_ORDER_USDC && !R1.sellId) {
    const usdtPrice = usdtBook.bestBid;
    const sellPrice = r2(usdtPrice - config.R1_SELL_BELOW_USDT);
    const vol = Math.min(r2(R1.ownUsdc), r2(bal.USDC)); // never exceed real wallet
    if (vol >= config.MIN_ORDER_USDC && sellPrice > 0) {
      try {
        const res = await rest.createOrder(config.PAIR_USDC_NGN, 'ASK', vol, sellPrice, true);
        R1.sellId = res.order_id; R1.sellPrice = sellPrice;
        log(`R1 📕 SELL ${vol} USDC @ ₦${sellPrice} (USDT ₦${usdtPrice})`);
      } catch (e) {}
    }
    return;
  }

  // Buy side: only if not currently holding our own USDC, and gap wide
  if (R1.ownUsdc < config.MIN_ORDER_USDC && gap > config.R1_MIN_GAP) {
    const buyPrice = r2(book.bestBid + config.R1_BUY_TICK);
    if (R1.buyId && book.bestBid >= R1.buyPrice && now - R1.lastBuyRefresh > config.BUY_REFRESH_MS) {
      try { await rest.cancelOrder(R1.buyId); } catch (e) {}
      R1.buyId = null; R1.lastBuyRefresh = now;
    }
    if (!R1.buyId) {
      const spendNgn = Math.min(capital, bal.NGN);
      const vol = r2((spendNgn / buyPrice) * 0.99);
      if (vol >= config.MIN_ORDER_USDC) {
        try {
          const res = await rest.createOrder(config.PAIR_USDC_NGN, 'BID', vol, buyPrice, true);
          R1.buyId = res.order_id; R1.buyPrice = buyPrice; R1.buyVol = vol;
          log(`R1 📗 BUY ${vol} USDC @ ₦${buyPrice} (gap ₦${gap.toFixed(2)})`);
        } catch (e) {}
      }
    }
  }
}

// ============ ROUTE 2: USDC/USDT stablecoin ============
async function runRoute2(capital) {
  const usdcUsdt = books[config.PAIR_USDC_USDT];
  const usdtBook = books[config.PAIR_USDT_NGN];
  const usdcNgn = books[config.PAIR_USDC_NGN];
  if (!usdcUsdt || !usdtBook || !usdcNgn) return;
  if (usdcUsdt.bestBid === 0 || usdtBook.bestBid === 0 || usdcNgn.bestBid === 0) return;
  const now = Date.now();

  // USDC buy filled? -> record OUR USDC
  if (R2.usdcBuyId) {
    const st = await orderState(R2.usdcBuyId);
    if (st === 'COMPLETE') {
      R2.ownUsdc = R2.usdcBuyVol;             // name tag: this much USDC is Route 2's
      log(`R2 ✅ USDC bought @ ${R2.usdcBuyPrice} — hold ${R2.ownUsdc} USDC`);
      R2.usdcBuyId = null;
      await updateBalances();
    } else if (st === 'CANCELLED' || st === 'UNKNOWN') {
      R2.usdcBuyId = null;
    }
  }

  // Sell filled? -> naira back
  if (R2.sellId) {
    const st = await orderState(R2.sellId);
    if (st === 'COMPLETE') {
      log(`R2 ✅ SELL filled @ ₦${R2.sellPrice} — naira back`);
      R2.sellId = null; R2.ownUsdc = 0;
      await updateBalances();
    } else if (st === 'CANCELLED' || st === 'UNKNOWN') {
      R2.sellId = null;
    }
  }

  // Step 1+2: if we have USDT and aren't holding our own USDC yet, buy USDC at ~0.98
  if (bal.USDT >= config.MIN_ORDER_USDC && !R2.usdcBuyId && R2.ownUsdc < config.MIN_ORDER_USDC) {
    let buyPrice = config.R2_USDC_BUY;
    if (usdcUsdt.bestBid + 0.00001 > buyPrice && usdcUsdt.bestBid + 0.00001 <= config.R2_USDC_CEILING) {
      buyPrice = r5(usdcUsdt.bestBid + 0.00001);
    }
    const vol = r2((bal.USDT / buyPrice) * 0.99);
    if (vol >= config.MIN_ORDER_USDC) {
      try {
        const res = await rest.createOrder(config.PAIR_USDC_USDT, 'BID', vol, buyPrice, true);
        R2.usdcBuyId = res.order_id; R2.usdcBuyPrice = buyPrice; R2.usdcBuyVol = vol;
        log(`R2 📗 BUY ${vol} USDC @ ${buyPrice} USDT`);
      } catch (e) {}
    }
  }

  // Step 3: sell OUR USDC back to naira (only what THIS route owns)
  if (R2.ownUsdc >= config.MIN_ORDER_USDC && !R2.sellId) {
    const usdtPrice = usdtBook.bestBid;
    const sellPrice = r2(usdtPrice - config.R2_SELL_BELOW_USDT);
    // wallet must actually hold enough beyond what R1 is also trying to sell
    const freeUsdc = bal.USDC - (R1.sellId ? 0 : R1.ownUsdc);
    const vol = Math.min(r2(R2.ownUsdc), r2(freeUsdc));
    if (vol >= config.MIN_ORDER_USDC && sellPrice > 0) {
      try {
        const res = await rest.createOrder(config.PAIR_USDC_NGN, 'ASK', vol, sellPrice, true);
        R2.sellId = res.order_id; R2.sellPrice = sellPrice;
        log(`R2 📕 SELL ${vol} USDC @ ₦${sellPrice}`);
      } catch (e) {}
    }
  }
}

async function tick() {
  if (!running || lock) return;
  const now = Date.now();
  if (now - lastAct < config.ACTION_THROTTLE_MS) return;
  lock = true; lastAct = now;
  try {
    if (now - lastBal > config.BALANCE_CHECK_MS) { await updateBalances(); lastBal = now; }
    const totalNgn = bal.NGN + (bal.USDT + bal.USDC) * (books[config.PAIR_USDT_NGN]?.bestBid || 1395);
    await runRoute1(totalNgn * config.ROUTE1_PCT);
    await runRoute2(totalNgn * config.ROUTE2_PCT);
    if (now - lastLog > 10000) {
      lastLog = now;
      const un = books[config.PAIR_USDC_NGN], ut = books[config.PAIR_USDT_NGN], uu = books[config.PAIR_USDC_USDT];
      log(`NGN:₦${bal.NGN.toFixed(0)} USDT:${bal.USDT.toFixed(1)} USDC:${bal.USDC.toFixed(1)} | R1own:${R1.ownUsdc} R2own:${R2.ownUsdc} | ` +
          `USDC/NGN:${un?un.bestBid+'/'+un.bestAsk+' gap'+un.spread.toFixed(1):'--'} | USDT/NGN:${ut?ut.bestBid:'--'} | USDC/USDT:${uu?uu.bestBid:'--'}`);
    }
  } finally { lock = false; }
}

async function main() {
  if (!config.LUNO_API_KEY || !config.LUNO_API_SECRET) { console.error('Missing API keys'); process.exit(1); }
  log('🚀 Triangle bot — Route 1 + Route 2 (per-route USDC tracking)');
  log('Cancelling ALL orders on all 3 pairs...');
  await cancelEverything();
  await new Promise(r => setTimeout(r, 2000));
  await updateBalances();
  log(`Start — NGN:₦${bal.NGN.toFixed(0)} USDT:${bal.USDT.toFixed(1)} USDC:${bal.USDC.toFixed(1)}`);
  for (const pair of [config.PAIR_USDC_NGN, config.PAIR_USDT_NGN, config.PAIR_USDC_USDT]) {
    const s = new Stream(pair, (b) => { books[pair] = b; });
    s.connect();
  }
  setInterval(tick, config.ACTION_THROTTLE_MS);
  const PORT = process.env.PORT || 3000;
  http.createServer((req, res) => {
    res.writeHead(200);
    res.end(JSON.stringify({ status: 'running', bal, R1: { own: R1.ownUsdc, buy: !!R1.buyId, sell: !!R1.sellId }, R2: { own: R2.ownUsdc, buy: !!R2.usdcBuyId, sell: !!R2.sellId } }));
  }).listen(PORT, () => log(`Health on ${PORT}`));
}

async function shutdown(s) { log(`${s} — cancelling all & stopping`); running = false; await cancelEverything(); process.exit(0); }
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
main().catch(e => { console.error('Fatal:', e); process.exit(1); });
