import { describe, expect, it } from 'vitest'
import { SETTING_DEFAULTS } from '../src/config.js'
import { Store } from '../src/db.js'

describe('Store', () => {
  it('returns defaults for unknown chats and persists changes', () => {
    const store = new Store(':memory:', SETTING_DEFAULTS)
    const fresh = store.getChat('123')
    expect(fresh.spikeX).toBe(SETTING_DEFAULTS.spikeX)
    expect(fresh.paused).toBe(false)

    store.upsertChat({ ...fresh, spikeX: 10, paused: true })
    const loaded = store.getChat('123')
    expect(loaded.spikeX).toBe(10)
    expect(loaded.paused).toBe(true)
    expect(store.listActiveChats()).toHaveLength(0) // paused chats are not active
    store.close()
  })

  it('mutes per chat, case-insensitively', () => {
    const store = new Store(':memory:', SETTING_DEFAULTS)
    store.mute('1', '0xABCDEF0000000000000000000000000000000000')
    expect(store.isMuted('1', '0xabcdef0000000000000000000000000000000000')).toBe(true)
    expect(store.isMuted('2', '0xabcdef0000000000000000000000000000000000')).toBe(false)
    store.unmute('1', '0xabcdef0000000000000000000000000000000000')
    expect(store.isMuted('1', '0xabcdef0000000000000000000000000000000000')).toBe(false)
    store.close()
  })

  it('merges bucket re-adds and prunes old minutes', () => {
    const store = new Store(':memory:', SETTING_DEFAULTS)
    store.addBucket('0xaa', 100, { volumeUsd: 50, swaps: 2, buys: 1, sells: 1, closePrice: 0.5 })
    store.addBucket('0xaa', 100, { volumeUsd: 25, swaps: 1, buys: 1, sells: 0, closePrice: 0.6 })
    const merged = store.getBuckets('0xaa', 100, 100).get(100)
    expect(merged?.volumeUsd).toBe(75)
    expect(merged?.swaps).toBe(3)
    expect(merged?.closePrice).toBe(0.6)

    store.pruneBuckets(101)
    expect(store.getBuckets('0xaa', 100, 100).size).toBe(0)
    store.close()
  })

  it('keeps the earliest first-seen when upserting tokens', () => {
    const store = new Store(':memory:', SETTING_DEFAULTS)
    store.upsertToken({ token: '0xAA', firstSeenS: 2000 })
    store.upsertToken({ token: '0xaa', firstSeenS: 1000, symbol: 'AA' })
    store.upsertToken({ token: '0xaa', firstSeenS: 3000 })
    const row = store.getToken('0xaa')
    expect(row?.firstSeenS).toBe(1000)
    expect(row?.symbol).toBe('AA')
    store.close()
  })

  it('records cooldowns per chat and per alert kind', () => {
    const store = new Store(':memory:', SETTING_DEFAULTS)
    expect(store.lastAlertS('1', 'spike', '0xaa')).toBeNull()
    store.setLastAlert('1', 'spike', '0xAA', 5000)
    expect(store.lastAlertS('1', 'spike', '0xaa')).toBe(5000)
    expect(store.lastAlertS('1', 'whale', '0xaa')).toBeNull()
    store.close()
  })

  it('stores watches and resolves their watchers', () => {
    const store = new Store(':memory:', SETTING_DEFAULTS)
    store.addWatch('1', 'wallet', '0xABCDEF0000000000000000000000000000000001', 'Whale Bob')
    store.addWatch('2', 'wallet', '0xabcdef0000000000000000000000000000000001', null)
    store.addWatch('1', 'token', '0x0000000000000000000000000000000000000002', null)

    expect(store.allWatchTargets('wallet')).toEqual(['0xabcdef0000000000000000000000000000000001'])
    const watchers = store.watchersOf('wallet', '0xABCDEF0000000000000000000000000000000001')
    expect(watchers.map((w) => w.chatId).sort()).toEqual(['1', '2'])
    expect(watchers.find((w) => w.chatId === '1')?.label).toBe('Whale Bob')
    expect(store.listWatches('1')).toHaveLength(2)
    expect(store.listWatches('1', 'token')).toHaveLength(1)

    expect(store.removeWatch('1', 'token', '0x0000000000000000000000000000000000000002')).toBe(true)
    expect(store.removeWatch('1', 'token', '0x0000000000000000000000000000000000000002')).toBe(false)
    store.close()
  })

  it('persists per-kind settings across reads', () => {
    const store = new Store(':memory:', SETTING_DEFAULTS)
    const chat = store.getChat('9')
    store.upsertChat({ ...chat, kinds: ['spike', 'whale'], whaleMinUsd: 25_000, priceMovePct: 60, rugDropPct: 80 })
    const loaded = store.getChat('9')
    expect(loaded.kinds).toEqual(['spike', 'whale'])
    expect(loaded.whaleMinUsd).toBe(25_000)
    expect(loaded.priceMovePct).toBe(60)
    expect(loaded.rugDropPct).toBe(80)
    store.close()
  })

  it('ranks top movers by volume with their price change', () => {
    const store = new Store(':memory:', SETTING_DEFAULTS)
    store.upsertToken({ token: '0xaa', symbol: 'AA' })
    store.addBucket('0xaa', 100, { volumeUsd: 500, swaps: 5, buys: 3, sells: 2, closePrice: 1 })
    store.addBucket('0xaa', 110, { volumeUsd: 500, swaps: 5, buys: 3, sells: 2, closePrice: 2 })
    store.addBucket('0xbb', 105, { volumeUsd: 100, swaps: 1, buys: 1, sells: 0, closePrice: 5 })

    const movers = store.topMovers(90, 120, 10)
    expect(movers[0]?.token).toBe('0xaa')
    expect(movers[0]?.symbol).toBe('AA')
    expect(movers[0]?.volumeUsd).toBe(1000)
    expect(movers[0]?.pct).toBeCloseTo(100, 5)
    expect(movers[1]?.token).toBe('0xbb')
    store.close()
  })

  it('tracks alert performance and settles the scorecard on closed calls only', () => {
    const store = new Store(':memory:', SETTING_DEFAULTS)
    const id = store.trackAlert('0xaa', 'spike', 1000, 0.01)
    store.addAlertRecipient(id, '1')
    expect(store.recipientsOf(id)).toEqual(['1'])
    expect(store.hasOpenTracker('0xAA')).toBe(true)

    store.updateTracked(id, 0.05, 2000, 5)
    // Still open: it counts as tracked but not settled.
    let card = store.scorecard(0)
    expect(card.tracked).toBe(1)
    expect(card.settled).toBe(0)
    expect(card.hit2x).toBe(0)
    expect(card.best?.multiple).toBeCloseTo(5, 5)

    store.closeTracked(id)
    card = store.scorecard(0)
    expect(card.settled).toBe(1)
    expect(card.hit2x).toBe(1)
    expect(card.hit5x).toBe(1)
    expect(card.hit10x).toBe(0)
    expect(card.medianPeak).toBeCloseTo(5, 5)
    expect(store.hasOpenTracker('0xaa')).toBe(false)
    store.close()
  })
})
