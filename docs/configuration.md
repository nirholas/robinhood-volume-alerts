# Configuration

All configuration is environment based. The bot loads `.env` from the working directory at startup (real environment variables win over `.env` values, standard dotenv semantics). Only one variable is required.

## Variables

| Variable | Default | What it does |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | *(none)* | Bot token from @BotFather. Without it the bot runs in console-only mode: the full pipeline executes and alert cards print to stdout. |
| `TELEGRAM_CHANNEL_ID` | *(none)* | Optional public channel (`@name` or `-100...` id) that mirrors the feed at default sensitivity. The bot must be a channel administrator with "Post Messages" enabled. See [the channel tutorial](../tutorials/03-public-channel.md). |
| `RPC_URL` | Robinhood Chain public RPC | Override the RPC endpoint. Must be Robinhood Chain mainnet (chain id 4663) and must allow `eth_getLogs` without an address filter; `doctor` verifies both. |
| `DB_PATH` | `./data/volume-alerts.db` | SQLite file holding per-chat settings, watchlists, minute buckets, cooldowns, and the alert performance history. Survives restarts; safe to back up while running (WAL mode). |
| `BASELINE_MINUTES` | `60` | How much trailing history the baseline learns from. Longer means steadier baselines that adapt more slowly. |
| `EVAL_INTERVAL_S` | `15` | How often the rolling window is evaluated. |
| `COOLDOWN_MINUTES` | `30` | Per chat, per alert type, per token: after an alert, the same type for the same token stays quiet this long. |
| `BACKFILL_MINUTES` | `70` | How far behind the chain head the first start reads to seed baselines. 70 covers the 60-minute baseline plus the evaluation margin. |
| `LOG_LEVEL` | `info` | pino level: `trace`, `debug`, `info`, `warn`, `error`. |

## Per-user settings live in Telegram, not in env

Everything a subscriber can tune (spike multiple, volume floor, swap floor, whale floor, price-move and rug thresholds, new-token gating, which alert types fire) is set per chat from the inline keyboards (`/start`, `/alerts`) and stored in SQLite. Environment defaults only decide what a chat gets before it touches the keyboard, and what the channel feed uses.

Defaults per fresh chat: spike 4x, volume floor $3,000, swap floor 10, new tokens on, whale floor $5,000, price move 25% in 5 minutes, rug warning at a 40% liquidity drop, every alert type on except new launches (the noisiest family).

## Example `.env`

```bash
# Required for Telegram delivery
TELEGRAM_BOT_TOKEN=1234567890:AAF...

# Optional public feed
TELEGRAM_CHANNEL_ID=@yourchannel

# Optional overrides
# RPC_URL=https://rpc.mainnet.chain.robinhood.com
# DB_PATH=/var/lib/hood-alerts/alerts.db
# LOG_LEVEL=debug
```

A ready-to-copy template ships as [`.env.example`](../.env.example).
