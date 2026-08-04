# Tutorial: your own alert bot in five minutes

By the end you will have your own private Telegram bot messaging you when anything on Robinhood Chain breaks pattern. No servers required for this tutorial; a laptop is fine (see [self-hosting](../docs/self-hosting.md) when you want it permanent).

## 1. Get a bot token (1 minute)

1. Open [@BotFather](https://t.me/BotFather) in Telegram.
2. Send `/newbot`.
3. Pick a display name (anything) and a username (must end in `bot`, e.g. `mychainalerts_bot`).
4. Copy the token from the reply. It looks like `8123456789:AAG...`.

Treat the token like a password; anyone holding it controls your bot.

## 2. Install and configure (2 minutes)

```bash
npm install -g robinhood-volume-alerts
mkdir my-alerts && cd my-alerts
printf 'TELEGRAM_BOT_TOKEN=8123456789:AAG...your token...\n' > .env
```

## 3. Verify before you run (30 seconds)

```bash
robinhood-volume-alerts doctor
```

Expected: four `[ ok ]` lines and one `warn` you can ignore (no channel configured). If the telegram line fails, the token was pasted wrong.

## 4. Start it (30 seconds)

```bash
robinhood-volume-alerts start
```

Watch the log for two lines: `telegram bot online`, then a minute or so later `backfill caught up to chain head, detection is live`. The bot spent that minute learning what "normal" volume looks like for every token that traded in the last hour.

## 5. Subscribe and tune (1 minute)

In Telegram, open your bot and send `/start`.

You get a keyboard of tappable settings. Two tuning philosophies:

- **Quiet and high-conviction:** step Spike up to 7x or 10x and Volume to $10K. You will hear only about genuinely unusual moves.
- **See everything:** step Spike down to 2x or 3x and Volume to $500. Expect a busy phone in an active market.

Then send `/alerts` and choose your alert types. A good starting set is the default: spikes, whales, price moves, rug warnings, graduations, and performance follow-ups on, launches off.

## 6. Prove it end to end

An alert will arrive when the market produces one. If you would rather not wait, loosen your settings for a few minutes (Spike 2x, Volume $500, Swaps 5) and step them back up after the first card lands.

Each card shows the spike multiple, price with 1m/5m/1h moves, buys versus sells, market cap, liquidity, holders, age, platform, and a dev-sold warning when the creator wallet emptied, plus DexScreener and explorer links and a mute button.

## Where to go from here

- [Watch a specific wallet](02-watch-a-wallet.md), and get pinged on its every trade.
- [Run a public channel feed](03-public-channel.md) your community can follow.
- [Keep it running forever](../docs/self-hosting.md) with Docker or systemd.
