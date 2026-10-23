import { describe, expect, it } from 'vitest'
import { TradeIngest, makeTimestampInterpolator } from '../src/chain/ingest.js'
import type { EthPrice } from '../src/chain/eth-price.js'
import type { PoolRegistry } from '../src/chain/pools.js'

type Attempt = { from: bigint; to: bigint }

/**
 * The public RPC caps `eth_getLogs` at 10 000 results. Because the ingest
 * cursor only advances after a range is delivered, an unhandled cap error
 * stalls ingest forever on the same range, which is exactly what happened
 * before the adaptive split landed. These tests drive the real class against
 * a fake RPC, so a regression re-stalls the suite rather than production.
 */
function makeFakeClient(options: {
  head: bigint
  attempts: Attempt[]
  getLogs: (range: Attempt) => Promise<unknown>
}) {
  return {
    network: 'mainnet',
    public: {
      getBlockNumber: async () => options.head,
      getBlock: async ({ blockNumber }: { blockNumber: bigint }) => ({
        timestamp: BigInt(1_780_000_000) + blockNumber / 10n,
      }),
      getLogs: async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
        const range = { from: fromBlock, to: toBlock }
        options.attempts.push(range)
        return options.getLogs(range)
      },
    },
  } as never
}

const pools = { classify: async () => null } as unknown as PoolRegistry
const ethPrice = { get: async () => 2000, lastKnown: 2000 } as unknown as EthPrice

/**
 * Run the first tick with a failing getLogs and stop on its error. The caller
 * can flip getLogs to success and start another tick to check what was kept.
 */
async function runUntilError(message: string) {
  const attempts: Attempt[] = []
  let fail = true
  const client = makeFakeClient({
    head: 3001n,
    attempts,
    getLogs: async () => {
      if (fail) throw new Error(message)
      return []
    },
  })

  let resolveError!: (error: Error) => void
  const firstError = new Promise<Error>((resolve) => {
    resolveError = resolve
  })
  let resolveCaughtUp!: () => void
  const caughtUp = new Promise<void>((resolve) => {
    resolveCaughtUp = resolve
  })

  let ingest!: TradeIngest
  ingest = new TradeIngest(client, pools, ethPrice, () => undefined, {
    fromBlock: 1n,
    chunkSize: 3000n,
    pollingIntervalMs: 60_000,
    onError: (error) => {
      ingest.stop()
      resolveError(error)
    },
    onCaughtUp: resolveCaughtUp,
  })

  ingest.start()
  const error = await firstError
  return {
    error,
    ingest,
    attempts,
    caughtUp,
    succeed: () => {
      fail = false
    },
  }
}

// Throttling must lose to no other signal. The 429 case deliberately wraps a
// cap phrase to pin the precedence between the two rules.
const nonCapErrors = [
  ['rate limit exceeded', true],
  ['request rate exceeds limit', false],
  ['daily quota exceeded', false],
  ['too many requests', false],
  ['HTTP 429: logs matched by query exceeds limit of 10000', false],
  ['limit exceeded', true],
  ['execution limit exceeded', false],
  ['connection reset', false],
] as const

const capErrors = [
  'logs matched by query exceeds limit of 10000',
  'query returned more than 10000 results',
  'too many results',
  'query block range exceeds server limit, narrow your filter: 1000',
] as const

describe('TradeIngest range handling', () => {
  it.each(nonCapErrors)('keeps the original range for %s', async (message, verifyRetry) => {
    const run = await runUntilError(message)

    expect(run.error.message).toBe(message)
    expect(run.ingest.lastBlock).toBe(0n)
    // Both scans were attempted once on the original range, with no fan-out.
    expect(run.attempts).toEqual([
      { from: 1n, to: 3000n },
      { from: 1n, to: 3000n },
    ])

    if (!verifyRetry) return

    // A later success must use the same range and chunk, and advance the
    // cursor across the whole span without a gap.
    run.attempts.length = 0
    run.succeed()
    run.ingest.start()
    await run.caughtUp
    run.ingest.stop()

    expect(run.ingest.lastBlock).toBe(3000n)
    expect(run.attempts).toEqual([
      { from: 1n, to: 3000n },
      { from: 1n, to: 3000n },
    ])
  })

  it.each(capErrors)('splits a range that trips the provider cap: %s', async (message) => {
    const attempts: Attempt[] = []
    const client = makeFakeClient({
      head: 1001n,
      attempts,
      getLogs: async ({ from, to }) => {
        if (to - from + 1n > 250n) throw new Error(message)
        return []
      },
    })

    let ingest!: TradeIngest
    const done = new Promise<void>((resolve, reject) => {
      ingest = new TradeIngest(client, pools, ethPrice, () => undefined, {
        fromBlock: 1n,
        chunkSize: 1000n,
        pollingIntervalMs: 60_000,
        onError: (error) => {
          ingest.stop()
          reject(error)
        },
        onCaughtUp: resolve,
      })
    })

    ingest.start()
    await done
    ingest.stop()

    // The cursor advanced past the whole span despite the cap.
    expect(ingest.lastBlock).toBe(1000n)

    // Every block in the span was covered by some successful (uncapped) call.
    const covered = attempts.filter((a) => a.to - a.from + 1n <= 250n).sort((a, b) => Number(a.from - b.from))
    expect(covered.length).toBeGreaterThan(1)
    let reach = 0n
    for (const range of covered) {
      if (range.from <= reach + 1n && range.to > reach) reach = range.to
    }
    expect(reach).toBeGreaterThanOrEqual(1000n)
  })
})

describe('timestamp interpolation', () => {
  it('maps block numbers linearly across a chunk', () => {
    const tsOf = makeTimestampInterpolator(1000n, 50_000, 2000n, 50_100)
    expect(tsOf(1500n)).toBe(50_050)
  })
})
