// config.js — Triangle bot settings
module.exports = {
  LUNO_API_KEY: process.env.LUNO_API_KEY_ID || '',
  LUNO_API_SECRET: process.env.LUNO_API_SECRET || '',

  // Capital split
  ROUTE1_PCT: 0.65,   // USDC/NGN spread route
  ROUTE2_PCT: 0.35,   // USDC/USDT stablecoin route

  // Pairs
  PAIR_USDC_NGN: 'USDCNGN',
  PAIR_USDT_NGN: 'USDTNGN',
  PAIR_USDC_USDT: 'USDCUSDT',

  // ROUTE 1 rules
  R1_MIN_GAP: 10,          // only trade USDC/NGN when ask-bid > ₦10
  R1_BUY_TICK: 0.01,       // buy at best bid + ₦0.01
  R1_SELL_BELOW_USDT: 3,   // sell USDC at ₦3 below USDT price (range 2-5)
  R1_SELL_BELOW_MIN: 2,    // closest to USDT price
  R1_SELL_BELOW_MAX: 5,    // furthest from USDT price

  // ROUTE 2 rules
  R2_USDC_BUY: 0.98005,    // buy USDC with USDT at this price
  R2_USDC_CEILING: 0.9990, // never pay more than this for USDC
  R2_SELL_BELOW_USDT: 3,   // sell USDC at ₦3 below USDT price

  // Order sizing
  MIN_ORDER_USDC: 5,       // Luno minimum
  MAX_ORDER_USDC: 500,

  // Timing
  BALANCE_CHECK_MS: 5000,
  ACTION_THROTTLE_MS: 500,
  BUY_REFRESH_MS: 3000,    // re-top buy every 3s if outbid
  SELL_WAIT_MS: 60000,     // let sell sit 60s before adjusting

  PRICE_DECIMALS_NGN: 2,   // Luno wants 2 decimals for NGN pairs
  PRICE_DECIMALS_USDT: 5,  // USDC/USDT uses more decimals
};
