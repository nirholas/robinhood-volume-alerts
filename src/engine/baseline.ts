import type { MinuteBucket } from '../db.js'

/** A token's learned "normal minute". */
export interface Baseline {
  /** Normal USD volume per minute. Floored, never zero. */
  volPerMin: number
  /** Normal swaps per minute. Floored, never zero. */
  swapsPerMin: number
  /** How many closed minutes the estimate is built on. */
  windowMinutes: number
}

/**
 * Absolute floors for the baseline denominators. Without them a token that
 * traded nothing for an hour would divide any dust trade into an enormous
 * multiple. $25/min and half a swap a minute keep multiples meaningful for
 * quiet tokens while barely denting active ones.
 */
export const VOLUME_FLOOR_PER_MIN = 25
export const SWAPS_FLOOR_PER_MIN = 0.5

/** Fraction of the loudest minutes dropped before averaging. */
export const TRIM_FRACTION = 0.2

/**
 * Learn a token's normal minute from its trailing closed minute buckets.
 *
 * `buckets` maps minute index to the stored aggregate; minutes with no
 * trades count as zero. The top {@link TRIM_FRACTION} of minutes by volume
 * is dropped before averaging, so one prior spike does not inflate "normal"
 * and mask the next one. Both averages are floored (see the floor consts).
 *
 * @param buckets    Stored buckets, keyed by absolute minute index.
 * @param fromMinute First minute of the evaluation window (inclusive).
 * @param toMinute   Last minute of the evaluation window (inclusive).
 */
export function computeBaseline(buckets: Map<number, MinuteBucket>, fromMinute: number, toMinute: number): Baseline {
  const volumes: number[] = []
  const swaps: number[] = []
  for (let m = fromMinute; m <= toMinute; m++) {
    const b = buckets.get(m)
    volumes.push(b?.volumeUsd ?? 0)
    swaps.push(b?.swaps ?? 0)
  }
  const windowMinutes = volumes.length
  if (windowMinutes === 0) {
    return { volPerMin: VOLUME_FLOOR_PER_MIN, swapsPerMin: SWAPS_FLOOR_PER_MIN, windowMinutes: 0 }
  }

  return {
    volPerMin: Math.max(trimmedMean(volumes), VOLUME_FLOOR_PER_MIN),
    swapsPerMin: Math.max(trimmedMean(swaps), SWAPS_FLOOR_PER_MIN),
    windowMinutes,
  }
}

/** Mean after dropping the top TRIM_FRACTION of values. */
export function trimmedMean(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const keep = Math.max(1, sorted.length - Math.floor(sorted.length * TRIM_FRACTION))
  let sum = 0
  for (let i = 0; i < keep; i++) sum += sorted[i] ?? 0
  return sum / keep
}

/** Signed percent change from `from` to `to`, or null when unusable. */
export function pctChange(from: number | null, to: number): number | null {
  if (from === null || from <= 0 || to <= 0) return null
  return ((to - from) / from) * 100
}
