# Tutorial: watch a wallet

Follow any address on Robinhood Chain and get a card for every trade it makes, whatever the size. Useful for tracking a deployer, a whale you respect, or your own second wallet.

This tutorial assumes your bot is already running ([start here](01-your-own-bot.md) if not).

## Add the wallet

In your bot's chat:

```
/watch 0x91563ece922942196d1d265a5656287816a4c4ea Whale Bob
```

The label is optional but worth it; cards read "Whale Bob sold" instead of an address stub. The bot replies confirming what it will do: every trade this wallet makes reaches you, regardless of your thresholds.

You do not have to say whether an address is a wallet or a token; the bot infers it from what it has seen on chain. If it ever guesses wrong, force it:

```
/watch wallet 0x9156...c4ea Whale Bob
/watch token 0x39db...4571 my bag
```

## What arrives

The next time that wallet trades, you get a card within seconds of the block:

- who traded (your label), which side, and the dollar size
- the token, with the full market context block (price and 1m/5m/1h moves, mcap, liquidity, holders, age)
- links to the wallet and the transaction on the explorer

Wallet-trade alerts are private: they go only to the chats watching that wallet, never to any public channel feed the operator runs.

## How the matching works (honesty section)

The bot attributes a trade to the addresses in the swap event itself: the sender and recipient on a Uniswap v3 swap, the trader on an Odyssey curve trade. That catches direct swaps and the common router paths where the watched wallet receives the output. A contraption that routes through an intermediary contract which also receives the output can escape attribution; no event-level tracker can see through that without tracing every transaction.

## Watching tokens instead

`/watch token 0x... label` does something different and equally useful: the token's alerts bypass your spike, volume, swap, whale, price, and rug thresholds entirely. Strict global settings, but your own bags always get through.

## Managing the list

- `/watching` shows everything you follow, with one-tap remove buttons.
- `/unwatch 0x...` removes an address.

There is no hard cap on watchlist size, but every watched wallet is checked against every trade on the chain, so a focused list serves you better than pasting a whale leaderboard.
