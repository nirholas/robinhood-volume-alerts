import type { Enricher, Enrichment } from '../chain/enrich.js'
import type { TokenMetaCache } from '../chain/token-meta.js'
import type { Config } from '../config.js'
import type { Store } from '../db.js'
import { logger } from '../logger.js'
import { computeBaseline, pctChange } from './baseline.js'
import type { VolumeTracker } from './window.js'

/** A fully-enriched spike, ready to render and deliver. */
export interface SpikeAlert {
  token: string
  symbol: string | null
  name: string | null
  /** Rolling-minute volume divided by the baseline per-minute volume. */
  multiple: number
  volumeUsd: number
  baselinePerMin: number
  swaps: number
  swapsMultiple: number
  buys: number
  sells: number
  priceUsd: number
  /** Percent changes, null when the reference price is unknown. */
  d1m: number | null
  d5m: number | null
  d1h: number | null
  mcapUsd: number | null
  liquidityUsd: number | null
  holders: number | null
  devSold: boolean | null
  ageS: number | null
  launchpad: string | null
  at: number
}

/**
 * The spike detector. Each tick it flushes closed minute buckets, then for
 * every token that traded in the last 60 seconds:
 *
 * 1. aggregates the rolling 60s window (volume, swaps, buys/sells, prices);
 * 2. learns the token's normal minute from the trailing closed buckets,
 *    excluding the two minutes the rolling window can overlap, top-trimmed
 *    so earlier spikes do not inflate "normal";
 * 3. gates on the loosest thresholds any subscriber holds (per-chat gating
 *    happens at delivery), plus a per-token re-alert guard so one sustained
 *    spike produces one alert, not one per tick;
 * 4. enriches survivors (mcap, liquidity, holders, dev-sold, age) and hands
 *    the finished {@link SpikeAlert} to the deliverer.
 */
export class SpikeDetector {
  /** Per-token: last alerted-at seconds and the multiple it fired with. */
  private readonly recentAlerts = new Map<string, { at: number; multiple: number }>()
  /** Suppress evaluation until the ingest backfill catches up to live. */
  live = false
  alertsEmitted = 0

  constructor(
    private readonly store: Store,
    private readonly tracker: VolumeTracker,
    private readonly enricher: Enricher,
    private readonly meta: TokenMetaCache,
    private readonly cfg: Config,
    private readonly deliver: (alert: SpikeAlert) => Promise<void>,
  ) {}

  /**
   * Loosest gates across subscribers; a spike below these interests nobody,
   * so it is dropped before the (network-bound) enrichment step. Falls back
   * to config defaults when there are no subscribers yet (dry runs).
   */
  private floorGates(): { spikeX: number; minVolumeUsd: number; minSwaps: number } {
    const chats = this.store.listActiveChats()
    if (chats.length === 0) {
      return {
        spikeX: this.cfg.defaults.spikeX,
        minVolumeUsd: this.cfg.defaults.minVolumeUsd,
        minSwaps: this.cfg.defaults.minSwaps,
      }
    }
    return {
      spikeX: Math.min(...chats.map((c) => c.spikeX)),
      minVolumeUsd: Math.min(...chats.map((c) => c.minVolumeUsd)),
      minSwaps: Math.min(...chats.map((c) => c.minSwaps)),
    }
  }

  async tick(nowS = Math.floor(Date.now() / 1000)): Promise<void> {
    this.tracker.flush(nowS)
    if (!this.live) return
    const gates = this.floorGates()
    const nowMinute = Math.floor(nowS / 60)

    for (const token of this.tracker.activeTokens(nowS)) {
      try {
        await this.evaluate(token, nowS, nowMinute, gates)
      } catch (error) {
        logger.warn({ token, err: String(error) }, 'spike evaluation failed')
      }
    }

    // Drop stale re-alert guards and old buckets once an hour of slack built up.
    for (const [token, mark] of this.recentAlerts) {
      if (nowS - mark.at > 2 * 3600) this.recentAlerts.delete(token)
    }
    this.store.pruneBuckets(nowMinute - 26 * 60)
  }

  private async evaluate(
    token: string,
    nowS: number,
    nowMinute: number,
    gates: { spikeX: number; minVolumeUsd: number; minSwaps: number },
  ): Promise<void> {
    const rolling = this.tracker.rolling(token, nowS)
    if (!rolling || rolling.volumeUsd < gates.minVolumeUsd || rolling.swaps < gates.minSwaps) return

    // Baseline window: trailing closed minutes, excluding the two minutes the
    // rolling 60s window can straddle.
    const toMinute = nowMinute - 2
    let fromMinute = toMinute - this.cfg.baselineMinutes + 1
    const firstSeen = this.firstSeenMinute(token)
    if (firstSeen !== null && firstSeen > fromMinute) fromMinute = firstSeen
    if (toMinute - fromMinute + 1 < 3) return // under 3 minutes of history: nothing to compare against

    const buckets = this.store.getBuckets(token, fromMinute, toMinute)
    const baseline = computeBaseline(buckets, fromMinute, toMinute)
    const multiple = rolling.volumeUsd / baseline.volPerMin
    if (multiple < gates.spikeX) return

    // Re-alert guard: one alert per token per cooldown-ish horizon unless the
    // spike escalates to at least double the multiple it last fired at.
    const recent = this.recentAlerts.get(token)
    if (recent && nowS - recent.at < 10 * 60 && multiple < recent.multiple * 2) return

    const swapsMultiple = rolling.swaps / baseline.swapsPerMin
    const priceUsd = rolling.lastPrice
    const meta = await this.meta.get(token as `0x${string}`)
    const enrichment: Enrichment = await this.enricher.enrich(token, priceUsd)

    const alert: SpikeAlert = {
      token,
      symbol: meta.symbol,
      name: meta.name,
      multiple,
      volumeUsd: rolling.volumeUsd,
      baselinePerMin: baseline.volPerMin,
      swaps: rolling.swaps,
      swapsMultiple,
      buys: rolling.buys,
      sells: rolling.sells,
      priceUsd,
      d1m: pctChange(rolling.firstPrice > 0 ? rolling.firstPrice : null, priceUsd),
      d5m: pctChange(this.store.closePriceAtOrBefore(token, nowMinute - 5, 10), priceUsd),
      d1h: pctChange(this.store.closePriceAtOrBefore(token, nowMinute - 60, 20), priceUsd),
      mcapUsd: enrichment.mcapUsd,
      liquidityUsd: enrichment.liquidityUsd,
      holders: enrichment.holders,
      devSold: enrichment.devSold,
      ageS: enrichment.ageS,
      launchpad: enrichment.launchpad,
      at: nowS,
    }

    this.recentAlerts.set(token, { at: nowS, multiple })
    this.alertsEmitted++
    await this.deliver(alert)
  }

  private firstSeenMinute(token: string): number | null {
    const row = this.store.getToken(token)
    if (row?.firstSeenS != null) return Math.floor(row.firstSeenS / 60)
    const earliest = this.store.earliestBucketMinute(token)
    return earliest
  }
}
