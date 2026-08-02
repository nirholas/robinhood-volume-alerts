import { MAINNET_ADDRESSES, type HoodClient } from 'hoodchain'
import { loadPoolInfo } from 'hoodkit'
import type { Address } from 'viem'
import type { PoolRow, Store } from '../db.js'
import { logger } from '../logger.js'

/**
 * Pool classifier. The chain-wide swap scan sees every contract that emits a
 * v3-style `Swap` event; this registry resolves each one once (token0/token1/
 * decimals via multicall), decides which side is the tradable token and which
 * is the dollar-priceable quote (USDG or WETH), and caches the answer in
 * SQLite so restarts never re-probe.
 *
 * Pools that pair two arbitrary tokens (no USDG/WETH side), pools whose base
 * IS a quote asset (the WETH/USDG pool itself), and contracts that turn out
 * not to be pools are cached as skipped (`token: null`).
 */
export class PoolRegistry {
  private readonly memory = new Map<string, PoolRow | null>()
  private readonly inflight = new Map<string, Promise<PoolRow | null>>()

  constructor(
    private readonly client: HoodClient,
    private readonly store: Store,
  ) {}

  /** Resolve a pool to its classification. `null` means "ignore this pool". */
  async classify(pool: Address): Promise<PoolRow | null> {
    const key = pool.toLowerCase()
    if (this.memory.has(key)) return this.memory.get(key) ?? null

    const stored = this.store.getPool(key)
    if (stored) {
      const value = stored.token === null ? null : stored
      this.memory.set(key, value)
      return value
    }

    const pending = this.inflight.get(key)
    if (pending) return pending

    const promise = this.load(pool, key)
    this.inflight.set(key, promise)
    try {
      return await promise
    } finally {
      this.inflight.delete(key)
    }
  }

  private async load(pool: Address, key: string): Promise<PoolRow | null> {
    const usdg = MAINNET_ADDRESSES.usdg.toLowerCase()
    const weth = MAINNET_ADDRESSES.weth.toLowerCase()
    let row: PoolRow
    try {
      const info = await loadPoolInfo(this.client, pool)
      const t0 = info.token0.toLowerCase()
      const t1 = info.token1.toLowerCase()
      const quoteSide = t1 === usdg || t1 === weth ? 1 : t0 === usdg || t0 === weth ? 0 : null
      if (quoteSide === null) {
        // Two arbitrary tokens: no reliable dollar leg.
        row = { pool: key, token: null, quote: null, tokenIs0: 0, decimalsToken: 18, decimalsQuote: 18 }
      } else {
        const quoteAddr = quoteSide === 1 ? t1 : t0
        const tokenAddr = quoteSide === 1 ? t0 : t1
        if (tokenAddr === usdg || tokenAddr === weth) {
          // WETH/USDG (or USDG/WETH): the quote assets trading each other.
          row = { pool: key, token: null, quote: null, tokenIs0: 0, decimalsToken: 18, decimalsQuote: 18 }
        } else {
          row = {
            pool: key,
            token: tokenAddr,
            quote: quoteAddr === usdg ? 'USDG' : 'WETH',
            tokenIs0: quoteSide === 1 ? 1 : 0,
            decimalsToken: quoteSide === 1 ? info.decimals0 : info.decimals1,
            decimalsQuote: quoteSide === 1 ? info.decimals1 : info.decimals0,
          }
        }
      }
    } catch (error) {
      // Not a readable v3 pool (a fork with a different meta ABI, or a
      // non-pool contract reusing the event signature). Skip it permanently.
      logger.debug({ pool: key, err: String(error) }, 'pool classification failed, skipping')
      row = { pool: key, token: null, quote: null, tokenIs0: 0, decimalsToken: 18, decimalsQuote: 18 }
    }
    this.store.savePool(row)
    const value = row.token === null ? null : row
    this.memory.set(key, value)
    return value
  }
}
