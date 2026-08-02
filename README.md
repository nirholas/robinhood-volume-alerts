# robinhood-volume-alerts

Telegram bot for Robinhood Chain crypto (chain ID 4663). It watches every DEX
trade on the chain, learns each token's normal per-minute trading volume, and
messages you the moment a token trades a multiple of its own normal, with
price, market cap, liquidity, and holder context in the alert.

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

Everything is on-chain data read live from the public Robinhood Chain RPC.
There are no API keys to buy and no indexer to run: one Node process, one
SQLite file, one Telegram token.

## How detection works

1. **Ingest.** A gap-fill block cursor scans every v3-style `Swap` event on
   the chain (no address filter, so canonical Uniswap v3 pools and forks are
   covered the moment they trade) plus The Odyssey launchpad's bonding-curve
   `Traded` events. Each trade is normalized to USD through its pool's quote
   side (USDG directly, WETH via the live ETH price). A dropped connection
   re-reads the missed range instead of losing trades.
2. **Learn.** Trades aggregate into per-token one-minute buckets in SQLite.
   A token's "normal minute" is the trimmed mean (loudest 20% of minutes
   dropped) of its trailing hour, missing minutes counted as zero, floored so
   quiet tokens cannot divide dust into infinite multiples. The trim matters:
   without it, one spike inflates "normal" and masks the next one.
3. **Detect.** Every 15 seconds the rolling last-60s window of each active
   token is compared against its baseline. A token that clears the spike
   multiple, the dollar floor, and the swap floor becomes an alert, enriched
   with market cap (supply × price), pooled liquidity, holder count
   (Blockscout), age and platform (launchpad records), and a dev-sold flag
   (launch creator's balance is zero).
4. **Deliver.** Each subscriber's own sensitivity, mutes, new-token toggle,
   and per-token cooldown (default 30 minutes) decide whether that alert
   reaches them.

On startup the ingester backfills the trailing 70 minutes of chain history,
so baselines are warm from the first evaluation instead of an hour later.

## Quickstart

Requires Node 20+.

```bash
git clone https://github.com/nirholas/robinhood-volume-alerts.git
cd robinhood-volume-alerts
npm install

# 1. Create a bot: message @BotFather on Telegram, /newbot, copy the token.
cp .env.example .env    # paste the token into TELEGRAM_BOT_TOKEN

# 2. Run.
npm run dev             # or: npm run build && npm start
```

Open your bot in Telegram and send `/start`. The sensitivity panel appears;
alerts begin as soon as the backfill catches up to the chain head (about a
minute).

### Verify without a Telegram token

The dry run is the full live pipeline with alerts printed to the console
instead of sent, straight from mainnet data:

```bash
npm run dry-run                                    # 10 minutes, default sensitivity
npm run dry-run -- --minutes 5 --spike 2 --vol 200 --swaps 3   # loosened, chattier
```

## Commands

| Command | What it does |
|---|---|
| `/start` | Sensitivity panel (spike multiple, volume floor, swap floor, new-token toggle) |
| `/settings` | Status panel: current sensitivity, pause/resume, muted tokens |
| `/pause` / `/resume` | Stop and restart alerts without losing settings |
| `/muted` | List muted tokens with unmute buttons |
| `/help` | What the bot does and how |

Sensitivity buttons step up on tap and wrap around at the top:

- **Spike**: 2× → 3× → 4× → 5× → 7× → 10× → 15× → 2× (how many times its own
  normal minute the token must trade; 3× is loose, 10× is rare)
- **Volume**: $500 → $1K → $3K → $5K → $10K → $25K → $500 (ignore anything
  smaller than this in the spiking minute)
- **Swaps**: 5 → 10 → 20 → 30 → 50 → 5 (so one whale print alone does not page you)
- **New tokens**: on/off (tokens younger than an hour have thin history and
  wild multiples; off silences them entirely)

Every alert carries a mute button for its token. Mutes are per chat and
permanent until unmuted.

## Configuration

All optional except the bot token. See [.env.example](.env.example).

| Variable | Default | Meaning |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | (none) | Bot token from @BotFather. Without it, console-only mode. |
| `RPC_URL` | public RPC | Custom Robinhood Chain RPC endpoint. |
| `DB_PATH` | `./data/volume-alerts.db` | SQLite file (settings, baselines, mutes). |
| `BASELINE_MINUTES` | `60` | Trailing window the "normal minute" is learned from. |
| `EVAL_INTERVAL_S` | `15` | How often rolling windows are evaluated. |
| `COOLDOWN_MINUTES` | `30` | Per-chat, per-token minimum gap between alerts. |
| `BACKFILL_MINUTES` | `70` | History backfilled at startup to warm baselines. |
| `LOG_LEVEL` | `info` | pino level. |

## Deploy

Any always-on Node host works. With Docker:

```bash
docker build -t robinhood-volume-alerts .
docker run -d --restart unless-stopped \
  -e TELEGRAM_BOT_TOKEN=123456:ABC... \
  -v rva-data:/app/data \
  robinhood-volume-alerts
```

The bot uses long polling (no inbound webhook), so it runs anywhere with
outbound HTTPS: a $5 VPS, Cloud Run with CPU always allocated, a Raspberry
Pi.

## Development

```bash
npm run typecheck   # strict TS, no emit
npm test            # vitest: baseline math, rolling windows, cards, gating, store
npm run dry-run     # live end-to-end verification against mainnet
```

The pipeline is deliberately layered so each piece is testable alone:

```
src/chain/    ingest (chain-wide log cursor), pool classifier, ETH price,
              token metadata, launchpad tracker, alert-time enrichment
src/engine/   rolling windows + minute buckets, baseline math, spike detector
src/telegram/ grammY bot, sensitivity keyboard, HTML card renderer
src/db.ts     SQLite store (chats, mutes, buckets, pools, tokens, cooldowns)
```

Built on [hoodchain](https://www.npmjs.com/package/hoodchain) (verified chain
constants, launchpad ABIs) and [hoodkit](https://www.npmjs.com/package/hoodkit)
(pool metadata, swap decoding) from the same ecosystem:

- [robinhood-toolkit](https://github.com/nirholas/robinhood-toolkit): network
  constants, docs, 64 build prompts
- [robinhood-chain-alert-bot](https://github.com/nirholas/robinhood-chain-alert-bot):
  launches, graduations, whale trades, rug warnings (a different beat: this
  repo is only about volume spikes)
- [learn-robinhood-chain](https://github.com/nirholas/learn-robinhood-chain):
  tutorials from first RPC read to autonomous agents

## Scope

Robinhood Chain crypto only: memecoins and tokens trading on the chain's
DEXes and launchpads. Nothing here touches brokerage products.

## License

MIT
