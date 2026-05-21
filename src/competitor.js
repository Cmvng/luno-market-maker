// src/competitor.js — Track competitor bot behavior
const config = require('./config');

class CompetitorTracker {
  constructor() {
    this.askPrices = [];  // history of best ask prices seen
    this.bidPrices = [];  // history of best bid prices seen
    this.askFloor = 0;    // lowest ask price competitor uses
    this.bidCeiling = 0;  // highest bid price competitor uses
    this.undercutStep = 0; // how much they undercut per cycle
    this.lastAsk = 0;
    this.lastBid = 0;
  }

  // Call on every order book update
  update(book) {
    if (book.bestAsk > 0) {
      this.askPrices.push(book.bestAsk);
      if (this.askPrices.length > config.COMPETITOR_HISTORY_SIZE) {
        this.askPrices.shift();
      }

      // Detect undercut step
      if (this.lastAsk > 0 && book.bestAsk < this.lastAsk) {
        this.undercutStep = this.lastAsk - book.bestAsk;
      }
      this.lastAsk = book.bestAsk;
    }

    if (book.bestBid > 0) {
      this.bidPrices.push(book.bestBid);
      if (this.bidPrices.length > config.COMPETITOR_HISTORY_SIZE) {
        this.bidPrices.shift();
      }
      this.lastBid = book.bestBid;
    }

    this.calculateLimits();
  }

  calculateLimits() {
    if (this.askPrices.length < 10) return;

    // Ask floor = bottom percentile of ask prices (where they stop undercutting)
    const sortedAsks = [...this.askPrices].sort((a, b) => a - b);
    const floorIdx = Math.floor(sortedAsks.length * config.COMPETITOR_FLOOR_PERCENTILE);
    this.askFloor = sortedAsks[floorIdx] || 0;

    // Bid ceiling = top percentile of bid prices
    const sortedBids = [...this.bidPrices].sort((a, b) => b - a);
    const ceilIdx = Math.floor(sortedBids.length * config.COMPETITOR_FLOOR_PERCENTILE);
    this.bidCeiling = sortedBids[ceilIdx] || 0;
  }

  getAskFloor() { return this.askFloor; }
  getBidCeiling() { return this.bidCeiling; }
  getUndercutStep() { return this.undercutStep; }

  getStats() {
    return {
      askFloor: this.askFloor.toFixed(2),
      bidCeiling: this.bidCeiling.toFixed(2),
      undercutStep: this.undercutStep.toFixed(4),
      samples: this.askPrices.length,
    };
  }
}

module.exports = { CompetitorTracker };
