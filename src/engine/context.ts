import type { Enricher } from '../chain/enrich.js'
import type { TokenMetaCache } from '../chain/token-meta.js'
import type { Store } from '../db.js'
import { pctChange } from './baseline.js'
import { EMPTY_CONTEXT, type MarketContext } from './events.js'

/** Token identity plus the market context every alert card renders. */
export interface TokenSnapshot {
  symbol: string | null
  name: string | null
  context: MarketContext
}

/**
 * Build the shared alert payload for a token: symbol/name from the ERC-20
 * cache, market cap / liquidity / holders / dev-sold / age from the enricher,
 * and the 1m / 5m / 1h price deltas from the stored minute buckets.
 *
 * Every field degrades to null rather than throwing, so an alert never fails
 * because an explorer call timed out; the card just omits that line.
 */
export async function buildSnapshot(
  store: Store,
  meta: TokenMetaCache,
  enricher: Enricher,
  token: string,
  priceUsd: number,
  nowMinute: number,
  /** Price the 1m delta is measured from. Falls back to the stored bucket. */
  referencePrice?: number,
): Promise<TokenSnapshot> {
  const identity = await meta.get(token as `0x${string}`)
  const enrichment = await enricher.enrich(token, priceUsd)

  // Anchor the 1m delta to the minute BEFORE the newest bucket. Anchoring it
  // to `nowMinute - 1` compares the latest close against itself whenever the
  // newest data is a minute old, which rendered as a flat "1m +0.0%" on every
  // card that did not pass its own reference price.
  const latestMinute = store.latestBucketMinute(token, nowMinute - 5) ?? nowMinute - 1
  const oneMinuteAgo = referencePrice ?? store.closePriceAtOrBefore(token, latestMinute - 1, 3)

  return {
    symbol: identity.symbol,
    name: identity.name,
    context: {
      ...EMPTY_CONTEXT,
      priceUsd,
      mcapUsd: enrichment.mcapUsd,
      liquidityUsd: enrichment.liquidityUsd,
      holders: enrichment.holders,
      devSold: enrichment.devSold,
      ageS: enrichment.ageS,
      launchpad: enrichment.launchpad,
      d1m: pctChange(oneMinuteAgo ?? null, priceUsd),
      d5m: pctChange(store.closePriceAtOrBefore(token, nowMinute - 5, 10), priceUsd),
      d1h: pctChange(store.closePriceAtOrBefore(token, nowMinute - 60, 20), priceUsd),
    },
  }
}
