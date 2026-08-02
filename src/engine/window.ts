import type { Trade } from '../chain/ingest.js'
import type { MinuteBucket, Store } from '../db.js'

/** Live rolling-60s aggregate for one token. */
export interface Rolling {
  volumeUsd: number
  swaps: number
  buys: number
  sells: number
  /** Price of the most recent trade in the window. */
  lastPrice: number
  /** Price of the oldest trade in the window (basis for the 1m delta). */
  firstPrice: number
}

interface LiveTrade {
  ts: number
  volumeUsd: number
  isBuy: boolean
  priceUsd: number
}

/**
 * Per-token trade window and minute-bucket writer.
 *
 * Incoming trades land in a per-token in-memory list (pruned past the
 * retention horizon) that serves rolling-60s reads. Independently, each
 * completed wall-clock minute is aggregated and flushed to SQLite, where the
 * baseline math reads it back. SQLite is the durable half: baselines survive
 * restarts, the live window rebuilds within a minute of uptime (or instantly
 * when the ingester backfills).
 */
export class VolumeTracker {
  private readonly trades = new Map<string, LiveTrade[]>()
  /** Minute buckets not yet flushed, keyed `token` then minute index. */
  private readonly pending = new Map<string, Map<number, MinuteBucket>>()

  constructor(
    private readonly store: Store,
    private readonly retentionS = 150,
  ) {}

  add(trade: Trade): void {
    const key = trade.token
    let list = this.trades.get(key)
    if (!list) {
      list = []
      this.trades.set(key, list)
    }
    list.push({ ts: trade.ts, volumeUsd: trade.volumeUsd, isBuy: trade.isBuy, priceUsd: trade.priceUsd })

    const minute = Math.floor(trade.ts / 60)
    let buckets = this.pending.get(key)
    if (!buckets) {
      buckets = new Map()
      this.pending.set(key, buckets)
    }
    const bucket = buckets.get(minute)
    if (!bucket) {
      buckets.set(minute, {
        volumeUsd: trade.volumeUsd,
        swaps: 1,
        buys: trade.isBuy ? 1 : 0,
        sells: trade.isBuy ? 0 : 1,
        closePrice: trade.priceUsd,
      })
    } else {
      bucket.volumeUsd += trade.volumeUsd
      bucket.swaps += 1
      if (trade.isBuy) bucket.buys += 1
      else bucket.sells += 1
      if (trade.priceUsd > 0) bucket.closePrice = trade.priceUsd
    }
  }

  /**
   * Flush every bucket for minutes that have fully closed (minute < current)
   * to SQLite, prune the live lists, and record the token's first-seen fact.
   * Returns the number of buckets written.
   */
  flush(nowS: number): number {
    const currentMinute = Math.floor(nowS / 60)
    let written = 0
    for (const [token, buckets] of this.pending) {
      for (const [minute, bucket] of buckets) {
        if (minute >= currentMinute) continue
        this.store.addBucket(token, minute, bucket)
        buckets.delete(minute)
        written++
      }
      if (buckets.size === 0) this.pending.delete(token)
    }
    // Prune live trade lists.
    const horizon = nowS - this.retentionS
    for (const [token, list] of this.trades) {
      let firstKept = 0
      while (firstKept < list.length) {
        const item = list[firstKept]
        if (item && item.ts < horizon) firstKept++
        else break
      }
      if (firstKept > 0) list.splice(0, firstKept)
      if (list.length === 0) this.trades.delete(token)
    }
    return written
  }

  /** Tokens with at least one trade in the last `windowS` seconds. */
  activeTokens(nowS: number, windowS = 60): string[] {
    const cutoff = nowS - windowS
    const out: string[] = []
    for (const [token, list] of this.trades) {
      const last = list[list.length - 1]
      if (last && last.ts >= cutoff) out.push(token)
    }
    return out
  }

  /** Rolling aggregate over the trailing `windowS` seconds. */
  rolling(token: string, nowS: number, windowS = 60): Rolling | null {
    const list = this.trades.get(token)
    if (!list || list.length === 0) return null
    const cutoff = nowS - windowS
    let volumeUsd = 0
    let swaps = 0
    let buys = 0
    let sells = 0
    let firstPrice = 0
    let lastPrice = 0
    for (const t of list) {
      if (t.ts < cutoff) continue
      volumeUsd += t.volumeUsd
      swaps++
      if (t.isBuy) buys++
      else sells++
      if (firstPrice === 0 && t.priceUsd > 0) firstPrice = t.priceUsd
      if (t.priceUsd > 0) lastPrice = t.priceUsd
    }
    if (swaps === 0) return null
    return { volumeUsd, swaps, buys, sells, lastPrice, firstPrice }
  }
}
