# robinhood-volume-alerts

Telegram bot for Robinhood Chain crypto (chain ID 4663). It watches every DEX
trade on the chain, learns each token's normal per-minute trading volume, and
messages you the moment something breaks pattern: a volume spike, a whale
print, a price run, liquidity leaving a pool, or a wallet on your watchlist
trading. Then it follows every call it made and tells you how it turned out.

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

## What it alerts on

Each type is a toggle in `/alerts`, with its own threshold where that makes
sense, so you can run it as a quiet whale radar or a loud everything-feed.

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

`/watch 0xaddress Label` follows a wallet or a token; the bot works out which
from what it already knows and you can force it with `/watch wallet 0x…` or
`/watch token 0x…`. A watched **wallet** reports every trade it makes. A
watched **token** bypasses your spike, volume, and swap thresholds entirely,
so a coin you hold always reaches you even when your global settings are
strict.

### The scorecard

Every volume-spike alert opens a tracker that follows the token's price for
24 hours from the stored minute buckets, at no extra RPC cost. When a call
crosses 2×, 3×, 5×, 10× and up, the follow-up goes to exactly the chats that
got the original alert. `/scorecard` then reports the record: how many calls
reached each multiple, the median peak, and the best one.

Hit rates count **settled** calls only (closed after 24 hours or written off
once the token trades 75% below the alert price), so a call still in flight
can never flatter the numbers.

`/top` ranks the hour's heaviest tokens by volume with their price change,
straight from the same buckets.

## How detection works

1. **Ingest.** A gap-fill block cursor scans every v3-style `Swap` event on
   the chain (no address filter, so canonical Uniswap v3 pools and forks are
   covered the moment they trade) plus The Odyssey launchpad's bonding-curve
   `Traded` events. Each trade is normalized to USD through its pool's quote
   side (USDG directly, WETH via the live ETH price). A dropped connection
   re-reads the missed range instead of losing trades, and a range that trips
   the RPC's 10,000-log result cap is split in half and retried rather than
   stalling the cursor.
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
4. **Deliver.** Each subscriber's own alert-type toggles, thresholds, mutes,
   watchlist, and per-type-per-token cooldown (default 30 minutes) decide
   whether an alert reaches them.
5. **Follow up.** Delivered spike alerts open a performance tracker, which
   turns into 2×/5×/10× follow-ups and the `/scorecard` record.

The other detectors run off the same stream: single trades above the whale
floor and watched-wallet trades are matched inline; price moves are computed
on the same 15-second tick; and a once-a-minute batched multicall reads the
quote-side balance of every active token's pools to catch liquidity leaving.

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
| `/start` | Sensitivity panel (spike multiple, volume floor, swap floor, whale floor, price-move and rug thresholds, new-token toggle) |
| `/alerts` | Turn each alert type on or off |
| `/settings` | Status panel: sensitivity, watchlist, mutes, pause/resume |
| `/watch` `/unwatch` `/watching` | Manage your wallet and token watchlist |
| `/top` | The hour's heaviest tokens by volume, with price change |
| `/scorecard` | How the bot's own alerts have performed |
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
- **Whale**: $1K → $2.5K → $5K → $10K → $25K → $50K (single-trade floor)
- **Price move**: 10% → 15% → 25% → 40% → 60% → 100% over five minutes
- **Rug drop**: 25% → 40% → 60% → 80% liquidity loss

Every alert carries mute and watch buttons for its token. Mutes are per chat
and permanent until unmuted.

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
              token metadata, launch history, alert-time enrichment
src/engine/   rolling windows + minute buckets, baseline math, spike detector,
              whale/price/liquidity/wallet detectors, performance tracker,
              the alert union every card renders from
src/telegram/ grammY bot, keyboards, HTML card renderers
src/db.ts     SQLite store (chats, watches, mutes, buckets, pools, tokens,
              cooldowns, tracked alerts)
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
