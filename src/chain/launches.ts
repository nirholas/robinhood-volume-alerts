import {
  NOXA_ADDRESSES,
  ODYSSEY_ADDRESSES,
  noxaTokenLaunchedEvent,
  odysseyTokenCreatedEvent,
  watchLaunches,
  type HoodClient,
} from 'hoodchain'
import type { Address } from 'viem'
import { logger } from '../logger.js'
import type { Store } from '../db.js'

const ODYSSEY_FACTORIES: Address[] = [
  ODYSSEY_ADDRESSES.bondingCurveFactory,
  ODYSSEY_ADDRESSES.reflectionFactory,
  ODYSSEY_ADDRESSES.instantFactory,
]

const CURSOR_KEY = 'launch_scan_block'

/**
 * Keeps the tokens table stocked with creator, launchpad, and first-seen
 * facts from NOXA and The Odyssey. Those three fields power the "Age",
 * "Platform", and "dev sold" lines on alert cards.
 *
 * The first run scans the whole launch history, from NOXA's deploy block to
 * the head, and stores its cursor in SQLite; every later start only scans
 * the gap since the previous run. Launches are rare events on a factory
 * address filter, so even the initial full scan is a few hundred cheap
 * `eth_getLogs` calls, done once, in the background. Each launch gets its
 * exact block timestamp (one `getBlock` per launch), so ages are real, not
 * estimates. A live watcher covers everything after the scan.
 */
export class LaunchTracker {
  private unwatch: (() => void) | null = null
  private scanning = false

  constructor(
    private readonly client: HoodClient,
    private readonly store: Store,
    private readonly chunkSize: bigint = 50_000n,
  ) {}

  async start(): Promise<void> {
    this.unwatch = watchLaunches(
      this.client,
      (launch) => {
        this.store.upsertToken({
          token: launch.token.toLowerCase(),
          creator: launch.creator.toLowerCase(),
          launchpad: launch.launchpad,
          firstSeenS: Math.floor(Date.now() / 1000),
        })
      },
      { onError: (err) => logger.warn({ err: String(err) }, 'launch watcher error') },
    )
    void this.scan().catch((err) => logger.warn({ err: String(err) }, 'launch history scan failed'))
  }

  stop(): void {
    this.unwatch?.()
    this.unwatch = null
  }

  private async scan(): Promise<void> {
    if (this.scanning) return
    this.scanning = true
    try {
      const head = await this.client.public.getBlockNumber()
      const stored = this.store.getState(CURSOR_KEY)
      const start = stored ? BigInt(stored) : NOXA_ADDRESSES.deployBlock
      if (start > head) return
      logger.info({ from: String(start), to: String(head) }, 'scanning launch history')

      let found = 0
      for (let from = start; from <= head; from += this.chunkSize) {
        const to = from + this.chunkSize - 1n > head ? head : from + this.chunkSize - 1n
        const [noxaLogs, odysseyLogs] = await Promise.all([
          this.client.public.getLogs({
            address: NOXA_ADDRESSES.launchFactory,
            event: noxaTokenLaunchedEvent,
            fromBlock: from,
            toBlock: to,
          }),
          this.client.public.getLogs({
            address: ODYSSEY_FACTORIES,
            event: odysseyTokenCreatedEvent,
            fromBlock: from,
            toBlock: to,
          }),
        ])
        for (const log of noxaLogs) {
          await this.record(log.args.token as Address, log.args.deployer as Address, 'noxa', log.blockNumber)
          found++
        }
        for (const log of odysseyLogs) {
          await this.record(log.args.token as Address, log.args.creator as Address, 'odyssey', log.blockNumber)
          found++
        }
        // Persist progress after every chunk so an interrupted scan resumes
        // where it stopped instead of starting over.
        this.store.setState(CURSOR_KEY, String(to + 1n))
      }
      logger.info({ launches: found, upTo: String(head) }, 'launch history scan complete')
    } finally {
      this.scanning = false
    }
  }

  private async record(token: Address, creator: Address, launchpad: 'noxa' | 'odyssey', blockNumber: bigint): Promise<void> {
    let firstSeenS: number | null = null
    try {
      const block = await this.client.public.getBlock({ blockNumber })
      firstSeenS = Number(block.timestamp)
    } catch {
      // Age stays unknown for this launch; the card omits the line.
    }
    this.store.upsertToken({
      token: token.toLowerCase(),
      creator: creator.toLowerCase(),
      launchpad,
      ...(firstSeenS !== null ? { firstSeenS } : {}),
    })
  }
}
