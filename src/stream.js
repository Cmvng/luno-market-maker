// src/stream.js — Luno Websocket Streaming API
// Real-time order book updates in milliseconds
const WebSocket = require('ws');
const config = require('./config');

class LunoStream {
  constructor(pair, onUpdate) {
    this.pair = pair;
    this.onUpdate = onUpdate; // callback(orderBook, trades)
    this.ws = null;
    this.orderBook = { bids: {}, asks: {} }; // price -> volume
    this.sequence = 0;
    this.connected = false;
    this.reconnectDelay = 1000;
  }

  connect() {
    const url = `${config.WS_URL}/${this.pair}`;
    const auth = Buffer.from(`${config.LUNO_API_KEY}:${config.LUNO_API_SECRET}`).toString('base64');

    this.ws = new WebSocket(url, {
      headers: { 'Authorization': `Basic ${auth}` },
    });

    this.ws.on('open', () => {
      console.log(`[WS] Connected to ${this.pair}`);
      this.connected = true;
      this.reconnectDelay = 1000;
    });

    this.ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        this.handleMessage(msg);
      } catch (err) {
        console.error('[WS] Parse error:', err.message);
      }
    });

    this.ws.on('close', () => {
      console.log(`[WS] Disconnected from ${this.pair}. Reconnecting in ${this.reconnectDelay}ms...`);
      this.connected = false;
      setTimeout(() => this.connect(), this.reconnectDelay);
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30000);
    });

    this.ws.on('error', (err) => {
      console.error(`[WS] Error: ${err.message}`);
    });
  }

  handleMessage(msg) {
    if (msg.asks && msg.bids && msg.sequence) {
      // Initial snapshot — full order book
      this.orderBook = { bids: {}, asks: {} };
      for (const bid of msg.bids) {
        this.orderBook.bids[bid.id] = { price: parseFloat(bid.price), volume: parseFloat(bid.volume) };
      }
      for (const ask of msg.asks) {
        this.orderBook.asks[ask.id] = { price: parseFloat(ask.price), volume: parseFloat(ask.volume) };
      }
      this.sequence = parseInt(msg.sequence);
      console.log(`[WS] Snapshot received. ${Object.keys(this.orderBook.bids).length} bids, ${Object.keys(this.orderBook.asks).length} asks`);
      this.emitUpdate([]);
      return;
    }

    // Incremental update
    const seq = parseInt(msg.sequence);
    if (seq <= this.sequence) return; // stale
    this.sequence = seq;

    const trades = [];

    // Process trade updates (fills)
    if (msg.trade_updates) {
      for (const t of msg.trade_updates) {
        trades.push({
          base: parseFloat(t.base),
          counter: parseFloat(t.counter),
          makerOrderId: t.maker_order_id,
          takerOrderId: t.taker_order_id,
        });
      }
    }

    // Process create updates (new orders)
    if (msg.create_update) {
      const cu = msg.create_update;
      const side = cu.type === 'BID' ? 'bids' : 'asks';
      this.orderBook[side][cu.order_id] = {
        price: parseFloat(cu.price),
        volume: parseFloat(cu.volume),
      };
    }

    // Process delete updates (cancelled/filled orders)
    if (msg.delete_update) {
      const du = msg.delete_update;
      delete this.orderBook.bids[du.order_id];
      delete this.orderBook.asks[du.order_id];
    }

    // Process status update
    if (msg.status_update) {
      console.log(`[WS] Status: ${msg.status_update.status}`);
    }

    this.emitUpdate(trades);
  }

  emitUpdate(trades) {
    const book = this.getConsolidatedBook();
    if (this.onUpdate) {
      this.onUpdate(book, trades);
    }
  }

  // Consolidate order book: group by price, sort
  getConsolidatedBook() {
    const bids = {};
    const asks = {};

    for (const order of Object.values(this.orderBook.bids)) {
      const p = order.price;
      bids[p] = (bids[p] || 0) + order.volume;
    }
    for (const order of Object.values(this.orderBook.asks)) {
      const p = order.price;
      asks[p] = (asks[p] || 0) + order.volume;
    }

    // Sort bids descending, asks ascending
    const sortedBids = Object.entries(bids)
      .map(([p, v]) => ({ price: parseFloat(p), volume: v }))
      .sort((a, b) => b.price - a.price);

    const sortedAsks = Object.entries(asks)
      .map(([p, v]) => ({ price: parseFloat(p), volume: v }))
      .sort((a, b) => a.price - b.price);

    const bestBid = sortedBids[0] || { price: 0, volume: 0 };
    const bestAsk = sortedAsks[0] || { price: 999999, volume: 0 };
    const midPrice = (bestBid.price + bestAsk.price) / 2;
    const spread = bestAsk.price - bestBid.price;

    return {
      bids: sortedBids,
      asks: sortedAsks,
      bestBid: bestBid.price,
      bestAsk: bestAsk.price,
      bestBidVol: bestBid.volume,
      bestAskVol: bestAsk.volume,
      midPrice,
      spread,
      spreadPct: (spread / midPrice) * 100,
    };
  }

  isConnected() {
    return this.connected && this.sequence > 0;
  }

  close() {
    if (this.ws) this.ws.close();
  }
}

module.exports = { LunoStream };
