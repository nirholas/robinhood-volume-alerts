#!/usr/bin/env node
import { createHoodClient } from 'hoodchain'
import { loadConfig } from './config.js'
import { Store } from './db.js'
import { EthPrice } from './chain/eth-price.js'
import { PoolRegistry } from './chain/pools.js'
import { TokenMetaCache } from './chain/token-meta.js'
import { TradeIngest } from './chain/ingest.js'
import { LaunchTracker } from './chain/launches.js'
import { Enricher } from './chain/enrich.js'
import { VolumeTracker } from './engine/window.js'
import { SpikeDetector, type SpikeAlert } from './engine/detector.js'
import { TelegramAlertBot } from './telegram/bot.js'
import { renderAlertHtml } from './telegram/format.js'
import { logger } from './logger.js'

/** Blocks per minute at the chain's ~100ms cadence, used to size the backfill. */
const BLOCKS_PER_MINUTE = 600n

export interface App {
  stop: () => Promise<void>
  detector: SpikeDetector
  ingest: TradeIngest
}

/**
 * Assemble and start the whole pipeline. When `telegramToken` is null the
 * console transport takes over: alerts print to stdout (tags stripped), which
 * is what `npm run dry-run` builds on. Everything upstream of delivery is
 * identical in both modes; there is no mock lane.
 */
export async function startApp(overrides: Partial<ReturnType<typeof loadConfig>> = {}): Promise<App> {
  const cfg = { ...loadConfig(), ...overrides }
  const store = new Store(cfg.dbPath, cfg.defaults)
  const client = createHoodClient(cfg.rpcUrl ? { rpcUrl: cfg.rpcUrl } : {})
  const ethPrice = new EthPrice(client)
  const pools = new PoolRegistry(client, store)
  const meta = new TokenMetaCache(client, store)
  const enricher = new Enricher(client, store, ethPrice, meta)
  const tracker = new VolumeTracker(store)
  const launches = new LaunchTracker(client, store)

  const telegram = cfg.telegramToken ? new TelegramAlertBot(cfg.telegramToken, store, cfg) : null
  if (!telegram) {
    logger.warn('TELEGRAM_BOT_TOKEN is not set: alerts print to the console only')
  }

  const deliver = async (alert: SpikeAlert): Promise<void> => {
    logger.info(
      { token: alert.token, symbol: alert.symbol, multiple: Number(alert.multiple.toFixed(1)), volumeUsd: Math.round(alert.volumeUsd) },
      'spike detected',
    )
    if (telegram) await telegram.deliver(alert)
    else console.log(`\n${renderAlertHtml(alert).replace(/<[^>]+>/g, '')}\n`)
  }

  const detector = new SpikeDetector(store, tracker, enricher, meta, cfg, deliver)

  const head = await client.public.getBlockNumber()
  const backfillBlocks = BigInt(cfg.backfillMinutes) * BLOCKS_PER_MINUTE
  const fromBlock = head > backfillBlocks ? head - backfillBlocks : 0n
  logger.info(
    { head: String(head), fromBlock: String(fromBlock), backfillMinutes: cfg.backfillMinutes },
    'starting ingest with baseline backfill',
  )

  const ingest = new TradeIngest(client, pools, ethPrice, (trade) => tracker.add(trade), {
    fromBlock,
    onCaughtUp: () => {
      detector.live = true
      logger.info('backfill caught up to chain head, spike detection is live')
    },
    onError: (err) => logger.warn({ err: err.message }, 'ingest error'),
  })

  ingest.start()
  await launches.start()
  if (telegram) await telegram.start()

  const evalTimer = setInterval(() => {
    void detector.tick().catch((err) => logger.error({ err: String(err) }, 'detector tick failed'))
  }, cfg.evalIntervalS * 1000)

  const statsTimer = setInterval(() => {
    logger.info(
      { trades: ingest.tradesIngested, lastBlock: String(ingest.lastBlock), alerts: detector.alertsEmitted },
      'pipeline stats',
    )
  }, 60_000)

  const stop = async (): Promise<void> => {
    clearInterval(evalTimer)
    clearInterval(statsTimer)
    ingest.stop()
    launches.stop()
    if (telegram) await telegram.stop()
    store.close()
  }

  return { stop, detector, ingest }
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop() ?? '')
if (isMain) {
  const app = await startApp()
  const shutdown = (signal: string): void => {
    logger.info({ signal }, 'shutting down')
    void app.stop().then(() => process.exit(0))
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}
