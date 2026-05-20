// src/config.js — Bot Configuration

module.exports = {
  // === LUNO API ===
  LUNO_API_KEY: process.env.LUNO_API_KEY_ID || '',
  LUNO_API_SECRET: process.env.LUNO_API_SECRET || '',

  // === TELEGRAM ===
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || '',
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID || '',

  // === TRADING PAIRS ===
  PRIMARY_PAIR: 'USDTNGN',   // main pair — USDT/NGN
  SECONDARY_PAIR: 'XBTNGN',  // fallback — BTC/NGN (XBT is Luno's ticker for BTC)

  // === TIMING ===
  LOOP_INTERVAL_MS: 4000,           // main loop every 4 seconds
  PAIR_CHECK_INTERVAL_MS: 30000,    // check pair spreads every 30 seconds
  RATE_HISTORY_WINDOW_MS: 300000,   // 5 minute rolling window for rate change detection

  // === SPREAD THRESHOLDS ===
  USDT_MIN_SPREAD_NGN: 1.00,        // minimum ₦1.00 spread to trade USDT/NGN
  USDT_MIN_SPREAD_PCT: 0.07,        // 0.07% minimum spread
  BTC_MIN_SPREAD_PCT: 0.50,         // 0.5% minimum spread for BTC/NGN
  PAIR_SWITCH_THRESHOLD_PCT: 0.07,  // switch to BTC if USDT spread below this

  // === MARKET STATES ===
  CALM_THRESHOLD_PCT: 0.3,          // rate change < 0.3% in 5 min = CALM
  CAUTION_THRESHOLD_PCT: 0.8,       // rate change 0.3-0.8% in 5 min = CAUTION
  // above 0.8% = DANGER

  // === INVENTORY ===
  TARGET_INVENTORY_RATIO: 0.50,     // 50/50 split target
  IMBALANCE_WARN_RATIO: 0.60,      // start skewing at 60/40
  IMBALANCE_CRITICAL_RATIO: 0.80,  // emergency rebalance at 80/20
  INVENTORY_SKEW_NGN: 0.10,        // ₦0.10 skew per level for USDT (gentle rebalance)

  // === RISK MANAGEMENT ===
  MAX_DAILY_LOSS_PCT: 5,            // stop bot if daily loss exceeds 5% of capital
  MAX_CONSECUTIVE_ERRORS: 3,        // stop if 3 API errors in a row
  USDT_DEPEG_THRESHOLD: 0.995,     // stop if USDT/USD drops below $0.995

  // === ORDER SIZING ===
  // The bot calculates order size from available balance
  // These are safety caps
  MAX_ORDER_USDT: 50,               // max single order in USDT
  MIN_ORDER_USDT: 5,                // min order size
  MAX_ORDER_BTC: 0.005,             // max single order in BTC
  MIN_ORDER_BTC: 0.0005,            // min order size (Luno minimum ~0.0005 BTC)

  // === TOP OF BOOK ===
  PRICE_TICK_USDT: 0.01,             // minimum price increment for USDT/NGN (2 decimal places)
  PRICE_TICK_BTC: 1,                // minimum price increment for BTC/NGN
  MAX_BID_DISTANCE_PCT: 0.5,        // don't bid more than 0.5% above mid (bot war protection)
  MAX_ASK_DISTANCE_PCT: 0.5,        // don't ask more than 0.5% below mid

  // === SLEEP ===
  SLEEP_DURATION_MS: 300000,         // 5 minute sleep when all spreads tight
};
