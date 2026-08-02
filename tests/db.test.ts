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

  it('records per-chat cooldowns', () => {
    const store = new Store(':memory:', SETTING_DEFAULTS)
    expect(store.lastAlertS('1', '0xaa')).toBeNull()
    store.setLastAlert('1', '0xAA', 5000)
    expect(store.lastAlertS('1', '0xaa')).toBe(5000)
    store.close()
  })
})
