import { erc20Abi, MAINNET_ADDRESSES, MAINNET_EXPLORER_URL, type HoodClient } from 'hoodchain'
import type { Address } from 'viem'
import type { Store } from '../db.js'
import { logger } from '../logger.js'
import type { EthPrice } from './eth-price.js'
import type { TokenMetaCache } from './token-meta.js'

/** Context fetched for a token at alert time. Every field degrades to null. */
export interface Enrichment {
  mcapUsd: number | null
  liquidityUsd: number | null
  holders: number | null
  /** True when the launch creator's balance is zero. Null when unknown. */
  devSold: boolean | null
  ageS: number | null
  launchpad: string | null
}

interface CacheEntry {
  value: Enrichment
  fetchedAt: number
}

/**
 * Alert-time context: market cap, pooled liquidity, holder count, dev-sold
 * flag, and age. One fetch per token per TTL window; alerts for the same
 * token inside the window reuse it. Everything is best-effort: a missing
 * source drops its line from the card instead of blocking the alert.
 */
export class Enricher {
  private readonly cache = new Map<string, CacheEntry>()

  constructor(
    private readonly client: HoodClient,
    private readonly store: Store,
    private readonly ethPrice: EthPrice,
    private readonly meta: TokenMetaCache,
    private readonly ttlS = 60,
  ) {}

  async enrich(token: string, priceUsd: number): Promise<Enrichment> {
    const key = token.toLowerCase()
    const now = Math.floor(Date.now() / 1000)
    const hit = this.cache.get(key)
    if (hit && now - hit.fetchedAt < this.ttlS) return hit.value

    const [mcapUsd, liquidityUsd, holders, launchFacts] = await Promise.all([
      this.marketCap(key as Address, priceUsd),
      this.liquidity(key),
      this.holderCount(key),
      this.launchFacts(key, now),
    ])
    const value: Enrichment = { mcapUsd, liquidityUsd, holders, ...launchFacts }
    this.cache.set(key, { value, fetchedAt: now })
    if (this.cache.size > 2000) {
      const first = this.cache.keys().next().value
      if (first) this.cache.delete(first)
    }
    return value
  }

  private async marketCap(token: Address, priceUsd: number): Promise<number | null> {
    if (priceUsd <= 0) return null
    const meta = await this.meta.get(token)
    if (meta.totalSupply === null || meta.decimals === null) return null
    const supply = Number(meta.totalSupply) / 10 ** meta.decimals
    const mcap = supply * priceUsd
    return Number.isFinite(mcap) && mcap > 0 ? mcap : null
  }

  /**
   * Pooled liquidity: for every classified pool of the token, the quote-side
   * balance in USD, doubled (the standard both-sides approximation for
   * in-range v3 liquidity).
   */
  private async liquidity(token: string): Promise<number | null> {
    const pools = this.store.poolsForToken(token).filter((p) => p.quote !== null)
    if (pools.length === 0) return null
    const eth = (await this.ethPrice.get()) ?? this.ethPrice.lastKnown
    try {
      const balances = await this.client.public.multicall({
        contracts: pools.map((p) => ({
          address: p.quote === 'USDG' ? MAINNET_ADDRESSES.usdg : MAINNET_ADDRESSES.weth,
          abi: erc20Abi,
          functionName: 'balanceOf' as const,
          args: [p.pool as Address] as const,
        })),
        allowFailure: true,
      })
      let total = 0
      balances.forEach((res, i) => {
        const pool = pools[i]
        if (!pool || res.status !== 'success') return
        const raw = res.result as bigint
        const human = Number(raw) / 10 ** pool.decimalsQuote
        const usd = pool.quote === 'USDG' ? human : eth !== null ? human * eth : 0
        total += usd * 2
      })
      return total > 0 ? total : null
    } catch (error) {
      logger.debug({ token, err: String(error) }, 'liquidity read failed')
      return null
    }
  }

  private async holderCount(token: string): Promise<number | null> {
    try {
      const res = await fetch(`${MAINNET_EXPLORER_URL}/api/v2/tokens/${token}`, {
        signal: AbortSignal.timeout(10_000),
        headers: { accept: 'application/json' },
      })
      if (!res.ok) return null
      const body = (await res.json()) as { holders_count?: string | null }
      const count = Number(body.holders_count ?? NaN)
      return Number.isFinite(count) && count >= 0 ? count : null
    } catch {
      return null
    }
  }

  private async launchFacts(
    token: string,
    now: number,
  ): Promise<{ devSold: boolean | null; ageS: number | null; launchpad: string | null }> {
    const row = this.store.getToken(token)
    const ageS = row?.firstSeenS != null ? Math.max(0, now - row.firstSeenS) : null
    const launchpad = row?.launchpad ?? null
    if (!row?.creator) return { devSold: null, ageS, launchpad }
    try {
      const balance = await this.client.public.readContract({
        address: token as Address,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [row.creator as Address],
      })
      return { devSold: balance === 0n, ageS, launchpad }
    } catch {
      return { devSold: null, ageS, launchpad }
    }
  }
}
