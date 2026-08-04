# Agent guide

Orientation for AI coding agents (and fast-moving humans) working in this repository.

## What this is

A Telegram alert bot for Robinhood Chain (EVM, chain id 4663). It ingests every DEX trade on the chain from the public RPC, learns per-token volume baselines, detects eight kinds of market events, and delivers alert cards to Telegram subscribers and an optional public channel. One process, one SQLite file, no external services beyond the RPC and Telegram.

## Map

| Path | What lives there |
| --- | --- |
| `src/index.ts` | `startApp()`: assembles the whole pipeline. The daemon, the CLI, and the dry run all call this one function. |
| `src/cli.ts` | The `robinhood-volume-alerts` / `hood-alerts` binary: `start`, `dry-run`, `doctor`, `version`. |
| `src/config.ts` | Env parsing and the per-chat setting defaults (`SETTING_DEFAULTS`). |
| `src/db.ts` | The single SQLite store: chats, watchlists, mutes, minute buckets, pool/token caches, per-kind cooldowns, tracked-alert performance. |
| `src/chain/` | RPC-facing code: `ingest.ts` (chain-wide log cursor with result-cap splitting), `pools.ts`, `token-meta.ts`, `eth-price.ts`, `launches.ts`, `enrich.ts`. |
| `src/engine/` | Detection: `window.ts` (rolling windows), `baseline.ts` (trimmed mean), `detector.ts` (spikes), `detectors.ts` (whale, wallet, price, liquidity, launchpad), `performance.ts` (milestone tracking), `events.ts` (the `Alert` union every card renders from). |
| `src/telegram/` | grammY bot, keyboards, HTML card renderers (`format.ts`), setting ladders (`settings.ts`). |
| `tests/` | Vitest suites; every detector and store behavior has coverage. |
| `docs/`, `tutorials/` | User-facing documentation. If you change behavior, change these in the same commit. |

## Commands you will need

```bash
npm install           # postinstall applies nothing exotic
npx tsc --noEmit      # strict typecheck, zero errors expected
npx vitest run        # full test suite, all green expected
npm run build         # tsc -> dist/
node dist/src/cli.js doctor    # live check of RPC/Telegram/db wiring
npm run dry-run -- --minutes 5 --spike 3 --vol 500 --swaps 3
                      # full live pipeline, console only, no token needed
```

The dry run is the ground truth. It runs the production pipeline against mainnet with a console transport; if a change survives typecheck, tests, and a dry run that prints real cards, it works.

## Invariants to preserve

1. **The ingest cursor advances only after a range is fully delivered**, and a range that trips the RPC's 10,000-result cap is split and retried. Breaking either wedges ingest permanently on busy ranges.
2. **No mock data anywhere.** The dry run is the demo. Do not introduce sample alerts, fixture feeds, or fake prices.
3. **Detection gates before enrichment.** Cheap in-memory checks decide whether an alert is worth network calls, in that order.
4. **Alert delivery is per-chat gated** (type toggles, thresholds, mutes, watch bypass, per-kind-per-token cooldowns) in `TelegramAlertBot.eligible`. Channel delivery excludes private kinds (`wallet_trade`, `performance`) via `audienceOf`.
5. **Every field on a card degrades to null, never throws.** An explorer timeout costs a line, not the alert.
6. **Schema changes migrate forward in `Store.migrate()`** with additive `ALTER TABLE` guarded by column checks. Existing databases in the wild must keep working.

## Adding an alert type (the common feature request)

1. Add the kind to `ALERT_KINDS` and its interface to the union in `src/engine/events.ts` (labels and descriptions feed the UI automatically).
2. Emit it from a detector in `src/engine/detectors.ts` (or a new file), wired in `src/index.ts`.
3. Render its card in `src/telegram/format.ts` (`renderAlertHtml` switch: the compiler will force the case).
4. Gate it in `TelegramAlertBot.eligible` in `src/telegram/bot.ts`.
5. Cover it in `tests/`, document it in `docs/alerts.md`, verify with a dry run.

## Style

TypeScript strict, ESM, two-space indent, no default exports for internals. Comments explain why, not what. No TODO comments, no placeholder code, no em-dashes in any text. Conventional commit subjects that describe the diff.
