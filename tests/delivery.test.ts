import { describe, expect, it } from 'vitest'
import { SETTING_DEFAULTS, loadConfig } from '../src/config.js'
import { Store } from '../src/db.js'
import type { SpikeAlert } from '../src/engine/detector.js'
import { makeTimestampInterpolator } from '../src/chain/ingest.js'
import { TelegramAlertBot } from '../src/telegram/bot.js'

const alert: SpikeAlert = {
  token: '0x39dbed3a2bd333467115de45665cc57f813c4571',
  symbol: 'PONS',
  name: 'Pons',
  multiple: 6.2,
  volumeUsd: 5800,
  baselinePerMin: 931,
  swaps: 29,
  swapsMultiple: 5.3,
  buys: 14,
  sells: 15,
  priceUsd: 0.0262,
  d1m: 1.4,
  d5m: null,
  d1h: null,
  mcapUsd: null,
  liquidityUsd: null,
  holders: null,
  devSold: null,
  ageS: 120, // two minutes old
  launchpad: 'odyssey',
  at: 1_780_000_000,
}

function makeBot(store: Store): TelegramAlertBot {
  // grammY's Bot constructor performs no network I/O, so eligibility rules
  // are testable offline with a syntactically valid token.
  return new TelegramAlertBot('123456:TEST-token', store, { ...loadConfig({}), defaults: SETTING_DEFAULTS })
}

describe('delivery eligibility', () => {
  it('applies per-chat thresholds', () => {
    const store = new Store(':memory:', SETTING_DEFAULTS)
    const bot = makeBot(store)
    const chat = store.getChat('7')

    expect(bot.eligible(chat, alert)).toBe(true)
    expect(bot.eligible({ ...chat, spikeX: 10 }, alert)).toBe(false)
    expect(bot.eligible({ ...chat, minVolumeUsd: 10_000 }, alert)).toBe(false)
    expect(bot.eligible({ ...chat, minSwaps: 50 }, alert)).toBe(false)
    expect(bot.eligible({ ...chat, paused: true }, alert)).toBe(false)
    store.close()
  })

  it('gates young tokens behind the new-tokens toggle', () => {
    const store = new Store(':memory:', SETTING_DEFAULTS)
    const bot = makeBot(store)
    const chat = store.getChat('7')

    expect(bot.eligible({ ...chat, newTokens: false }, alert)).toBe(false)
    expect(bot.eligible({ ...chat, newTokens: false }, { ...alert, ageS: 7200 })).toBe(true)
    // Unknown age is not treated as new.
    expect(bot.eligible({ ...chat, newTokens: false }, { ...alert, ageS: null })).toBe(true)
    store.close()
  })

  it('honors mutes and cooldowns', () => {
    const store = new Store(':memory:', SETTING_DEFAULTS)
    const bot = makeBot(store)
    const chat = store.getChat('7')

    store.mute('7', alert.token)
    expect(bot.eligible(chat, alert)).toBe(false)
    store.unmute('7', alert.token)

    store.setLastAlert('7', alert.token, alert.at - 60) // one minute ago
    expect(bot.eligible(chat, alert)).toBe(false)
    store.setLastAlert('7', alert.token, alert.at - 31 * 60) // beyond the 30m cooldown
    expect(bot.eligible(chat, alert)).toBe(true)
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
