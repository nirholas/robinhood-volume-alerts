import { describe, expect, it } from 'vitest'
import { TradeIngest, makeTimestampInterpolator, type Trade } from '../src/chain/ingest.js'
import type { EthPrice } from '../src/chain/eth-price.js'
import type { PoolRegistry } from '../src/chain/pools.js'

/**
 * The public RPC caps `eth_getLogs` at 10 000 results. Because the ingest
 * cursor only advances after a range is delivered, an unhandled cap error
 * stalls ingest forever on the same range, which is exactly what happened
 * before the adaptive split landed. These tests drive the real class against
 * a fake RPC that enforces a cap, so a regression re-stalls the suite rather
 * than production.
 */
function makeFakeClient(options: {
  head: bigint
  /** Ranges wider than this many blocks are rejected like the real cap. */
  capWidth: bigint
  /** Records every getLogs range attempted. */
  attempts: Array<{ from: bigint; to: bigint }>
}) {
  return {
    network: 'mainnet',
    public: {
      getBlockNumber: async () => options.head,
      getBlock: async ({ blockNumber }: { blockNumber: bigint }) => ({
        timestamp: BigInt(1_780_000_000) + blockNumber / 10n,
      }),
      getLogs: async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
        options.attempts.push({ from: fromBlock, to: toBlock })
        if (toBlock - fromBlock + 1n > options.capWidth) {
          throw new Error('Details: logs matched by query exceeds limit of 10000')
        }
        return []
      },
    },
  } as never
}

const pools = { classify: async () => null } as unknown as PoolRegistry
const ethPrice = { get: async () => 2000, lastKnown: 2000 } as unknown as EthPrice

describe('TradeIngest range handling', () => {
  it('splits a range that trips the provider result cap and still covers it', async () => {
    const attempts: Array<{ from: bigint; to: bigint }> = []
    const client = makeFakeClient({ head: 1001n, capWidth: 250n, attempts })
    const trades: Trade[] = []

    const ingest = new TradeIngest(client, pools, ethPrice, (t) => trades.push(t), {
      fromBlock: 1n,
      chunkSize: 1000n,
      pollingIntervalMs: 60_000,
    })
    ingest.start()
    await new Promise((resolve) => setTimeout(resolve, 250))
    ingest.stop()

    // The cursor advanced past the whole span despite the cap.
    expect(ingest.lastBlock).toBeGreaterThanOrEqual(1000n)

    // Every block in the span was covered by some successful (uncapped) call.
    const covered = attempts
      .filter((a) => a.to - a.from + 1n <= 250n)
      .sort((a, b) => Number(a.from - b.from))
    expect(covered.length).toBeGreaterThan(1)
    let reach = 0n
    for (const range of covered) {
      if (range.from <= reach + 1n && range.to > reach) reach = range.to
    }
    expect(reach).toBeGreaterThanOrEqual(1000n)
  })

  it('gives up on a non-cap error instead of splitting forever', async () => {
    const attempts: Array<{ from: bigint; to: bigint }> = []
    const client = {
      network: 'mainnet',
      public: {
        getBlockNumber: async () => 500n,
        getBlock: async () => ({ timestamp: 1_780_000_000n }),
        getLogs: async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
          attempts.push({ from: fromBlock, to: toBlock })
          throw new Error('connection reset')
        },
      },
    } as never

    const errors: Error[] = []
    const ingest = new TradeIngest(client, pools, ethPrice, () => undefined, {
      fromBlock: 1n,
      chunkSize: 100n,
      pollingIntervalMs: 60_000,
      onError: (err) => errors.push(err),
    })
    ingest.start()
    await new Promise((resolve) => setTimeout(resolve, 150))
    ingest.stop()

    expect(errors.length).toBeGreaterThan(0)
    // One attempt per poll, no recursive fan-out on a transport error.
    expect(attempts.length).toBeLessThan(5)
    // The cursor stayed put so the range is retried rather than skipped.
    expect(ingest.lastBlock).toBe(0n)
  })
})

describe('timestamp interpolation', () => {
  it('maps block numbers linearly across a chunk', () => {
    const tsOf = makeTimestampInterpolator(1000n, 50_000, 2000n, 50_100)
    expect(tsOf(1500n)).toBe(50_050)
  })
})
