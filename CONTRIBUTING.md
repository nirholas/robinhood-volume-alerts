# Contributing

Contributions are welcome. This document is short because the codebase is small and the standards are simple: everything real, everything verified.

## Setting up

```bash
git clone https://github.com/nirholas/robinhood-volume-alerts.git
cd robinhood-volume-alerts
npm install
npx tsc --noEmit && npx vitest run   # both must be clean before you start
```

You do not need a Telegram token to develop. The dry run exercises the entire pipeline against live mainnet with console output:

```bash
npm run dry-run -- --minutes 5 --spike 3 --vol 500 --swaps 3
```

## The bar for a change

1. **Strict typecheck passes.** `npx tsc --noEmit`, zero errors.
2. **All tests pass, and behavior changes come with tests.** `npx vitest run`. Every detector, store method, and delivery rule has coverage; keep it that way.
3. **A dry run produces real cards** if your change touches the pipeline. This is the no-mocks rule in action: the demo path IS the production path.
4. **Docs move with behavior.** If you change what users see (an alert card, a command, a threshold), update `docs/` and, when relevant, `CHANGELOG.md` in the same commit, then run `node scripts/build-llms.mjs` to regenerate `llms-full.txt`.
5. **Commit subjects describe the diff** in plain language: `fix(ingest): split ranges that trip the RPC result cap`. No `wip`, no `update`, no `misc`.

## Invariants you must not break

These are load-bearing and each one was learned the hard way; `AGENTS.md` explains the why behind each:

- The ingest cursor advances only after a range is fully delivered, and result-cap errors split the range.
- No mock data, no fixture feeds, no fake prices, anywhere.
- Detection gates run before enrichment spends network calls.
- Card fields degrade to null instead of throwing.
- Database schema changes migrate forward additively in `Store.migrate()`.

## Reporting bugs

Open an issue with your `robinhood-volume-alerts doctor` output, the log excerpt around the problem (`LOG_LEVEL=debug` helps), and what you expected. Neither doctor output nor logs contain your token.

## Security issues

Do not open a public issue; see [SECURITY.md](SECURITY.md).
