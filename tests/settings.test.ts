import { describe, expect, it } from 'vitest'
import { SPIKE_STEPS, SWAPS_STEPS, VOLUME_STEPS, step } from '../src/telegram/settings.js'

describe('sensitivity stepping', () => {
  it('steps up and wraps at the top', () => {
    expect(step(SPIKE_STEPS, 4)).toBe(5)
    expect(step(SPIKE_STEPS, 15)).toBe(2) // wrap
    expect(step(VOLUME_STEPS, 3000)).toBe(5000)
    expect(step(VOLUME_STEPS, 25_000)).toBe(500) // wrap
    expect(step(SWAPS_STEPS, 10)).toBe(20)
    expect(step(SWAPS_STEPS, 50)).toBe(5) // wrap
  })

  it('snaps unknown values to the nearest step above', () => {
    expect(step(SPIKE_STEPS, 4.5)).toBe(5)
    expect(step(VOLUME_STEPS, 999_999)).toBe(500) // nothing above: wrap to first
  })
})
