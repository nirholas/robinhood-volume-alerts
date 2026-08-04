# Changelog

All notable changes to `robinhood-volume-alerts`. Dates are UTC.

## 0.3.0 (2026-08-04)

### Added

- **Real CLI.** `robinhood-volume-alerts` (alias `hood-alerts`) now has commands instead of only starting the daemon: `start`, `dry-run` (full live pipeline, console output, no Telegram token needed), `doctor`, `version`, `help`.
- **`doctor`.** One command that checks every external dependency and names the broken link: RPC reachability and chain id, address-less log-scan support, database writability, Telegram token validity, and the channel's Post Messages permission (the most common deployment gap). Exits non-zero on failure so it slots into deploy scripts.
- **A complete documentation set.** `docs/` (getting started, configuration, alert types, Telegram commands, CLI, self-hosting, architecture, troubleshooting) and three step-by-step tutorials (your own bot, wallet watching, public channel feed).
- **AI discovery.** `llms.txt`, a generated `llms-full.txt` mirror of all documentation, and `AGENTS.md` with the repo map and invariants for coding agents.

## 0.2.1 (2026-08-04)

### Changed

- Refreshed `tsx` and `nanoid`, corrected a stale lockfile version.

## 0.2.0 (2026-08-02)

### Added

- **Eight alert types**, up from one: volume spikes, whale trades, price moves, liquidity pulls (rug warnings), new launches, graduations, watched-wallet trades, and performance follow-ups. Each is a per-chat toggle (`/alerts`), each threshold has its own dial (`/start`).
- **Watchlists.** `/watch 0xaddress [label]` follows a wallet (every trade it makes) or a token (bypasses your thresholds entirely). `/watching`, `/unwatch`.
- **The scorecard.** Every delivered spike alert opens a 24-hour tracker; crossing 2x/3x/5x/10x/25x/50x/100x sends a follow-up to exactly the chats that got the original call. `/scorecard` reports hit rates over settled calls only.
- **`/top`**: the hour's heaviest tokens by volume with price change.
- **Public channel feed.** `TELEGRAM_CHANNEL_ID` mirrors the feed at default sensitivity, minus private alert kinds.

### Fixed

- **Ingest stall on busy ranges.** The public RPC caps `eth_getLogs` at 10,000 results, and because the cursor only advances after a delivered range, a busy chunk wedged ingest forever. Cap errors now split the range and shrink the running chunk size, which grows back as ranges succeed.
- **Whale alerts on channel-only deployments.** The whale gate fell back to infinity with no registered chats, making whale alerts structurally impossible for a channel-only deployment. It now falls back to configured defaults like every other detector.
- **Flat `1m +0.0%` on price-move cards.** The one-minute delta anchored to the same bucket the current price came from; it now anchors to the minute before the newest bucket.

## 0.1.0 (2026-08-02)

Initial release: chain-wide volume-spike detection for Robinhood Chain with per-chat sensitivity, mutes, cooldowns, and Telegram delivery. Trimmed-mean baselines over the trailing hour, rolling 60-second windows evaluated every 15 seconds, market context (price deltas, mcap, liquidity, holders, age, dev-sold) on every card.
