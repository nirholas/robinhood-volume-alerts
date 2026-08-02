import { ODYSSEY_ADDRESSES, odysseyTradedEvent, type HoodClient } from 'hoodchain'
import { uniswapV3SwapEvent } from 'hoodkit'
import { decodeEventLog, type Address, type Hash, type Log } from 'viem'
import { logger } from '../logger.js'
import type { EthPrice } from './eth-price.js'
import type { PoolRegistry } from './pools.js'

/** One normalized on-chain trade, in USD terms. */
export interface Trade {
  /** The traded token's address, lowercase. */
  token: string
  /** Executed token price in USD (0 when it could not be derived). */
  priceUsd: number
  /** Trade size in USD, always positive. */
  volumeUsd: number
  isBuy: boolean
  /** Unix seconds (block timestamp, interpolated inside a chunk). */
  ts: number
  blockNumber: bigint
  txHash: Hash
  venue: 'uniswap-v3' | 'odyssey-curve'
}

export interface IngestOptions {
  /** Backfill from this block before going live. Omit for live-only. */
  fromBlock?: bigint
  /** Poll interval in ms. Default 2000. */
  pollingIntervalMs?: number
  /** Max blocks per eth_getLogs. Default 3000 (about 5 minutes of chain). */
  chunkSize?: bigint
  onError?: (error: Error) => void
  /** Called once the cursor has caught up to the chain head. */
  onCaughtUp?: () => void
}

const ODYSSEY_FACTORIES: Address[] = [
  ODYSSEY_ADDRESSES.bondingCurveFactory,
  ODYSSEY_ADDRESSES.reflectionFactory,
  ODYSSEY_ADDRESSES.instantFactory,
]

/**
 * Chain-wide trade ingester for Robinhood Chain.
 *
 * Two log scans drive it, both gap-filled by a persistent block cursor that
 * only advances after a range is fully decoded and delivered (the hoodkit
 * log-cursor pattern, reimplemented here because pool classification is
 * async):
 *
 * 1. every v3-style `Swap` event on the chain, with NO address filter, so
 *    every DEX pool (canonical Uniswap and forks alike) is covered the
 *    moment it trades;
 * 2. The Odyssey launchpad's `Traded` events, so bonding-curve volume counts
 *    before a token graduates to a pool.
 *
 * Timestamps: logs carry none, so each chunk reads its boundary blocks and
 * linearly interpolates per block number. At ~100ms per block the error is
 * negligible for one-minute bucketing.
 */
export class TradeIngest {
  private cursor: bigint | null
  private stopped = false
  private timer: ReturnType<typeof setTimeout> | null = null
  private caughtUp = false
  /** Diagnostics. */
  tradesIngested = 0
  lastBlock: bigint = 0n

  constructor(
    private readonly client: HoodClient,
    private readonly pools: PoolRegistry,
    private readonly ethPrice: EthPrice,
    private readonly onTrade: (trade: Trade) => void,
    private readonly options: IngestOptions = {},
  ) {
    this.cursor = options.fromBlock ?? null
  }

  start(): void {
    this.stopped = false
    void this.tick()
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
  }

  private schedule(): void {
    if (this.stopped) return
    this.timer = setTimeout(() => void this.tick(), this.options.pollingIntervalMs ?? 2000)
  }

  private async tick(): Promise<void> {
    if (this.stopped) return
    const chunk = this.options.chunkSize ?? 3000n
    try {
      const head = await this.client.public.getBlockNumber()
      const safeHead = head > 1n ? head - 1n : 0n
      if (this.cursor === null) this.cursor = safeHead + 1n

      let from: bigint = this.cursor
      while (from <= safeHead) {
        if (this.stopped) return
        const to: bigint = from + chunk - 1n > safeHead ? safeHead : from + chunk - 1n
        await this.processRange(from, to)
        // Advance only after full delivery; an error above leaves the cursor
        // on the failed range so the next tick retries it.
        this.cursor = to + 1n
        this.lastBlock = to
        from = to + 1n
      }
      if (!this.caughtUp) {
        this.caughtUp = true
        this.options.onCaughtUp?.()
      }
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error))
      this.options.onError?.(err)
      logger.warn({ err: err.message }, 'ingest tick failed, range will be retried')
    } finally {
      this.schedule()
    }
  }

  private async processRange(from: bigint, to: bigint): Promise<void> {
    const [swapLogs, curveLogs, fromBlock, toBlock] = await Promise.all([
      this.client.public.getLogs({ event: uniswapV3SwapEvent, fromBlock: from, toBlock: to }),
      this.client.public.getLogs({ address: ODYSSEY_FACTORIES, event: odysseyTradedEvent, fromBlock: from, toBlock: to }),
      this.client.public.getBlock({ blockNumber: from }),
      to === from ? null : this.client.public.getBlock({ blockNumber: to }),
    ])
    const tsOf = makeTimestampInterpolator(from, Number(fromBlock.timestamp), to, Number((toBlock ?? fromBlock).timestamp))

    const eth = (await this.ethPrice.get()) ?? this.ethPrice.lastKnown

    for (const log of swapLogs) {
      const trade = await this.decodeSwap(log, tsOf, eth)
      if (trade) {
        this.tradesIngested++
        this.onTrade(trade)
      }
    }
    for (const log of curveLogs) {
      const trade = this.decodeCurveTrade(log, tsOf, eth)
      if (trade) {
        this.tradesIngested++
        this.onTrade(trade)
      }
    }
  }

  private async decodeSwap(log: Log, tsOf: (block: bigint) => number, eth: number | null): Promise<Trade | null> {
    if (!log.address || log.blockNumber === null || log.transactionHash === null) return null
    let args: { amount0: bigint; amount1: bigint; sqrtPriceX96: bigint }
    try {
      const decoded = decodeEventLog({ abi: [uniswapV3SwapEvent], data: log.data, topics: log.topics })
      args = decoded.args as unknown as { amount0: bigint; amount1: bigint; sqrtPriceX96: bigint }
    } catch {
      return null
    }
    const pool = await this.pools.classify(log.address)
    if (!pool || pool.token === null || pool.quote === null) return null

    const quoteUsd = pool.quote === 'USDG' ? 1 : eth
    if (quoteUsd === null || quoteUsd <= 0) return null

    const tokenAmt = pool.tokenIs0 === 1 ? args.amount0 : args.amount1
    const quoteAmt = pool.tokenIs0 === 1 ? args.amount1 : args.amount0
    const volumeQuote = Math.abs(toHuman(quoteAmt, pool.decimalsQuote))
    const volumeToken = Math.abs(toHuman(tokenAmt, pool.decimalsToken))
    const volumeUsd = volumeQuote * quoteUsd
    if (!Number.isFinite(volumeUsd) || volumeUsd <= 0) return null

    const priceUsd = volumeToken > 0 ? volumeUsd / volumeToken : 0

    return {
      token: pool.token,
      priceUsd,
      volumeUsd,
      // Token flowed OUT of the pool (negative delta) means the trader bought it.
      isBuy: tokenAmt < 0n,
      ts: tsOf(log.blockNumber),
      blockNumber: log.blockNumber,
      txHash: log.transactionHash,
      venue: 'uniswap-v3',
    }
  }

  private decodeCurveTrade(log: Log, tsOf: (block: bigint) => number, eth: number | null): Trade | null {
    if (log.blockNumber === null || log.transactionHash === null) return null
    let args: { token: Address; isBuy: boolean; tokenAmount: bigint; quoteAmount: bigint }
    try {
      const decoded = decodeEventLog({ abi: [odysseyTradedEvent], data: log.data, topics: log.topics })
      args = decoded.args as unknown as { token: Address; isBuy: boolean; tokenAmount: bigint; quoteAmount: bigint }
    } catch {
      return null
    }
    if (eth === null || eth <= 0) return null
    const quoteEth = toHuman(args.quoteAmount, 18)
    const tokenAmount = toHuman(args.tokenAmount, 18)
    const volumeUsd = Math.abs(quoteEth) * eth
    if (!Number.isFinite(volumeUsd) || volumeUsd <= 0) return null
    return {
      token: args.token.toLowerCase(),
      priceUsd: tokenAmount > 0 ? volumeUsd / Math.abs(tokenAmount) : 0,
      volumeUsd,
      isBuy: args.isBuy,
      ts: tsOf(log.blockNumber),
      blockNumber: log.blockNumber,
      txHash: log.transactionHash,
      venue: 'odyssey-curve',
    }
  }
}

/** Linear block-number -> unix-seconds interpolator over one chunk. */
export function makeTimestampInterpolator(
  fromBlock: bigint,
  fromTs: number,
  toBlock: bigint,
  toTs: number,
): (block: bigint) => number {
  const span = Number(toBlock - fromBlock)
  if (span <= 0) return () => fromTs
  const perBlock = (toTs - fromTs) / span
  return (block: bigint) => Math.round(fromTs + Number(block - fromBlock) * perBlock)
}

function toHuman(raw: bigint, decimals: number): number {
  const negative = raw < 0n
  const abs = negative ? -raw : raw
  return ((negative ? -1 : 1) * Number(abs)) / 10 ** decimals
}
