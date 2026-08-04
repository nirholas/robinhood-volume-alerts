# Alert types

Eight alert types, all reading the same chain-wide trade stream. Each is a toggle in `/alerts`, and the ones with a natural threshold have their own dial in `/start`. Every card carries the same market context block: price with 1m/5m/1h deltas, market cap, pooled liquidity, holder count, token age, launchpad, and a dev-sold warning when the creator wallet has emptied.

## Volume spikes

The flagship signal. The bot learns each token's normal per-minute dollar volume from the trailing hour (a trimmed mean that drops the loudest 20% of minutes, so one earlier spike does not inflate "normal"), then compares the rolling last 60 seconds against it every 15 seconds.

Fires when all three per-chat gates pass:
- volume is at least **spike x** times the learned baseline (ladder: 2, 3, 4, 5, 7, 10, 15; default 4)
- at least **volume floor** dollars traded in the window (ladder: $500 to $25K; default $3K)
- at least **swap floor** individual trades (ladder: 5 to 50; default 10), so one whale print alone does not page you

A sustained spike produces one alert, not one per evaluation; it can re-fire early only by escalating to at least double the multiple it last fired at.

## Whale trades

A single trade above your dollar floor (ladder: $1K, $2.5K, $5K, $10K, $25K, $50K; default $5K). Capped at one whale alert per token per five minutes unless a new print doubles the last one. The card names the trade size, side, venue (Uniswap v3 or the Odyssey curve), trader address, and links the transaction.

## Price moves

A token moving more than your percent threshold in five minutes, up or down (ladder: 10, 15, 25, 40, 60, 100; default 25%). One alert per token per direction per half hour, so a token grinding upward does not repeat itself.

## Rug warnings (liquidity pulls)

The early warning that usually precedes the price collapse. Once a minute the bot reads the quote-side balance of every recently active token's pools in one batched multicall and compares it with the previous sample. A drop past your threshold (ladder: 25, 40, 60, 80; default 40%) on a pool that held at least $2K fires the warning. One per token per hour.

## New launches

A token launching on NOXA or The Odyssey. Off by default because it is the noisiest family; turn it on in `/alerts` if you want to be first. Launch events also feed the age, platform, and dev-sold fields every other card shows.

## Graduations

An Odyssey bonding curve filling and migrating its liquidity into a locked Uniswap v3 pool. Historically the moment a meme coin becomes tradable in size.

## Watched wallets

Every trade made by a wallet on your watchlist, whatever its size. Add wallets with `/watch 0xaddress Label`. These alerts are private to the chats watching that wallet; they never go to the channel feed.

## Performance follow-ups

The accountability layer. Every volume-spike alert you receive opens a tracker that follows the token's peak price for 24 hours using the minute data the bot already stores (no extra RPC). When a call crosses 2x, 3x, 5x, 10x, 25x, 50x, or 100x from its alert price, exactly the chats that received the original alert get the follow-up. Trackers settle after 24 hours, or early if the token trades 75% below the alert price. `/scorecard` reports the aggregate record over settled calls only, so a call still in flight can never flatter the numbers.

## Dedup and fairness rules

- **Cooldowns** are per chat, per alert type, per token (default 30 minutes). A whale alert and a spike alert on the same token can both reach you; two spikes cannot until the cooldown lapses.
- **Watched tokens bypass your thresholds** for spikes, whales, price moves, and rug warnings. A coin you explicitly follow always reaches you, even on strict settings.
- **Muting a token** silences it for you across every alert type until you unmute; every alert card carries a mute button.
- **New tokens** (younger than one hour) can be silenced wholesale with the new-tokens toggle; their thin history makes multiples wild.
