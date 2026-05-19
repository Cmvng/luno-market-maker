// src/luno.js — Luno API Client
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

const BASE_URL = 'https://api.luno.com/api/1';

function makeAuthHeader(keyId, secret) {
  const encoded = Buffer.from(`${keyId}:${secret}`).toString('base64');
  return `Basic ${encoded}`;
}

class LunoClient {
  constructor(keyId, secret) {
    this.keyId = keyId;
    this.secret = secret;
    this.authHeader = makeAuthHeader(keyId, secret);
  }

  async request(method, path, params = {}) {
    let url = `${BASE_URL}${path}`;
    const options = {
      method,
      headers: {
        'Authorization': this.authHeader,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    };

    if (method === 'GET' && Object.keys(params).length > 0) {
      const query = new URLSearchParams(params).toString();
      url += `?${query}`;
    } else if (method === 'POST') {
      options.body = new URLSearchParams(params).toString();
    }

    const res = await fetch(url, options);
    const data = await res.json();

    if (data.error_code || data.error) {
      throw new Error(`Luno API Error: ${data.error_code || data.error} — ${data.error || ''}`);
    }

    return data;
  }

  // === PUBLIC ENDPOINTS (no auth needed but we send it anyway) ===

  async getTicker(pair) {
    return this.request('GET', '/ticker', { pair });
  }

  async getOrderBook(pair) {
    return this.request('GET', '/orderbook_top', { pair });
  }

  async getFullOrderBook(pair) {
    return this.request('GET', '/orderbook', { pair });
  }

  async getTrades(pair, since) {
    const params = { pair };
    if (since) params.since = since;
    return this.request('GET', '/trades', params);
  }

  // === AUTHENTICATED ENDPOINTS ===

  async getBalances() {
    return this.request('GET', '/balance');
  }

  async listOrders(pair, state = 'PENDING') {
    return this.request('GET', '/listorders', { pair, state });
  }

  async getOrder(orderId) {
    return this.request('GET', '/orders/' + orderId);
  }

  async createOrder(pair, type, volume, price, postOnly = true) {
    const params = {
      pair,
      type, // BID (buy) or ASK (sell)
      volume: volume.toString(),
      price: price.toString(),
    };
    if (postOnly) {
      params.post_only = 'true';
    }
    return this.request('POST', '/postorder', params);
  }

  async cancelOrder(orderId) {
    return this.request('POST', '/stoporder', { order_id: orderId });
  }
}

module.exports = { LunoClient };
