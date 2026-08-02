import { describe, expect, it } from 'vitest'
import { SETTING_DEFAULTS } from '../src/config.js'
import { Store } from '../src/db.js'
import { VolumeTracker } from '../src/engine/window.js'
import type { Trade } from '../src/chain/ingest.js'

function trade(overrides: Partial<Trade>): Trade {
  return {
    token: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    priceUsd: 0.01,
    volumeUsd: 100,
    isBuy: true,
    ts: 6000,
    blockNumber: 1n,
    txHash: '0x1',
    venue: 'uniswap-v3',
    ...overrides,
  }
}

describe('VolumeTracker', () => {
  it('aggregates the rolling 60s window', () => {
    const store = new Store(':memory:', SETTING_DEFAULTS)
    const tracker = new VolumeTracker(store, 150)
    tracker.add(trade({ ts: 5950, volumeUsd: 100, isBuy: true, priceUsd: 0.01 }))
    tracker.add(trade({ ts: 5970, volumeUsd: 200, isBuy: false, priceUsd: 0.011 }))
    tracker.add(trade({ ts: 5990, volumeUsd: 300, isBuy: true, priceUsd: 0.012 }))
    tracker.add(trade({ ts: 5930, volumeUsd: 999, isBuy: true, priceUsd: 0.009 })) // outside window at t=6000

    const rolling = tracker.rolling('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 6000)
    expect(rolling).not.toBeNull()
    expect(rolling!.volumeUsd).toBe(600)
    expect(rolling!.swaps).toBe(3)
    expect(rolling!.buys).toBe(2)
    expect(rolling!.sells).toBe(1)
    expect(rolling!.firstPrice).toBeCloseTo(0.01)
    expect(rolling!.lastPrice).toBeCloseTo(0.012)
    store.close()
  })

  it('flushes only closed minutes to SQLite', () => {
    const store = new Store(':memory:', SETTING_DEFAULTS)
    const tracker = new VolumeTracker(store, 150)
    // Minute 99 (5940..5999) and current minute 100 (6000..).
    tracker.add(trade({ ts: 5950, volumeUsd: 100 }))
    tracker.add(trade({ ts: 6010, volumeUsd: 500 }))

    const written = tracker.flush(6020) // current minute = 100; minute 99 closes
    expect(written).toBe(1)
    const buckets = store.getBuckets('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 99, 100)
    expect(buckets.get(99)?.volumeUsd).toBe(100)
    expect(buckets.has(100)).toBe(false)

    const written2 = tracker.flush(6060) // minute 100 closes
    expect(written2).toBe(1)
    expect(store.getBuckets('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 100, 100).get(100)?.volumeUsd).toBe(500)
    store.close()
  })

  it('lists active tokens and prunes idle ones', () => {
    const store = new Store(':memory:', SETTING_DEFAULTS)
    const tracker = new VolumeTracker(store, 150)
    tracker.add(trade({ token: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', ts: 5990 }))
    tracker.add(trade({ token: '0xcccccccccccccccccccccccccccccccccccccccc', ts: 5000 }))
    expect(tracker.activeTokens(6000)).toEqual(['0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'])
    tracker.flush(6000)
    // The idle token's trades fell outside retention and were pruned.
    expect(tracker.rolling('0xcccccccccccccccccccccccccccccccccccccccc', 6000)).toBeNull()
    store.close()
  })
})
