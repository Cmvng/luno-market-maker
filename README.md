# Luno USDT/NGN Market Maker Bot

A market making bot for Luno Nigeria that captures the bid-ask spread on USDT/NGN and BTC/NGN pairs. Built for Railway deployment.

## Features

- **Dual pair support** — trades USDT/NGN primarily, switches to BTC/NGN when USDT spread is tight
- **Top-of-book quoting** — stays first in the order queue by requoting every 4 seconds
- **3 market states** — CALM (normal), CAUTION (widen spread), DANGER (pull all orders)
- **Naira rate monitoring** — tracks rate changes to detect volatility
- **Inventory management** — skews prices to maintain 50/50 NGN/crypto balance
- **Bot war protection** — won't chase spread below minimum profitable threshold
- **Daily loss limit** — auto-stops if losses exceed 5% of capital
- **Telegram alerts** — fill notifications, state changes, daily summary, errors
- **Graceful shutdown** — cancels all orders on stop signal

## Deploy to Railway

### Step 1: Push to GitHub

```bash
git init
git add .
git commit -m "initial commit"
git remote add origin https://github.com/YOUR_USERNAME/luno-market-maker.git
git branch -M main
git push -u origin main
```

### Step 2: Create Railway Project

1. Go to [railway.app](https://railway.app)
2. Click **New Project** → **Deploy from GitHub repo**
3. Select your `luno-market-maker` repo
4. Railway will auto-detect it as a Node.js project

### Step 3: Set Environment Variables

In your Railway project dashboard, go to **Variables** and add:

| Variable | Value |
|---|---|
| `LUNO_API_KEY_ID` | Your Luno API key ID |
| `LUNO_API_SECRET` | Your Luno API secret |
| `TELEGRAM_BOT_TOKEN` | Your Telegram bot token (optional) |
| `TELEGRAM_CHAT_ID` | Your Telegram chat ID (optional) |

### Step 4: Set Service Type

Railway might try to expose a web port. Since this is a worker (no web interface), go to **Settings** → and make sure it uses the `Procfile` which runs `worker: node src/index.js`.

If Railway complains about no port, add a `PORT` variable set to any value (e.g. `3000`) — the bot won't use it but Railway needs it sometimes.

### Step 5: Deploy

Railway auto-deploys on every push to `main`. Check the **Logs** tab to see the bot running.

## Setting Up Telegram Alerts

1. Message [@BotFather](https://t.me/BotFather) on Telegram
2. Send `/newbot` and follow prompts to create a bot
3. Copy the bot token
4. Message your new bot, then visit `https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates`
5. Find your `chat_id` in the response
6. Add both to Railway environment variables

## Configuration

All settings are in `src/config.js`. Key parameters:

| Parameter | Default | Description |
|---|---|---|
| `LOOP_INTERVAL_MS` | 4000 | Main loop speed (milliseconds) |
| `USDT_MIN_SPREAD_NGN` | 1.00 | Minimum spread to trade USDT/NGN |
| `BTC_MIN_SPREAD_PCT` | 0.50 | Minimum spread to trade BTC/NGN |
| `MAX_DAILY_LOSS_PCT` | 5 | Stop bot at 5% daily loss |
| `MAX_ORDER_USDT` | 50 | Maximum order size in USDT |
| `CALM_THRESHOLD_PCT` | 0.3 | Rate change threshold for CALM state |

## Safety Notes

- API key has **Trading access only** — no withdrawals possible
- Bot uses **post-only orders** — never pays taker fees, order cancelled if it would trade immediately
- **Daily loss limit** stops the bot automatically
- **Graceful shutdown** cancels all orders when stopped
- Never share your API keys
- Start with minimum capital to test

## Architecture

See the full architecture document (HTML) for detailed system design including:
- Market state engine
- Multi-pair switching logic
- Inventory management rules
- Naira rate monitoring
- Risk management parameters
