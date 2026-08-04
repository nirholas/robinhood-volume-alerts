# CLI reference

Installing the package globally gives you two identical binaries: `robinhood-volume-alerts` and the shorter `hood-alerts`.

```bash
npm install -g robinhood-volume-alerts
```

## `start`

Runs the bot. Also the default when no command is given.

```bash
hood-alerts start
```

Reads `.env` from the working directory (see [configuration](configuration.md)), backfills roughly the last 70 minutes of trades to seed baselines, then detects live. Stops cleanly on SIGINT/SIGTERM, flushing state to SQLite.

## `dry-run`

The full live pipeline against mainnet with console output only. No Telegram token required, nothing is sent anywhere. This is the honest demo: real trades, real detection, real alert cards, printed to stdout.

```bash
hood-alerts dry-run --minutes 5 --spike 3 --vol 500 --swaps 3
```

| Flag | Default | Meaning |
| --- | --- | --- |
| `--minutes <n>` | 10 | How long to run before exiting. |
| `--spike <x>` | 4 | Spike multiple gate. Lower means chattier. |
| `--vol <usd>` | 3000 | Volume floor in USD. |
| `--swaps <n>` | 10 | Swap-count floor. |

The dry run writes its state to `./data/dry-run.db` (or `DB_PATH` if set) so it never touches a production database.

## `doctor`

Checks every external dependency and reports exactly which link is broken. Each check exists because that failure happened to a real deployment.

```bash
hood-alerts doctor
```

```
[ ok ] rpc: head block 27443443, chain id 4663, 228ms
[ ok ] log scan: address-less getLogs works (5624 logs in the last 200 blocks)
[ ok ] database: ./data/volume-alerts.db (migrations applied, write verified)
[ ok ] telegram: token valid, bot is @yourbotname
[ ok ] channel: @yourchannel: administrator with post permission

Ready. 5 checks, 0 failing, 0 warnings.
```

| Check | Catches |
| --- | --- |
| `rpc` | Endpoint down, wrong chain (id must be 4663), slow responses. |
| `log scan` | RPCs that reject `eth_getLogs` without an address filter, which ingest requires. |
| `database` | Unwritable `DB_PATH`, broken migrations. |
| `telegram` | Missing or revoked bot token. |
| `channel` | The most common gap of all: the bot is a channel admin but "Post Messages" is toggled off, or it is not an admin at all. |

Exit code is 0 when everything passes and 1 otherwise, so it slots into deploy scripts:

```bash
hood-alerts doctor && hood-alerts start
```

## `version`, `help`

```bash
hood-alerts version   # prints the version
hood-alerts help      # prints usage
```
