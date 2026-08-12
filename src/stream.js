// stream.js — Luno websocket for one pair's order book
const WebSocket = require('ws');
const config = require('./config');

class Stream {
  constructor(pair, onUpdate) {
    this.pair = pair;
    this.onUpdate = onUpdate;
    this.ws = null;
    this.book = { bids: {}, asks: {} };
    this.seq = 0;
    this.connected = false;
    this.delay = 1000;
  }

  connect() {
    this.ws = new WebSocket('wss://ws.luno.com/api/1/stream/' + this.pair);

    this.ws.on('open', () => {
      this.connected = true;
      this.delay = 1000;
      this.ws.send(JSON.stringify({
        api_key_id: config.LUNO_API_KEY,
        api_key_secret: config.LUNO_API_SECRET,
      }));
      console.log(`[WS ${this.pair}] connected`);
    });

    this.ws.on('message', (data) => {
      try { this.handle(JSON.parse(data.toString())); }
      catch (e) { console.error(`[WS ${this.pair}] parse err`, e.message); }
    });

    this.ws.on('close', () => {
      this.connected = false;
      setTimeout(() => this.connect(), this.delay);
      this.delay = Math.min(this.delay * 2, 30000);
    });

    this.ws.on('error', (e) => console.error(`[WS ${this.pair}] err`, e.message));
  }

  handle(msg) {
    // Snapshot
    if (msg.asks && msg.bids && msg.sequence) {
      this.book = { bids: {}, asks: {} };
      for (const b of msg.bids) this.book.bids[b.id] = { price: +b.price, vol: +b.volume };
      for (const a of msg.asks) this.book.asks[a.id] = { price: +a.price, vol: +a.volume };
      this.seq = +msg.sequence;
      console.log(`[WS ${this.pair}] snapshot ${msg.bids.length}b/${msg.asks.length}a`);
      this.emit();
      return;
    }
    const seq = +msg.sequence;
    if (seq <= this.seq) return;
    // gap -> reconnect for fresh snapshot
    if (seq > this.seq + 1 && this.seq > 0) {
      console.log(`[WS ${this.pair}] seq gap, reconnecting`);
      this.seq = 0; this.book = { bids: {}, asks: {} };
      if (this.ws) this.ws.close();
      return;
    }
    this.seq = seq;
    if (msg.create_update) {
      const c = msg.create_update;
      const side = c.type === 'BID' ? 'bids' : 'asks';
      this.book[side][c.order_id] = { price: +c.price, vol: +c.volume };
    }
    if (msg.delete_update) {
      delete this.book.bids[msg.delete_update.order_id];
      delete this.book.asks[msg.delete_update.order_id];
    }
    this.emit();
  }

  emit() {
    const bids = Object.values(this.book.bids).sort((a, b) => b.price - a.price);
    const asks = Object.values(this.book.asks).sort((a, b) => a.price - b.price);
    const bestBid = bids[0] ? bids[0].price : 0;
    const bestAsk = asks[0] ? asks[0].price : 0;
    if (this.onUpdate) this.onUpdate({
      pair: this.pair,
      bestBid, bestAsk,
      spread: bestAsk - bestBid,
      bidVol: bids[0] ? bids[0].vol : 0,
      askVol: asks[0] ? asks[0].vol : 0,
    });
  }

  close() { if (this.ws) this.ws.close(); }
}

module.exports = { Stream };
