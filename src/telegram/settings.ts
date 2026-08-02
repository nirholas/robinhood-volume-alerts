import type { ChatSettings } from '../db.js'

/**
 * The sensitivity ladders each button steps through. Tapping advances to the
 * next value and wraps around at the top, so every setting is reachable with
 * repeated taps and never needs typing.
 */
export const SPIKE_STEPS = [2, 3, 4, 5, 7, 10, 15] as const
export const VOLUME_STEPS = [500, 1000, 3000, 5000, 10_000, 25_000] as const
export const SWAPS_STEPS = [5, 10, 20, 30, 50] as const
export const WHALE_STEPS = [1000, 2500, 5000, 10_000, 25_000, 50_000] as const
export const PRICE_MOVE_STEPS = [10, 15, 25, 40, 60, 100] as const
export const RUG_STEPS = [25, 40, 60, 80] as const

/** Next value in a ladder, wrapping. Unknown values snap to the next step up. */
export function step(steps: readonly number[], current: number): number {
  const index = steps.indexOf(current)
  if (index === -1) {
    const above = steps.find((s) => s > current)
    return above ?? steps[0] ?? current
  }
  return steps[(index + 1) % steps.length] ?? current
}

/** Compact dollar label for a threshold button ($3.0K, $25.0K, $500). */
export function moneyLabel(usd: number): string {
  return usd >= 1000 ? `$${(usd / 1000).toFixed(1)}K` : `$${usd.toFixed(0)}`
}

export function spikeLabel(s: ChatSettings): string {
  return `Spike ${s.spikeX}×`
}

export function volumeLabel(s: ChatSettings): string {
  return `Volume ≥ ${moneyLabel(s.minVolumeUsd)}`
}

export function swapsLabel(s: ChatSettings): string {
  return `Swaps ≥ ${s.minSwaps}`
}

export function newTokensLabel(s: ChatSettings): string {
  return `New tokens ${s.newTokens ? 'on' : 'off'}`
}

export function whaleLabel(s: ChatSettings): string {
  return `Whale ≥ ${moneyLabel(s.whaleMinUsd)}`
}

export function priceMoveLabel(s: ChatSettings): string {
  return `Price move ≥ ${s.priceMovePct}%`
}

export function rugLabel(s: ChatSettings): string {
  return `Rug drop ≥ ${s.rugDropPct}%`
}
