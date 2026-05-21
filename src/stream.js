// src/stream.js — Luno Websocket Streaming API
const WebSocket = require('ws');
const config = require('./config');

class LunoStream {
  constructor(pair, onUpdate) {
    this.pair = pair;
    this.onUpdate = onUpdate;
    this.ws = null;
    this.orderBook = { bids: {}, asks: {} };
    this.sequence = 0;
    this.connected = false;
    this.reconnectDelay = 1000;
  }

  connect() {
    this.ws = new WebSocket('wss://ws.luno.com/api/1/stream/' + this.pair);

    this.ws.on('open', () => {
      console.log(`[WS] Connected to ${this.pair}`);
      this.connected = true;
      this.reconnectDelay = 1000;
      // Send credentials as first message
      this.ws.send(JSON.stringify({
        api_key_id: config.LUNO_API_KEY,
        api_key_secret: config.LUNO_API_SECRET,
      }));
      console.log('[WS] Credentials sent');
    });

    this.ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        this.handleMessage(msg);
      } catch (err) {
        console.error('[WS] Parse error:', err.message);
      }
    });

    this.ws.on('close', (code, reason) => {
      console.log(`[WS] Disconnected. Code: ${code} Reason: ${reason ? reason.toString() : 'none'}`);
      this.connected = false;
      setTimeout(() => this.connect(), this.reconnectDelay);
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30000);
    });

    this.ws.on('error', (err) => {
      console.error(`[WS] Error: ${err.message}`);
    });

    this.ws.on('unexpected-response', (req, res) => {
      console.error(`[WS] HTTP ${res.statusCode} ${res.statusMessage}`);
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => console.error(`[WS] Body: ${body}`));
    });
  }

  handleMessage(msg) {
    if (msg.asks && msg.bids && msg.sequence) {
      this.orderBook = { bids: {}, asks: {} };
      for (const bid of msg.bids) {
        this.orderBook.bids[bid.id] = { price: parseFloat(bid.price), volume: parseFloat(bid.volume) };
      }
      for (const ask of msg.asks) {
        this.orderBook.asks[ask.id] = { price: parseFloat(ask.price), volume: parseFloat(ask.volume) };
      }
      this.sequence = parseInt(msg.sequence);
      console.log(`[WS] Snapshot: ${Object.keys(this.orderBook.bids).length} bids, ${Object.keys(this.orderBook.asks).length} asks`);
      this.emitUpdate([]);
      return;
    }

    const seq = parseInt(msg.sequence);
    if (seq <= this.sequence) return;
    this.sequence = seq;

    const trades = [];

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

    if (msg.create_update) {
      const cu = msg.create_update;
      const side = cu.type === 'BID' ? 'bids' : 'asks';
      this.orderBook[side][cu.order_id] = {
        price: parseFloat(cu.price),
        volume: parseFloat(cu.volume),
      };
    }

    if (msg.delete_update) {
      const du = msg.delete_update;
      delete this.orderBook.bids[du.order_id];
      delete this.orderBook.asks[du.order_id];
    }

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
