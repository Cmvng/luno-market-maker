// src/telegram.js — Alerts
const config = require('./config');

async function send(msg) {
  if (!config.TELEGRAM_BOT_TOKEN || !config.TELEGRAM_CHAT_ID) {
    return;
  }
  try {
    await fetch(`https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: config.TELEGRAM_CHAT_ID,
        text: msg,
        parse_mode: 'HTML',
      }),
    });
  } catch (e) {}
}

module.exports = {
  fill: (side, price, amount, profit) =>
    send(`✅ <b>${side} FILLED</b> ${amount} @ ₦${price}${profit ? ` | P: ₦${profit.toFixed(2)}` : ''}`),
  rotation: (profit, total, count) =>
    send(`🔄 Rotation #${count} | ₦${profit.toFixed(2)} | Total: ₦${total.toFixed(2)}`),
  error: (msg) => send(`🚨 ${msg}`),
  startup: () => send('🚀 <b>V2 Bot Started</b> — Websocket mode'),
  shutdown: (reason) => send(`⛔ <b>Stopped</b>: ${reason}`),
  status: (msg) => send(msg),
};
