# Tutorial: run a public channel feed

Mirror the alert feed into a public Telegram channel that anyone can follow, like [t.me/hoodchains](https://t.me/hoodchains). Subscribers of the channel need no interaction with the bot at all; they just follow the channel.

Assumes a running bot ([tutorial 1](01-your-own-bot.md)).

## 1. Create the channel

In Telegram: New Channel, pick a name and a public link (say `@mychainfeed`).

## 2. Add the bot as an administrator, with posting rights

This is the step everyone gets subtly wrong, so read it slowly:

1. Channel settings, **Administrators**, **Add administrator**.
2. Search your bot's username and add it.
3. On the permission screen, make sure **Post Messages** is toggled ON before saving.

If the bot was already an admin, do not remove and re-add it; open its existing admin entry and toggle **Post Messages** on. An admin without that toggle looks fine in the UI and fails on every post.

## 3. Point the bot at the channel

Add one line to your `.env`:

```bash
TELEGRAM_CHANNEL_ID=@mychainfeed
```

Private channels work too: use the numeric `-100...` id instead of the `@name`.

Restart the bot, then verify the whole chain in one command:

```bash
robinhood-volume-alerts doctor
```

You want: `[ ok ] channel: @mychainfeed: administrator with post permission`. Doctor distinguishes every failure state here: not a member, member but not admin, admin without posting rights.

## 4. What the channel receives

The channel gets the feed at **default sensitivity** (4x spike, $3K volume floor, 10 swaps, $5K whales, 25% price moves, 40% rug warnings), with the same per-token cooldowns as any subscriber, and channel-appropriate buttons (chart links, no mute button).

Two alert families never post to channels by design, because they are private to specific users: watched-wallet trades and performance follow-ups.

## 5. Growing it

- Pin a message explaining what each card means; [docs/alerts.md](../docs/alerts.md) is written to be quotable.
- Your channel's history is your track record. The operator's `/scorecard` numbers come from the same alerts the channel saw, which makes honest promotion easy.

## Troubleshooting

Every channel symptom and its exact cause: [docs/troubleshooting.md](../docs/troubleshooting.md). The short version: if the channel is silent, it is the Post Messages toggle, roughly every time.
