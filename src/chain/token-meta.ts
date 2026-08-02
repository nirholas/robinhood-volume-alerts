import { erc20Abi, type HoodClient } from 'hoodchain'
import type { Address } from 'viem'
import type { Store } from '../db.js'

export interface TokenMeta {
  symbol: string | null
  name: string | null
  decimals: number | null
  /** Raw total supply as a decimal string, or null when unreadable. */
  totalSupply: string | null
}

interface CacheEntry extends TokenMeta {
  fetchedAt: number
}

/**
 * Symbol/name/decimals/totalSupply cache for arbitrary ERC-20s, backed by
 * SQLite. Static fields never refetch; totalSupply refreshes after a TTL so
 * market caps track mints and burns. Failures cache as nulls so a broken
 * token does not hammer the RPC on every alert evaluation.
 */
export class TokenMetaCache {
  private readonly cache = new Map<string, CacheEntry>()

  constructor(
    private readonly client: HoodClient,
    private readonly store: Store,
    private readonly supplyTtlS = 600,
  ) {}

  async get(token: Address): Promise<TokenMeta> {
    const key = token.toLowerCase()
    const now = Math.floor(Date.now() / 1000)
    const hit = this.cache.get(key)
    if (hit && now - hit.fetchedAt < this.supplyTtlS) return hit

    const stored = this.store.getToken(key)
    if (!hit && stored?.symbol && stored.decimals !== null && stored.totalSupply !== null) {
      // Warm start from SQLite; still schedule a live refresh via TTL by
      // stamping fetchedAt in the past enough to refresh supply soon.
      const entry: CacheEntry = {
        symbol: stored.symbol,
        name: stored.name,
        decimals: stored.decimals,
        totalSupply: stored.totalSupply,
        fetchedAt: now - this.supplyTtlS + 60,
      }
      this.cache.set(key, entry)
      return entry
    }

    const entry = await this.fetch(token, key, now, hit ?? null)
    this.cache.set(key, entry)
    if (this.cache.size > 8000) {
      const first = this.cache.keys().next().value
      if (first) this.cache.delete(first)
    }
    return entry
  }

  private async fetch(token: Address, key: string, now: number, previous: CacheEntry | null): Promise<CacheEntry> {
    try {
      const [symbol, name, decimals, totalSupply] = await this.client.public.multicall({
        contracts: [
          { address: token, abi: erc20Abi, functionName: 'symbol' },
          { address: token, abi: erc20Abi, functionName: 'name' },
          { address: token, abi: erc20Abi, functionName: 'decimals' },
          { address: token, abi: erc20Abi, functionName: 'totalSupply' },
        ],
        allowFailure: true,
      })
      const entry: CacheEntry = {
        symbol: symbol.status === 'success' ? String(symbol.result).slice(0, 32) : (previous?.symbol ?? null),
        name: name.status === 'success' ? String(name.result).slice(0, 64) : (previous?.name ?? null),
        decimals: decimals.status === 'success' ? Number(decimals.result) : (previous?.decimals ?? null),
        totalSupply: totalSupply.status === 'success' ? String(totalSupply.result) : (previous?.totalSupply ?? null),
        fetchedAt: now,
      }
      this.store.upsertToken({
        token: key,
        symbol: entry.symbol,
        name: entry.name,
        decimals: entry.decimals,
        totalSupply: entry.totalSupply,
      })
      return entry
    } catch {
      return previous ?? { symbol: null, name: null, decimals: null, totalSupply: null, fetchedAt: now }
    }
  }
}
