# robinhood-volume-alerts

[![npm version](https://img.shields.io/npm/v/robinhood-volume-alerts.svg)](https://www.npmjs.com/package/robinhood-volume-alerts)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![node >= 20](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](package.json)
[![live bot](https://img.shields.io/badge/live-%40hoodcryptochainbot-229ED9.svg)](https://t.me/hoodcryptochainbot)
[![public feed](https://img.shields.io/badge/feed-%40hoodchains-229ED9.svg)](https://t.me/hoodchains)

Real-time trading alerts for **Robinhood Chain** (chain id 4663), delivered to Telegram. The bot watches every DEX trade on the chain, learns each token's normal per-minute volume, and messages you the moment something breaks pattern: a volume spike, a whale print, a price run, liquidity leaving a pool, a launch, a graduation, or a wallet on your watchlist trading. Then it follows every call it made and tells you how it turned out.

```
🔥 PONS Pons
6.2× volume · $5.8K in 1m vs $931.61/min normal · Robinhood

  Price $0.0262  1m +1.4%  5m +1.3%  1h +3.9%
  Swaps 29 (5.3× normal)  buys 14 / sells 15
  MCap $26.18M  Liquidity $1.05M  Holders 21,784
  Age 17.7h  Platform NOXA
⚠️ dev sold
0x39dbed3a2bd333467115de45665cc57f813c4571
Scan · DexScreener · Chart
```

Everything is on-chain data read live from the public Robinhood Chain RPC. **No API keys to buy, no indexer to run**: one Node process, one SQLite file, one Telegram token. Try it without installing anything: [@hoodcryptochainbot](https://t.me/hoodcryptochainbot) is this exact code running live, with the public feed at [@hoodchains](https://t.me/hoodchains).

## Quickstart

```bash
npm install -g robinhood-volume-alerts

# 1. Get a token: message @BotFather on Telegram, /newbot, copy the token.
printf 'TELEGRAM_BOT_TOKEN=paste-it-here\n' > .env

# 2. Verify the plumbing, then run.
robinhood-volume-alerts doctor
robinhood-volume-alerts start
```

Open your bot in Telegram and send `/start`. Alerts begin as soon as the startup backfill catches up to the chain head, about a minute. Full walkthrough: [Getting started](docs/getting-started.md).

**No Telegram token yet?** Watch the real pipeline run against live mainnet with console output only:

```bash
robinhood-volume-alerts dry-run --minutes 5 --spike 3 --vol 500 --swaps 3
```

## Documentation

| | |
| --- | --- |
| [Getting started](docs/getting-started.md) | Zero to a running bot in five minutes. |
| [Alert types](docs/alerts.md) | All eight alert kinds, every threshold, the dedup rules. |
| [Telegram commands](docs/commands.md) | Complete command reference. |
| [CLI reference](docs/cli.md) | `start`, `dry-run`, `doctor`, exit codes. |
| [Configuration](docs/configuration.md) | Every environment variable and its default. |
| [Self-hosting](docs/self-hosting.md) | Docker, systemd, backups, updating. |
| [Architecture](docs/architecture.md) | How ingest, detection, enrichment, and delivery fit together. |
| [Troubleshooting](docs/troubleshooting.md) | Symptom to cause, fast. |

Tutorials: [your own bot in five minutes](tutorials/01-your-own-bot.md) · [watch a wallet](tutorials/02-watch-a-wallet.md) · [run a public channel feed](tutorials/03-public-channel.md)

For AI agents: [AGENTS.md](AGENTS.md) has the repo map and invariants, [llms.txt](llms.txt) the doc index, [llms-full.txt](llms-full.txt) the whole documentation in one file.

## What it alerts on

Each type is a toggle in `/alerts`, with its own threshold where that makes sense, so you can run it as a quiet whale radar or a loud everything-feed.

| Type | Fires when |
|---|---|
| **Volume spikes** | a token trades a multiple of its own learned normal minute |
| **Whale trades** | one trade lands above your dollar floor |
| **Price moves** | a token moves past your percent threshold in five minutes |
| **Rug warnings** | pooled liquidity drops sharply, the early warning before the price does |
| **New launches** | a token launches on NOXA or The Odyssey |
| **Graduations** | an Odyssey curve fills and liquidity migrates to a locked pool |
| **Watched wallets** | any wallet on your watchlist trades |
| **Alert follow-ups** | a token you were alerted on hits 2×, 5×, 10× and beyond |

### Watchlists

`/watch 0xaddress Label` follows a wallet or a token; the bot works out which from what it already knows, and you can force it with `/watch wallet 0x...` or `/watch token 0x...`. A watched **wallet** reports every trade it makes. A watched **token** bypasses your thresholds entirely, so a coin you hold always reaches you even when your global settings are strict.

### The scorecard

Every volume-spike alert opens a tracker that follows the token's price for 24 hours from the stored minute buckets, at no extra RPC cost. When a call crosses 2×, 3×, 5×, 10× and up, the follow-up goes to exactly the chats that got the original alert. `/scorecard` then reports the record: how many calls reached each multiple, the median peak, and the best one.

Hit rates count **settled** calls only (closed after 24 hours or written off once the token trades 75% below the alert price), so a call still in flight can never flatter the numbers.

`/top` ranks the hour's heaviest tokens by volume with their price change, straight from the same buckets.

## How detection works

1. **Ingest.** A gap-fill block cursor scans every v3-style `Swap` event on the chain (no address filter, so canonical Uniswap v3 pools and forks are covered the moment they trade) plus The Odyssey launchpad's bonding-curve `Traded` events. Each trade is normalized to USD through its pool's quote side (USDG directly, WETH via the live ETH price). A dropped connection re-reads the missed range instead of losing trades, and a range that trips the RPC's 10,000-log result cap is split in half and retried rather than stalling the cursor.
2. **Learn.** Trades aggregate into per-token one-minute buckets in SQLite. A token's "normal minute" is the trimmed mean (loudest 20% of minutes dropped) of its trailing hour, missing minutes counted as zero, floored so quiet tokens cannot divide dust into infinite multiples. The trim matters: without it, one spike inflates "normal" and masks the next one.
3. **Detect.** Every 15 seconds the rolling last-60s window of each active token is compared against its baseline. Whales and watched wallets are matched inline on every live trade; a once-a-minute batched multicall reads pooled liquidity to catch rugs.
4. **Enrich.** Survivors get market cap, pooled liquidity, holder count, age, platform, and a dev-sold flag. Every field degrades to null instead of failing the alert.
5. **Deliver.** Each subscriber's own toggles, thresholds, mutes, watchlist, and per-type-per-token cooldown (default 30 minutes) decide whether an alert reaches them. Delivered spikes open performance trackers.

The deeper tour, including the design invariants: [docs/architecture.md](docs/architecture.md).

## The CLI

```
robinhood-volume-alerts <command>     (alias: hood-alerts)

  start      run the bot
  dry-run    full live pipeline, console output, no Telegram needed
  doctor     check RPC, chain id, log scans, database, token, channel rights
  version    print the version
```

`doctor` deserves a special mention: every check in it exists because that exact failure happened to a real deployment, including the subtle one where the bot is a channel admin but "Post Messages" is toggled off. It exits non-zero on failure, so `doctor && start` is a self-verifying deploy.

## Development

```bash
git clone https://github.com/nirholas/robinhood-volume-alerts.git
cd robinhood-volume-alerts && npm install

npm run typecheck   # strict TS, zero errors
npm test            # vitest: detectors, baselines, cards, gating, store
npm run dry-run     # live end-to-end verification against mainnet
```

The pipeline is deliberately layered so each piece is testable alone:

```
src/chain/    ingest (chain-wide log cursor), pool classifier, ETH price,
              token metadata, launch history, alert-time enrichment
src/engine/   rolling windows + minute buckets, baseline math, spike detector,
              whale/price/liquidity/wallet detectors, performance tracker,
              the alert union every card renders from
src/telegram/ grammY bot, keyboards, HTML card renderers
src/db.ts     SQLite store (chats, watches, mutes, buckets, pools, tokens,
              cooldowns, tracked alerts)
```

Contributions welcome; the bar and the invariants are in [CONTRIBUTING.md](CONTRIBUTING.md).

Built on [hoodchain](https://www.npmjs.com/package/hoodchain) (verified chain constants, launchpad ABIs) and [hoodkit](https://www.npmjs.com/package/hoodkit) (pool metadata, swap decoding) from the same ecosystem:

- [robinhood-toolkit](https://github.com/nirholas/robinhood-toolkit): network constants, docs, 64 build prompts
- [learn-robinhood-chain](https://github.com/nirholas/learn-robinhood-chain): tutorials from first RPC read to autonomous agents

## Scope

Robinhood Chain crypto only: memecoins and tokens trading on the chain's DEXes and launchpads. Nothing here touches brokerage products.

## License

MIT
