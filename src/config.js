// src/config.js — Bot Configuration — AGGRESSIVE SPEED MODE

module.exports = {
  // === LUNO API ===
  LUNO_API_KEY: process.env.LUNO_API_KEY_ID || '',
  LUNO_API_SECRET: process.env.LUNO_API_SECRET || '',

  // === TELEGRAM ===
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || '',
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID || '',

  // === TRADING PAIRS ===
  PRIMARY_PAIR: 'USDTNGN',
  SECONDARY_PAIR: 'XBTNGN',

  // === TIMING — MAXIMUM SPEED ===
  LOOP_INTERVAL_MS: 1000,            // 1 second loop — as fast as Luno API allows
  PAIR_CHECK_INTERVAL_MS: 60000,     // check pair spreads every 60 seconds (less frequent to save API calls)
  RATE_HISTORY_WINDOW_MS: 300000,

  // === SPREAD THRESHOLDS ===
  USDT_MIN_SPREAD_NGN: 1.00,
  USDT_MIN_SPREAD_PCT: 0.07,
  BTC_MIN_SPREAD_PCT: 0.50,
  PAIR_SWITCH_THRESHOLD_PCT: 0.07,

  // === MARKET STATES ===
  CALM_THRESHOLD_PCT: 0.3,
  CAUTION_THRESHOLD_PCT: 0.8,

  // === INVENTORY — TIGHTER CONTROL ===
  TARGET_INVENTORY_RATIO: 0.50,
  IMBALANCE_WARN_RATIO: 0.55,       // start skewing earlier at 55%
  IMBALANCE_CRITICAL_RATIO: 0.70,   // emergency at 70% (was 80%)
  INVENTORY_SKEW_NGN: 0.15,

  // === RISK MANAGEMENT ===
  MAX_DAILY_LOSS_PCT: 5,
  MAX_CONSECUTIVE_ERRORS: 5,         // allow more errors since we're faster
  USDT_DEPEG_THRESHOLD: 0.995,

  // === ORDER SIZING ===
  MAX_ORDER_USDT: 100,               // bigger max since you deposited more
  MIN_ORDER_USDT: 5,
  MAX_ORDER_BTC: 0.005,
  MIN_ORDER_BTC: 0.0005,

  // === TOP OF BOOK — AGGRESSIVE ===
  PRICE_TICK_USDT: 0.01,
  PRICE_TICK_BTC: 1,
  MAX_BID_DISTANCE_PCT: 0.3,         // tighter bot war protection
  MAX_ASK_DISTANCE_PCT: 0.3,

  // === SLEEP ===
  SLEEP_DURATION_MS: 120000,          // only sleep 2 minutes when tight
};
