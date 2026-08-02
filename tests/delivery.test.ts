import { describe, expect, it } from 'vitest'
import { SETTING_DEFAULTS, loadConfig } from '../src/config.js'
import { Store } from '../src/db.js'
import { makeTimestampInterpolator } from '../src/chain/ingest.js'
import type { Alert, MarketContext } from '../src/engine/events.js'
import { TelegramAlertBot } from '../src/telegram/bot.js'

const context: MarketContext = {
  priceUsd: 0.0262,
  mcapUsd: null,
  liquidityUsd: null,
  holders: null,
  devSold: null,
  ageS: 120,
  launchpad: 'odyssey',
  d1m: 1.4,
  d5m: null,
  d1h: null,
}

const spike: Alert = {
  kind: 'spike',
  token: '0x39dbed3a2bd333467115de45665cc57f813c4571',
  symbol: 'PONS',
  name: 'Pons',
  at: 1_780_000_000,
  context,
  multiple: 6.2,
  volumeUsd: 5800,
  baselinePerMin: 931,
  swaps: 29,
  swapsMultiple: 5.3,
  buys: 14,
  sells: 15,
}

function makeBot(store: Store): TelegramAlertBot {
  // grammY's Bot constructor performs no network I/O, so eligibility rules
  // are testable offline with a syntactically valid token.
  return new TelegramAlertBot('123456:TEST-token', store, { ...loadConfig({}), defaults: SETTING_DEFAULTS })
}

describe('delivery eligibility', () => {
  it('applies per-chat spike thresholds', () => {
    const store = new Store(':memory:', SETTING_DEFAULTS)
    const bot = makeBot(store)
    const chat = store.getChat('7')

    expect(bot.eligible(chat, spike)).toBe(true)
    expect(bot.eligible({ ...chat, spikeX: 10 }, spike)).toBe(false)
    expect(bot.eligible({ ...chat, minVolumeUsd: 10_000 }, spike)).toBe(false)
    expect(bot.eligible({ ...chat, minSwaps: 50 }, spike)).toBe(false)
    expect(bot.eligible({ ...chat, paused: true }, spike)).toBe(false)
    store.close()
  })

  it('respects the alert-type toggles', () => {
    const store = new Store(':memory:', SETTING_DEFAULTS)
    const bot = makeBot(store)
    const chat = store.getChat('7')

    expect(bot.eligible({ ...chat, kinds: ['whale'] }, spike)).toBe(false)
    expect(bot.eligible({ ...chat, kinds: ['spike'] }, spike)).toBe(true)
    store.close()
  })

  it('gates young tokens behind the new-tokens toggle', () => {
    const store = new Store(':memory:', SETTING_DEFAULTS)
    const bot = makeBot(store)
    const chat = store.getChat('7')

    expect(bot.eligible({ ...chat, newTokens: false }, spike)).toBe(false)
    expect(bot.eligible({ ...chat, newTokens: false }, { ...spike, context: { ...context, ageS: 7200 } })).toBe(true)
    // Unknown age is not treated as new.
    expect(bot.eligible({ ...chat, newTokens: false }, { ...spike, context: { ...context, ageS: null } })).toBe(true)
    store.close()
  })

  it('honors mutes and per-kind cooldowns', () => {
    const store = new Store(':memory:', SETTING_DEFAULTS)
    const bot = makeBot(store)
    const chat = store.getChat('7')

    store.mute('7', spike.token)
    expect(bot.eligible(chat, spike)).toBe(false)
    store.unmute('7', spike.token)

    store.setLastAlert('7', 'spike', spike.token, spike.at - 60)
    expect(bot.eligible(chat, spike)).toBe(false)
    // A different kind has its own cooldown.
    const whale: Alert = {
      ...spike,
      kind: 'whale',
      usd: 9000,
      side: 'buy',
      trader: '0x1',
      txHash: '0x2',
      venue: 'uniswap-v3',
    }
    expect(bot.eligible(chat, whale)).toBe(true)

    store.setLastAlert('7', 'spike', spike.token, spike.at - 31 * 60)
    expect(bot.eligible(chat, spike)).toBe(true)
    store.close()
  })

  it('lets a watched token bypass the spike thresholds', () => {
    const store = new Store(':memory:', SETTING_DEFAULTS)
    const bot = makeBot(store)
    const strict = { ...store.getChat('7'), spikeX: 50, minVolumeUsd: 1_000_000, minSwaps: 500 }

    expect(bot.eligible(strict, spike)).toBe(false)
    store.addWatch('7', 'token', spike.token, 'my bag')
    expect(bot.eligible(strict, spike)).toBe(true)
    store.close()
  })

  it('applies the whale, price-move and rug thresholds per kind', () => {
    const store = new Store(':memory:', SETTING_DEFAULTS)
    const bot = makeBot(store)
    const chat = store.getChat('7')

    const whale: Alert = {
      ...spike,
      kind: 'whale',
      usd: 3000,
      side: 'buy',
      trader: '0x1',
      txHash: '0x2',
      venue: 'uniswap-v3',
    }
    expect(bot.eligible(chat, whale)).toBe(false) // default floor is $5k
    expect(bot.eligible({ ...chat, whaleMinUsd: 2500 }, whale)).toBe(true)

    const move: Alert = { ...spike, kind: 'price_move', pct: -12, windowMinutes: 5, fromUsd: 1, toUsd: 0.88 }
    expect(bot.eligible(chat, move)).toBe(false) // default is 25%
    expect(bot.eligible({ ...chat, priceMovePct: 10 }, move)).toBe(true)

    const rug: Alert = { ...spike, kind: 'liquidity_pull', droppedPct: 30, beforeUsd: 100, afterUsd: 70 }
    expect(bot.eligible(chat, rug)).toBe(false) // default is 40%
    expect(bot.eligible({ ...chat, rugDropPct: 25 }, rug)).toBe(true)
    store.close()
  })
})

describe('timestamp interpolation', () => {
  it('maps block numbers linearly across a chunk', () => {
    const tsOf = makeTimestampInterpolator(1000n, 50_000, 2000n, 50_100)
    expect(tsOf(1000n)).toBe(50_000)
    expect(tsOf(2000n)).toBe(50_100)
    expect(tsOf(1500n)).toBe(50_050)
  })

  it('handles single-block chunks', () => {
    const tsOf = makeTimestampInterpolator(5n, 123, 5n, 123)
    expect(tsOf(5n)).toBe(123)
  })
})
