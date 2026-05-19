// src/state.js — Market State Engine & Rate Tracker

const config = require('./config');

class StateEngine {
  constructor() {
    this.state = 'CALM'; // CALM | CAUTION | DANGER
    this.activePair = config.PRIMARY_PAIR;
    this.priceHistory = []; // { timestamp, price }
    this.dailyPnl = 0;
    this.dailyRotations = 0;
    this.startingCapitalNgn = 0;
    this.consecutiveErrors = 0;
    this.lastPairCheck = 0;
    this.isSleeping = false;
    this.sleepUntil = 0;

    // Track open orders
    this.buyOrderId = null;
    this.sellOrderId = null;
    this.buyOrderPrice = 0;
    this.sellOrderPrice = 0;
    this.buyOrderVolume = 0;
    this.sellOrderVolume = 0;

    // Inventory
    this.ngnBalance = 0;
    this.usdtBalance = 0;
    this.btcBalance = 0;
  }

  // Add price to rolling history
  addPrice(price) {
    const now = Date.now();
    this.priceHistory.push({ timestamp: now, price });
    // Remove old entries beyond the window
    const cutoff = now - config.RATE_HISTORY_WINDOW_MS;
    this.priceHistory = this.priceHistory.filter(p => p.timestamp > cutoff);
  }

  // Calculate rate of change over the window
  getRateChange() {
    if (this.priceHistory.length < 2) return 0;
    const oldest = this.priceHistory[0].price;
    const newest = this.priceHistory[this.priceHistory.length - 1].price;
    return ((newest - oldest) / oldest) * 100;
  }

  // Get rate direction: 'up' (naira weakening), 'down' (naira strengthening), 'stable'
  getRateDirection() {
    const change = this.getRateChange();
    if (Math.abs(change) < 0.05) return 'stable';
    return change > 0 ? 'up' : 'down';
  }

  // Determine market state from rate change
  updateState() {
    const absChange = Math.abs(this.getRateChange());
    let newState;

    if (absChange < config.CALM_THRESHOLD_PCT) {
      newState = 'CALM';
    } else if (absChange < config.CAUTION_THRESHOLD_PCT) {
      newState = 'CAUTION';
    } else {
      newState = 'DANGER';
    }

    const changed = newState !== this.state;
    this.state = newState;
    return { state: newState, changed, rateChange: this.getRateChange() };
  }

  // Calculate inventory ratio (what % is in crypto vs NGN)
  getInventoryRatio() {
    const pair = this.activePair;
    let cryptoValueNgn = 0;

    if (pair === 'USDTNGN') {
      cryptoValueNgn = this.usdtBalance * (this.priceHistory.length > 0
        ? this.priceHistory[this.priceHistory.length - 1].price
        : 1385);
    } else {
      cryptoValueNgn = this.btcBalance * (this.priceHistory.length > 0
        ? this.priceHistory[this.priceHistory.length - 1].price
        : 106000000);
    }

    const totalNgn = this.ngnBalance + cryptoValueNgn;
    if (totalNgn === 0) return 0.5;

    return cryptoValueNgn / totalNgn; // 0 = all NGN, 1 = all crypto
  }

  // Get inventory skew direction
  getInventorySkew() {
    const ratio = this.getInventoryRatio();
    if (ratio > config.IMBALANCE_CRITICAL_RATIO) return 'SELL_URGENT';
    if (ratio > config.IMBALANCE_WARN_RATIO) return 'SELL_SKEW';
    if (ratio < (1 - config.IMBALANCE_CRITICAL_RATIO)) return 'BUY_URGENT';
    if (ratio < (1 - config.IMBALANCE_WARN_RATIO)) return 'BUY_SKEW';
    return 'BALANCED';
  }

  // Check if daily loss limit hit
  isDailyLossLimitHit() {
    if (this.startingCapitalNgn === 0) return false;
    const lossPct = (this.dailyPnl / this.startingCapitalNgn) * -100;
    return lossPct >= config.MAX_DAILY_LOSS_PCT;
  }

  // Record a completed rotation
  recordRotation(profitNgn) {
    this.dailyPnl += profitNgn;
    this.dailyRotations++;
  }

  // Reset daily stats (call at midnight)
  resetDaily(currentCapitalNgn) {
    this.dailyPnl = 0;
    this.dailyRotations = 0;
    this.startingCapitalNgn = currentCapitalNgn;
  }

  // Should we switch pairs?
  shouldCheckPairSwitch() {
    return Date.now() - this.lastPairCheck > config.PAIR_CHECK_INTERVAL_MS;
  }

  markPairChecked() {
    this.lastPairCheck = Date.now();
  }

  // Is bot sleeping?
  checkSleep() {
    if (this.isSleeping && Date.now() > this.sleepUntil) {
      this.isSleeping = false;
    }
    return this.isSleeping;
  }

  sleep() {
    this.isSleeping = true;
    this.sleepUntil = Date.now() + config.SLEEP_DURATION_MS;
  }
}

module.exports = { StateEngine };
