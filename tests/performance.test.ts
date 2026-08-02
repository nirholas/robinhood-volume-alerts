import { describe, expect, it } from 'vitest'
import { SETTING_DEFAULTS } from '../src/config.js'
import { Store } from '../src/db.js'
import { DEAD_FRACTION, MILESTONES, PerformanceTracker, TRACK_HOURS, highestCrossed } from '../src/engine/performance.js'
import type { Alert } from '../src/engine/events.js'
import type { TokenMetaCache } from '../src/chain/token-meta.js'

/** The tracker only needs symbol/name, so a tiny stand-in covers the surface. */
const meta = {
  get: async () => ({ symbol: 'AA', name: 'Alpha', decimals: 18, totalSupply: null }),
} as unknown as TokenMetaCache

const spike = (token: string, at: number, price: number): Alert => ({
  kind: 'spike',
  token,
  symbol: 'AA',
  name: 'Alpha',
  at,
  context: {
    priceUsd: price,
    mcapUsd: null,
    liquidityUsd: null,
    holders: null,
    devSold: null,
    ageS: null,
    launchpad: null,
    d1m: null,
    d5m: null,
    d1h: null,
  },
  multiple: 6,
  volumeUsd: 5000,
  baselinePerMin: 800,
  swaps: 20,
  swapsMultiple: 4,
  buys: 12,
  sells: 8,
})

describe('highestCrossed', () => {
  it('returns the biggest newly-crossed milestone', () => {
    expect(highestCrossed(6.2, 1)).toBe(5)
    expect(highestCrossed(6.2, 5)).toBeNull()
    expect(highestCrossed(11, 5)).toBe(10)
    expect(highestCrossed(1.9, 1)).toBeNull()
  })

  it('never re-sends a milestone already reported', () => {
    for (const m of MILESTONES) expect(highestCrossed(m, m)).toBeNull()
  })
})

describe('PerformanceTracker', () => {
  it('opens one tracker per token and records recipients', () => {
    const store = new Store(':memory:', SETTING_DEFAULTS)
    const tracker = new PerformanceTracker(store, meta, async () => undefined)

    const id = tracker.track(spike('0xaa', 1000, 0.01), ['1', '2'])
    expect(id).not.toBeNull()
    expect(store.recipientsOf(id as number).sort()).toEqual(['1', '2'])
    // A second spike on the same token while the first is open does not duplicate.
    expect(tracker.track(spike('0xaa', 1200, 0.02), ['1'])).toBeNull()
    store.close()
  })

  it('ignores alerts with no usable price', () => {
    const store = new Store(':memory:', SETTING_DEFAULTS)
    const tracker = new PerformanceTracker(store, meta, async () => undefined)
    expect(tracker.track(spike('0xbb', 1000, 0), ['1'])).toBeNull()
    store.close()
  })

  it('emits a milestone when the peak clears it, once', async () => {
    const store = new Store(':memory:', SETTING_DEFAULTS)
    const emitted: Alert[] = []
    const tracker = new PerformanceTracker(store, meta, async (a) => void emitted.push(a))

    const alertedAt = 600_000 // minute 10000
    tracker.track(spike('0xaa', alertedAt, 0.01), ['1'])
    // Price triples two minutes later.
    store.addBucket('0xaa', 10_002, { volumeUsd: 100, swaps: 2, buys: 2, sells: 0, closePrice: 0.03 })

    await tracker.poll(alertedAt + 180)
    expect(emitted).toHaveLength(1)
    const first = emitted[0]
    expect(first?.kind).toBe('performance')
    if (first?.kind === 'performance') {
      expect(first.milestone).toBe(3)
      expect(first.multiple).toBeCloseTo(3, 5)
      expect(first.audience).toEqual(['1'])
    }

    // Polling again at the same peak sends nothing new.
    await tracker.poll(alertedAt + 240)
    expect(emitted).toHaveLength(1)

    // A further run to 5x sends exactly one more.
    store.addBucket('0xaa', 10_004, { volumeUsd: 100, swaps: 2, buys: 2, sells: 0, closePrice: 0.055 })
    await tracker.poll(alertedAt + 300)
    expect(emitted).toHaveLength(2)
    store.close()
  })

  it('settles a call that dies and one that ages out', async () => {
    const store = new Store(':memory:', SETTING_DEFAULTS)
    const tracker = new PerformanceTracker(store, meta, async () => undefined)

    const alertedAt = 600_000
    tracker.track(spike('0xdead', alertedAt, 1), ['1'])
    store.addBucket('0xdead', 10_001, {
      volumeUsd: 10,
      swaps: 1,
      buys: 0,
      sells: 1,
      closePrice: DEAD_FRACTION / 2,
    })
    await tracker.poll(alertedAt + 120)
    expect(store.openTrackedAlerts()).toHaveLength(0)

    tracker.track(spike('0xold', alertedAt, 1), ['1'])
    await tracker.poll(alertedAt + TRACK_HOURS * 3600 + 60)
    expect(store.openTrackedAlerts()).toHaveLength(0)
    store.close()
  })
})
