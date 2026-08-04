# Troubleshooting

Start every investigation the same way:

```bash
robinhood-volume-alerts doctor
```

It checks the RPC, log scanning, the database, the Telegram token, and the channel permission, and it exits non-zero if anything is broken. Each section below maps a symptom to its cause; every one of these has happened to a real deployment.

## The channel stays empty but direct messages work

**Cause:** the bot is in the channel but cannot post. This is the single most common deployment gap, and it is subtle: promoting a bot to administrator does NOT enable posting unless "Post Messages" was toggled on at promotion time.

**Fix:** open the channel's settings, Administrators, tap the bot's existing admin entry, and enable **Post Messages**. Do not remove and re-add the bot; edit the existing entry. Delivery self-heals on the next alert, no restart needed.

`doctor` names this state precisely: `bot is admin but "Post Messages" is toggled OFF`.

## No alerts at all, log shows trades flowing

**Likely causes, in order:**

1. **Still backfilling.** The first minutes after start are baseline seeding; wait for `backfill caught up to chain head, detection is live`.
2. **Thresholds too strict for current market conditions.** Try the loose dry run: `hood-alerts dry-run --minutes 5 --spike 3 --vol 500 --swaps 3`. If that prints cards, your chat settings are the filter; open `/start` and step them down.
3. **Paused.** `/settings` shows the paused state at the top.
4. **All alert types toggled off.** Check `/alerts`.

## Log repeats `ingest tick failed, range will be retried`

**Transient RPC errors are normal** and self-heal: the cursor never advances past an undelivered range, so nothing is lost.

If the same range repeats for minutes and the message mentions a result limit, you are on an RPC that caps `eth_getLogs` results differently than the public endpoint. The bot splits ranges automatically on the standard cap message; a nonstandard message from a third-party RPC may not be recognized. Open an issue with the exact error text, and use the public RPC in the meantime.

## `getLogs without an address filter rejected`

Your `RPC_URL` points at a provider that requires address filters on log queries. The chain-wide scan is the core of the design and cannot work there. Use the public Robinhood Chain RPC or any provider that allows topic-only queries; `doctor` verifies this exact capability.

## `chain id is X, expected 4663`

The RPC URL points at a different network. This bot is for Robinhood Chain mainnet only.

## Prices or liquidity read as $0, ETH-quoted pools missing

The ETH/USD price source is temporarily unreachable. The bot falls back from the Blockscout API to an on-chain pool price, and keeps the last known value across brief outages; USDG-quoted pools are unaffected throughout. If it persists, check general connectivity from the host.

## `database: ... unable to open database file`

`DB_PATH` points somewhere the process cannot create or write. Create the directory and fix ownership, or in Docker make sure the volume is mounted over `/app/data` (a recreated container without the volume also explains suddenly missing settings).

## Bot stops when I close the terminal

You ran it in the foreground. Run it under a supervisor so it survives logouts and reboots; both recipes are in [self-hosting](self-hosting.md).

## A user reports the bot went silent for them

They may have blocked the bot and come back: when Telegram rejects delivery, the bot pauses that chat rather than erroring forever. `/resume` turns it back on.

## Something else

Run with `LOG_LEVEL=debug`, reproduce, and open an issue at [github.com/nirholas/robinhood-volume-alerts/issues](https://github.com/nirholas/robinhood-volume-alerts/issues) with the log excerpt and your `doctor` output. Both are safe to paste; neither contains your token.
