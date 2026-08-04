# Getting started

From zero to a running bot in about five minutes. If anything fails along the way, `robinhood-volume-alerts doctor` tells you which link in the chain is broken; see [troubleshooting](troubleshooting.md).

## What you need

- Node.js 20 or newer
- A Telegram bot token from [@BotFather](https://t.me/BotFather) (free, takes a minute)

That is the whole list. There are no API keys to buy, no indexer to run, and no database server: the bot reads the public Robinhood Chain RPC directly and stores its state in a single SQLite file.

## 1. Install

```bash
npm install -g robinhood-volume-alerts
```

Or run it from a clone:

```bash
git clone https://github.com/nirholas/robinhood-volume-alerts.git
cd robinhood-volume-alerts
npm install
```

## 2. Create your bot on Telegram

1. Open [@BotFather](https://t.me/BotFather), send `/newbot`, and follow the prompts.
2. Copy the token it gives you (it looks like `1234567890:AAF...`).

## 3. Configure

Create a `.env` in the directory you will run from:

```bash
TELEGRAM_BOT_TOKEN=1234567890:AAF...your-token...
```

That single line is a complete production configuration. Every other setting has a sensible default; see [configuration](configuration.md) for the full list.

## 4. Check the plumbing

```bash
robinhood-volume-alerts doctor
```

You want five `[ ok ]` lines. `doctor` verifies the RPC (reachability, chain id 4663, address-less log scans), the database path, your Telegram token, and, if you configured one, the channel post permission.

## 5. Run

```bash
robinhood-volume-alerts start
```

On first start the bot backfills roughly the last 70 minutes of trades to learn each token's normal volume, then goes live. You will see `backfill caught up to chain head, detection is live` in the log; from that moment it is watching every DEX trade on the chain.

## 6. Subscribe yourself

Open your bot in Telegram and send `/start`. You get the sensitivity panel; the defaults (4x spike, $3K volume floor, 10 swaps) are tuned to be interesting without being noisy. Send `/alerts` to choose which alert types you receive.

## Try it without Telegram

To watch the pipeline work with no token at all:

```bash
robinhood-volume-alerts dry-run --minutes 5 --spike 3 --vol 500 --swaps 3
```

This runs the full live pipeline against mainnet and prints alert cards to your console. Nothing is sent anywhere. Loosening the gates (`--spike 3 --vol 500 --swaps 3`) makes even a quiet market produce output.

## Where to go next

- [Tutorial: your own alert bot in five minutes](../tutorials/01-your-own-bot.md)
- [What each alert type means](alerts.md)
- [Every Telegram command](commands.md)
- [Running it permanently (Docker, systemd)](self-hosting.md)
