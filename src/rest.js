// rest.js — Luno REST API (orders + balances)
const config = require('./config');
const BASE = 'https://api.luno.com/api/1';

function auth() {
  return 'Basic ' + Buffer.from(`${config.LUNO_API_KEY}:${config.LUNO_API_SECRET}`).toString('base64');
}

async function call(method, path, params) {
  const url = new URL(BASE + path);
  let body;
  if (params && method === 'GET') {
    Object.keys(params).forEach(k => url.searchParams.append(k, params[k]));
  } else if (params) {
    body = new URLSearchParams(params).toString();
  }
  const res = await fetch(url.toString(), {
    method,
    headers: {
      'Authorization': auth(),
      ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
    },
    ...(body ? { body } : {}),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok || data.error) {
    throw new Error(data.error || `HTTP ${res.status}: ${text}`);
  }
  return data;
}

module.exports = {
  getBalances: () => call('GET', '/balance'),
  getTicker: (pair) => call('GET', '/ticker', { pair }),
  getOrderBook: (pair) => call('GET', '/orderbook_top', { pair }),
  listOrders: (pair, state) => call('GET', '/listorders', state ? { pair, state } : { pair }),
  getOrder: (id) => call('GET', '/orders/' + id),
  createOrder: (pair, type, volume, price, postOnly) =>
    call('POST', '/postorder', {
      pair, type,
      volume: String(volume),
      price: String(price),
      ...(postOnly ? { post_only: 'true' } : {}),
    }),
  cancelOrder: (id) => call('POST', '/stoporder', { order_id: id }),
};
