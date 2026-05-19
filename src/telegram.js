// src/telegram.js — Telegram Bot Alerts
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

class TelegramBot {
  constructor(token, chatId) {
    this.token = token;
    this.chatId = chatId;
    this.enabled = !!(token && chatId);
    if (!this.enabled) {
      console.log('[TELEGRAM] No token/chatId — alerts disabled. Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID.');
    }
  }

  async send(message) {
    if (!this.enabled) {
      console.log(`[ALERT] ${message}`);
      return;
    }
    try {
      const url = `https://api.telegram.org/bot${this.token}/sendMessage`;
      await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: this.chatId,
          text: message,
          parse_mode: 'HTML',
        }),
      });
    } catch (err) {
      console.error('[TELEGRAM] Failed to send:', err.message);
    }
  }

  async fill(side, pair, price, amount, profit) {
    await this.send(
      `✅ <b>${side} FILLED</b>\n` +
      `Pair: ${pair}\n` +
      `Price: ₦${Number(price).toLocaleString()}\n` +
      `Amount: ${amount}\n` +
      `${profit ? `Profit: ₦${profit.toFixed(2)}` : ''}`
    );
  }

  async stateChange(oldState, newState, reason) {
    const emoji = newState === 'CALM' ? '🟢' : newState === 'CAUTION' ? '🟡' : '🔴';
    await this.send(`${emoji} State: <b>${oldState}</b> → <b>${newState}</b>\n${reason}`);
  }

  async pairSwitch(oldPair, newPair, reason) {
    await this.send(`🔄 Switching: <b>${oldPair}</b> → <b>${newPair}</b>\n${reason}`);
  }

  async error(message) {
    await this.send(`🚨 <b>ERROR</b>\n${message}`);
  }

  async dailySummary(stats) {
    await this.send(
      `📊 <b>DAILY SUMMARY</b>\n` +
      `Rotations: ${stats.rotations}\n` +
      `Total P&L: ₦${stats.totalPnl.toFixed(2)}\n` +
      `Avg per rotation: ₦${stats.avgPnl.toFixed(2)}\n` +
      `Active pair: ${stats.activePair}\n` +
      `Inventory: ${stats.inventoryRatio}`
    );
  }

  async shutdown(reason) {
    await this.send(`⛔ <b>BOT STOPPED</b>\n${reason}`);
  }

  async startup() {
    await this.send(`🚀 <b>BOT STARTED</b>\nMarket maker is now running.`);
  }
}

module.exports = { TelegramBot };
