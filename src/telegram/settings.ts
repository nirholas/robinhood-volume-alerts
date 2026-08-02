import type { ChatSettings } from '../db.js'
import { fmtUsd } from './format.js'

/**
 * The sensitivity ladder each button steps through. Tapping advances to the
 * next value and wraps around at the top, exactly like the panel copy says.
 */
export const SPIKE_STEPS = [2, 3, 4, 5, 7, 10, 15] as const
export const VOLUME_STEPS = [500, 1000, 3000, 5000, 10_000, 25_000] as const
export const SWAPS_STEPS = [5, 10, 20, 30, 50] as const

/** Next value in a ladder, wrapping. Unknown current values snap to the first step. */
export function step(steps: readonly number[], current: number): number {
  const index = steps.indexOf(current)
  if (index === -1) {
    // Snap to the nearest step above, or wrap to the first.
    const above = steps.find((s) => s > current)
    return above ?? steps[0] ?? current
  }
  return steps[(index + 1) % steps.length] ?? current
}

export function spikeLabel(s: ChatSettings): string {
  return `Spike ${s.spikeX}×`
}

export function volumeLabel(s: ChatSettings): string {
  return `Volume ≥ ${s.minVolumeUsd >= 1000 ? `$${(s.minVolumeUsd / 1000).toFixed(1)}K` : fmtUsd(s.minVolumeUsd)}`
}

export function swapsLabel(s: ChatSettings): string {
  return `Swaps ≥ ${s.minSwaps}`
}

export function newTokensLabel(s: ChatSettings): string {
  return `New tokens ${s.newTokens ? 'on' : 'off'}`
}
