# Architecture

One process, four layers, one SQLite file. Everything below runs inside `startApp()` in [`src/index.ts`](../src/index.ts); the CLI and the daemon are the same code path.

```
      Robinhood Chain RPC (public, chain id 4663)
                    |
        1. INGEST   |  chain-wide Swap + curve Traded logs, gap-fill cursor
                    v
      +---------------------------+
      | rolling windows (memory)  |----> minute buckets (SQLite)
      +---------------------------+
                    |
        2. DETECT   |  every 15s: spikes, price moves
                    |  every trade: whales, watched wallets
                    |  every 60s: liquidity pulls, performance milestones
                    |  event-driven: launches, graduations
                    v
        3. ENRICH   |  mcap, liquidity, holders, dev-sold, age (cached)
                    v
        4. DELIVER  |  per-chat gates -> Telegram cards + channel feed
                    |  delivered spikes -> performance trackers
```

## 1. Ingest

A block cursor walks the chain reading two event families per range:

- **Every v3-style `Swap`** via a topic-only `eth_getLogs` with no address filter, so canonical Uniswap v3 pools and every fork are covered the moment they trade.
- **The Odyssey launchpad's bonding-curve `Traded` events** by factory address.

Each swap is normalized to USD through its pool's quote side: USDG directly, WETH through a live ETH price (Blockscout API with an on-chain pool-price fallback). Pool classification and token metadata are cached in memory and SQLite so the RPC is not asked twice.

Two hard-won robustness rules live here:

- **The cursor only advances after a range is fully delivered.** A dropped connection replays the range instead of losing trades.
- **Result-cap errors split the range.** The public RPC caps `eth_getLogs` at 10,000 results; a busy chunk that trips the cap is split in half and retried recursively, and the running chunk size shrinks (then grows back on success). Without this the cursor wedges forever on the same busy range.

Logs carry no timestamps, so block timestamps are read at each range's boundaries and interpolated linearly inside it.

## 2. Detect

- **Spikes**: per-token rolling 60-second windows in memory, closed minutes flushed to SQLite. The baseline is a trimmed mean of the trailing hour's minute volumes (top 20% dropped, so an earlier spike does not mask the next one), floored to avoid dust division. Evaluated every 15 seconds against the loosest thresholds held by any subscriber; per-chat gating happens later, at delivery.
- **Whales and watched wallets**: checked inline on every live trade against a hot set refreshed from SQLite once a minute. Backfilled trades never fire these (an hour-old whale print is not news).
- **Price moves**: latest close versus the close five minutes ago, from the stored buckets.
- **Liquidity pulls**: once a minute, one batched multicall reads the quote-side balance of every recently active token's pools; a sharp drop against the previous sample is the rug signal.
- **Launches and graduations**: event watchers on the NOXA and Odyssey factories. These also write the creator, launchpad, and first-seen facts that every other card's age and dev-sold fields read.
- **Performance**: delivered spike alerts open trackers; a poller reads each token's peak from the minute buckets (zero extra RPC) and emits milestone follow-ups.

## 3. Enrich

Only alerts that survive the cheap gates pay for enrichment: market cap (supply x price), pooled liquidity, holder count (Blockscout), dev-sold flag (creator balance emptied), age, and 1m/5m/1h deltas. Every field degrades to null rather than throwing, so an explorer timeout costs a line on the card, not the alert. Results are cached for 60 seconds.

## 4. Deliver

Each subscriber's own settings decide whether a given alert reaches them: alert-type toggles, thresholds, mutes, watchlist bypass, new-token gate, and a per-type-per-token cooldown. The optional channel feed receives at default sensitivity, minus private alert types (watched wallets, performance follow-ups). Sends are queued with spacing under Telegram's rate limits, and a chat that blocks the bot is paused automatically instead of erroring forever.

## Storage

Single SQLite database (WAL mode): chat settings, watchlists, mutes, minute buckets, pool and token caches, per-kind cooldowns, tracked-alert performance history, and the ingest cursor. Old minute buckets are pruned past the baseline horizon, so the file does not grow without bound.

## Design invariants

- **No mock lane.** The dry run is the production pipeline with a console transport; there is no separate demo code to rot.
- **Detection is cheap, enrichment is paid for by survivors.** Gates run on in-memory aggregates before any network call.
- **Cheap to run.** One core, modest memory, one file on disk; the chain does the heavy lifting.
