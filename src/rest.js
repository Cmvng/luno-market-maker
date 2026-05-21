// src/rest.js — Luno REST API (orders + balances only)
const config = require('./config');

const BASE = config.REST_URL;

function authHeader() {
  return 'Basic ' + Buffer.from(`${config.LUNO_API_KEY}:${config.LUNO_API_SECRET}`).toString('base64');
}

async function request(method, path, params = {}) {
  let url = `${BASE}${path}`;
  const opts = {
    method,
    headers: {
      'Authorization': authHeader(),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
  };

  if (method === 'GET' && Object.keys(params).length > 0) {
    url += '?' + new URLSearchParams(params).toString();
  } else if (method === 'POST') {
    opts.body = new URLSearchParams(params).toString();
  }

  const res = await fetch(url, opts);
  const data = await res.json();
  if (data.error_code || data.error) {
    throw new Error(`${data.error_code || 'ERR'}: ${data.error || data.error_code}`);
  }
  return data;
}

module.exports = {
  getBalances: () => request('GET', '/balance'),
  listOrders: (pair, state = 'PENDING') => request('GET', '/listorders', { pair, state }),
  getOrder: (id) => request('GET', `/orders/${id}`),
  createOrder: (pair, type, volume, price, postOnly = true) =>
    request('POST', '/postorder', {
      pair,
      type,
      volume: volume.toString(),
      price: price.toString(),
      ...(postOnly ? { post_only: 'true' } : {}),
    }),
  cancelOrder: (id) => request('POST', '/stoporder', { order_id: id }),
};
