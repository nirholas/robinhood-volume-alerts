# Telegram command reference

Every command works in a direct chat with the bot. Settings are per chat, stored server-side, and survive restarts.

## Setup

| Command | What it does |
| --- | --- |
| `/start` | The sensitivity panel. Tap any value to step it up its ladder; it wraps at the top. Covers the spike multiple, volume floor, swap floor, new-token toggle, whale floor, price-move threshold, and rug threshold. |
| `/alerts` | Toggle each of the eight alert types on or off. Defaults: everything on except new launches. |
| `/settings` | Status overview: paused state, current sensitivity, alert types on, watchlist and mute counts, plus buttons to every other panel. |

## Watchlists

| Command | What it does |
| --- | --- |
| `/watch 0xaddress [label]` | Follow a wallet or token. The bot infers which from what it has seen on chain; force it with `/watch wallet 0x...` or `/watch token 0x...`. A watched wallet reports every trade it makes. A watched token bypasses your thresholds entirely. |
| `/unwatch 0xaddress` | Stop following an address. |
| `/watching` | Your watchlist, with one-tap remove buttons. |

## Market

| Command | What it does |
| --- | --- |
| `/top` | The hour's heaviest tokens by traded volume, with swap counts and price change. |
| `/scorecard` | How the bot's own calls performed over the last 7 days: how many tracked calls reached 2x, 5x, 10x, the median peak, and the best call. Counts settled calls only. |

## Flow control

| Command | What it does |
| --- | --- |
| `/pause` | Stop alerts without losing any settings. |
| `/resume` | Start them again. |
| `/muted` | List muted tokens with unmute buttons. |
| `/help` | Command summary inside Telegram. |

## Buttons on alert cards

Every alert card carries:
- **DexScreener** and **Chart** links for the token
- **Watch** to add the token to your watchlist (hidden if already watched)
- **Mute this token** to silence it for you across all alert types
