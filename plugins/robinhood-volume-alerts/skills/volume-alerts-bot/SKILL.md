---
name: volume-alerts-bot
description: Set up, check and dry-run the robinhood-volume-alerts Telegram bot, which flags Robinhood Chain tokens whose trading volume spikes above their own normal. Use when asked to run or troubleshoot the volume alert bot or preview its alerts from live chain data.
---

# robinhood-volume-alerts

A Telegram bot for Robinhood Chain (chain id 4663). It watches every DEX trade, learns each token's normal per-minute volume, and messages you when a token trades a multiple of that. npm package `robinhood-volume-alerts`, bins `robinhood-volume-alerts` and `hood-alerts`.

## Commands

```
npx -y -p robinhood-volume-alerts robinhood-volume-alerts <command>
```

- `dry-run [--minutes n] [--spike x] [--vol usd] [--swaps n]`: runs the live pipeline and prints alerts to the console. No Telegram token needed and nothing is sent. Defaults: 10 minutes, with spike, volume and swap floors from the bot's own defaults.
- `doctor`: checks RPC reachability and chain id, log-scan support, database writability, the Telegram token and channel post permission, and says what is wrong.
- `start`: runs the bot, reading `.env` from the working directory. This is also the default command.
- `version`, `help`.

## Configuration (environment or `.env`)

- `TELEGRAM_BOT_TOKEN`: from @BotFather. Required for delivery. It is a secret: the user should put it in their own `.env`, never paste it into chat.
- `TELEGRAM_CHANNEL_ID`: optional public channel mirroring the feed (the bot must be a channel admin).
- `RPC_URL`: optional, defaults to the public Robinhood Chain RPC.
- `DB_PATH` (default `./data/volume-alerts.db`), `BASELINE_MINUTES` (60), `EVAL_INTERVAL_S` (15), `COOLDOWN_MINUTES` (30), `BACKFILL_MINUTES` (70), `LOG_LEVEL` (`info`).

## Workflow

1. Run `dry-run --minutes 10` to preview alerts from live data without a token.
2. Run `doctor` and fix whatever it reports.
3. Run `start` only when the user wants the bot running as a long-lived process. It posts to Telegram chats, so confirm with the user first.

## Notes

- The bot only reads chain data and sends Telegram messages. It holds no wallet and moves no funds.
- Alerts are information, not trading advice. Never place trades because of one.
- A Dockerfile is included in the repo for hosting.
