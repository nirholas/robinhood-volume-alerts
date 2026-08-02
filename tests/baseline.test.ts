import { describe, expect, it } from 'vitest'
import { computeBaseline, pctChange, trimmedMean, SWAPS_FLOOR_PER_MIN, VOLUME_FLOOR_PER_MIN } from '../src/engine/baseline.js'
import type { MinuteBucket } from '../src/db.js'

function bucket(volumeUsd: number, swaps = 5): MinuteBucket {
  return { volumeUsd, swaps, buys: Math.ceil(swaps / 2), sells: Math.floor(swaps / 2), closePrice: 1 }
}

describe('trimmedMean', () => {
  it('drops the loudest 20% before averaging', () => {
    // 10 values, the two largest (1000, 900) are trimmed.
    const values = [10, 10, 10, 10, 10, 10, 10, 10, 900, 1000]
    expect(trimmedMean(values)).toBe(10)
  })

  it('keeps at least one value', () => {
    expect(trimmedMean([42])).toBe(42)
  })

  it('returns 0 for empty input', () => {
    expect(trimmedMean([])).toBe(0)
  })
})

describe('computeBaseline', () => {
  it('treats missing minutes as zero volume', () => {
    const buckets = new Map<number, MinuteBucket>([[100, bucket(600)]])
    // Window of 10 minutes, only one traded: total 600 over 10 minutes,
    // top-20% trim removes the loud minute entirely: everything left is 0,
    // so the floor applies.
    const b = computeBaseline(buckets, 91, 100)
    expect(b.windowMinutes).toBe(10)
    expect(b.volPerMin).toBe(VOLUME_FLOOR_PER_MIN)
  })

  it('learns a steady tape', () => {
    const buckets = new Map<number, MinuteBucket>()
    for (let m = 41; m <= 100; m++) buckets.set(m, bucket(120, 6))
    const b = computeBaseline(buckets, 41, 100)
    expect(b.volPerMin).toBeCloseTo(120, 5)
    expect(b.swapsPerMin).toBeCloseTo(6, 5)
    expect(b.windowMinutes).toBe(60)
  })

  it('is not inflated by one prior spike', () => {
    const buckets = new Map<number, MinuteBucket>()
    for (let m = 41; m <= 100; m++) buckets.set(m, bucket(100, 5))
    buckets.set(70, bucket(50_000, 300)) // an earlier 500x minute
    const withSpike = computeBaseline(buckets, 41, 100)
    // The trim drops the spike minute: baseline stays at the quiet level.
    expect(withSpike.volPerMin).toBeCloseTo(100, 5)
  })

  it('floors both denominators', () => {
    const b = computeBaseline(new Map(), 1, 60)
    expect(b.volPerMin).toBe(VOLUME_FLOOR_PER_MIN)
    expect(b.swapsPerMin).toBe(SWAPS_FLOOR_PER_MIN)
  })
})

describe('pctChange', () => {
  it('computes signed percent', () => {
    expect(pctChange(100, 159.8)).toBeCloseTo(59.8, 5)
    expect(pctChange(100, 80)).toBeCloseTo(-20, 5)
  })

  it('returns null for unusable references', () => {
    expect(pctChange(null, 5)).toBeNull()
    expect(pctChange(0, 5)).toBeNull()
    expect(pctChange(5, 0)).toBeNull()
  })
})
