import type { TokenMetaCache } from '../chain/token-meta.js'
import type { Store } from '../db.js'
import { logger } from '../logger.js'
import type { EmitAlert } from './detector.js'
import { EMPTY_CONTEXT, type Alert } from './events.js'

/** Multiples worth telling someone about, ascending. */
export const MILESTONES = [2, 3, 5, 10, 25, 50, 100] as const

/** Stop following a call after this long. */
export const TRACK_HOURS = 24

/** A call is written off once it trades this far below the alert price. */
export const DEAD_FRACTION = 0.25

/**
 * Alert performance tracking: the accountability layer.
 *
 * Every delivered spike alert opens a tracker holding the price at alert
 * time. This poller re-reads each open tracker's peak price from the stored
 * minute buckets (no extra RPC: the ingest already wrote them), and when a
 * call crosses 2x, 3x, 5x and beyond it sends a follow-up to exactly the
 * chats that received the original alert. Trackers settle after
 * {@link TRACK_HOURS}, or earlier if the token dies, and the settled set is
 * what /scorecard reports, so the hit rates can never be flattered by calls
 * still in flight.
 */
export class PerformanceTracker {
  milestonesEmitted = 0

  constructor(
    private readonly store: Store,
    private readonly meta: TokenMetaCache,
    private readonly emit: EmitAlert,
  ) {}

  /** Open a tracker for a delivered alert. Returns its id, or null if one is already open. */
  track(alert: Alert, recipients: string[]): number | null {
    if (alert.kind !== 'spike') return null
    if (alert.context.priceUsd <= 0) return null
    if (this.store.hasOpenTracker(alert.token)) return null
    const id = this.store.trackAlert(alert.token, alert.kind, alert.at, alert.context.priceUsd)
    for (const chatId of recipients) this.store.addAlertRecipient(id, chatId)
    return id
  }

  async poll(nowS = Math.floor(Date.now() / 1000)): Promise<void> {
    const nowMinute = Math.floor(nowS / 60)
    for (const tracked of this.store.openTrackedAlerts()) {
      try {
        const alertMinute = Math.floor(tracked.alertedAt / 60)
        const peak = this.store.peakPrice(tracked.token, alertMinute, nowMinute)
        const peakPrice = Math.max(tracked.peakPrice, peak?.price ?? 0)
        const peakAt = peak && peak.price > tracked.peakPrice ? peak.minute * 60 : tracked.peakAt
        const multiple = tracked.entryPrice > 0 ? peakPrice / tracked.entryPrice : 0

        const crossed = highestCrossed(multiple, tracked.lastMilestone)
        if (crossed !== null) {
          const recipients = this.store.recipientsOf(tracked.id)
          this.store.updateTracked(tracked.id, peakPrice, peakAt, crossed)
          if (recipients.length > 0) await this.emitMilestone(tracked, peakPrice, peakAt, multiple, crossed, recipients)
        } else if (peakPrice > tracked.peakPrice) {
          this.store.updateTracked(tracked.id, peakPrice, peakAt, tracked.lastMilestone)
        }

        const current = this.store.latestPrice(tracked.token, nowMinute - 30)
        const expired = nowS - tracked.alertedAt > TRACK_HOURS * 3600
        const dead = current !== null && tracked.entryPrice > 0 && current < tracked.entryPrice * DEAD_FRACTION
        if (expired || dead) this.store.closeTracked(tracked.id)
      } catch (error) {
        logger.warn({ trackedId: tracked.id, err: String(error) }, 'performance poll failed')
      }
    }
  }

  private async emitMilestone(
    tracked: { id: number; token: string; alertedAt: number; entryPrice: number; sourceKind: Alert['kind'] },
    peakPrice: number,
    peakAt: number,
    multiple: number,
    milestone: number,
    recipients: string[],
  ): Promise<void> {
    const identity = await this.meta.get(tracked.token as `0x${string}`)
    const row = this.store.getToken(tracked.token)
    this.milestonesEmitted++
    await this.emit({
      kind: 'performance',
      token: tracked.token,
      symbol: identity.symbol,
      name: identity.name,
      at: Math.floor(Date.now() / 1000),
      context: {
        ...EMPTY_CONTEXT,
        priceUsd: peakPrice,
        launchpad: row?.launchpad ?? null,
        ageS: row?.firstSeenS != null ? Math.floor(Date.now() / 1000) - row.firstSeenS : null,
      },
      multiple,
      milestone,
      entryPriceUsd: tracked.entryPrice,
      peakPriceUsd: peakPrice,
      elapsedS: Math.max(0, peakAt - tracked.alertedAt),
      sourceKind: tracked.sourceKind,
      audience: recipients,
    })
  }
}

/** Highest milestone `multiple` clears that is above the one already sent. */
export function highestCrossed(multiple: number, lastMilestone: number): number | null {
  let crossed: number | null = null
  for (const m of MILESTONES) {
    if (multiple >= m && m > lastMilestone) crossed = m
  }
  return crossed
}
