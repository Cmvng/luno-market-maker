// src/config.js — V2 Configuration
module.exports = {
  LUNO_API_KEY: process.env.LUNO_API_KEY_ID || '',
  LUNO_API_SECRET: process.env.LUNO_API_SECRET || '',
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || '',
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID || '',

  // Pairs
  PRIMARY_PAIR: 'USDTNGN',
  SECONDARY_PAIR: 'XBTNGN',

  // Websocket
  WS_URL: 'wss://ws.luno.com/api/1/stream',

  // Order placement (REST)
  REST_URL: 'https://api.luno.com/api/1',

  // Pricing
  PRICE_TICK: 0.01,        // USDT/NGN minimum increment
  BTC_PRICE_TICK: 1,       // BTC/NGN minimum increment

  // Sizing — dynamic based on spread
  MAX_ORDER_USDT: 500,
  MIN_ORDER_USDT: 5,
  BASE_CAPITAL_PCT: 0.48,  // use 48% per side when spread is wide
  MIN_CAPITAL_PCT: 0.15,   // use 15% per side when spread is tight
  SPREAD_SCALE: 2.0,       // spread at which we use full BASE_CAPITAL_PCT

  // Rebalance
  REBALANCE_THRESHOLD: 0.70, // trigger big order when one side > 70%
  REBALANCE_SIZE_PCT: 0.80,  // use 80% of heavy side for rebalance

  // Smart sell
  SMART_SELL_MARGIN: 0.01,   // ₦0.01 above cost — competitive at tight spreads

  // Competitor tracking
  COMPETITOR_HISTORY_SIZE: 100, // track last 100 price levels
  COMPETITOR_FLOOR_PERCENTILE: 0.10, // bottom 10% of asks = their floor

  // Risk
  MAX_DAILY_LOSS_PCT: 5,

  // Post-only cooldown
  POST_ONLY_FAIL_LIMIT: 5,
  POST_ONLY_COOLDOWN_MS: 5000,

  // Balance check interval
  BALANCE_CHECK_MS: 5000,
};
