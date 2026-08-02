#!/usr/bin/env node
import { createHoodClient } from 'hoodchain'
import { loadConfig } from './config.js'
import { loadDotEnv } from './env.js'
import { Store } from './db.js'
import { EthPrice } from './chain/eth-price.js'
import { PoolRegistry } from './chain/pools.js'
import { TokenMetaCache } from './chain/token-meta.js'
import { TradeIngest } from './chain/ingest.js'
import { LaunchTracker } from './chain/launches.js'
import { Enricher } from './chain/enrich.js'
import { VolumeTracker } from './engine/window.js'
import { SpikeDetector, type EmitAlert } from './engine/detector.js'
import { LaunchpadDetectors, LiquidityMonitor, PriceMoveDetector, TradeDetectors } from './engine/detectors.js'
import { PerformanceTracker } from './engine/performance.js'
import type { Alert } from './engine/events.js'
import { TelegramAlertBot } from './telegram/bot.js'
import { renderAlertHtml } from './telegram/format.js'
import { logger } from './logger.js'

/** Blocks per minute at the chain's ~100ms cadence, used to size the backfill. */
const BLOCKS_PER_MINUTE = 600n

export interface App {
  stop: () => Promise<void>
  detector: SpikeDetector
  ingest: TradeIngest
  performance: PerformanceTracker
}

/**
 * Assemble and start the whole pipeline. When `telegramToken` is null the
 * console transport takes over: alerts print to stdout (tags stripped), which
 * is what `npm run dry-run` builds on. Everything upstream of delivery is
 * identical in both modes; there is no mock lane.
 */
export async function startApp(overrides: Partial<ReturnType<typeof loadConfig>> = {}): Promise<App> {
  loadDotEnv()
  const cfg = { ...loadConfig(), ...overrides }
  const store = new Store(cfg.dbPath, cfg.defaults)
  const client = createHoodClient(cfg.rpcUrl ? { rpcUrl: cfg.rpcUrl } : {})
  const ethPrice = new EthPrice(client)
  const pools = new PoolRegistry(client, store)
  const meta = new TokenMetaCache(client, store)
  const enricher = new Enricher(client, store, ethPrice, meta)
  const tracker = new VolumeTracker(store)
  const launchHistory = new LaunchTracker(client, store)

  const telegram = cfg.telegramToken ? new TelegramAlertBot(cfg.telegramToken, store, cfg, meta) : null
  if (!telegram) {
    logger.warn('TELEGRAM_BOT_TOKEN is not set: alerts print to the console only')
  }

  const performance = new PerformanceTracker(store, meta, async (alert) => void (await emit(alert)))

  const emit: EmitAlert = async (alert: Alert): Promise<void> => {
    logger.info({ kind: alert.kind, token: alert.token, symbol: alert.symbol }, 'alert')
    const recipients = telegram ? await telegram.deliver(alert) : ['console']
    if (!telegram) console.log(`\n${renderAlertHtml(alert).replace(/<[^>]+>/g, '')}\n`)
    performance.track(alert, recipients)
  }

  const spike = new SpikeDetector(store, tracker, enricher, meta, cfg, emit)
  const trades = new TradeDetectors(store, meta, enricher, cfg.defaults.whaleMinUsd, emit)
  const priceMoves = new PriceMoveDetector(store, meta, enricher, cfg.defaults.priceMovePct, emit)
  const liquidity = new LiquidityMonitor(client, store, ethPrice, meta, enricher, cfg.defaults.rugDropPct, emit)
  const launchpads = new LaunchpadDetectors(client, store, meta, emit)

  const head = await client.public.getBlockNumber()
  const backfillBlocks = BigInt(cfg.backfillMinutes) * BLOCKS_PER_MINUTE
  const fromBlock = head > backfillBlocks ? head - backfillBlocks : 0n
  logger.info(
    { head: String(head), fromBlock: String(fromBlock), backfillMinutes: cfg.backfillMinutes },
    'starting ingest with baseline backfill',
  )

  const ingest = new TradeIngest(
    client,
    pools,
    ethPrice,
    (trade) => {
      tracker.add(trade)
      // Trade-level detectors only run on live trades: replaying the
      // backfill would alert on whale prints that happened an hour ago.
      if (spike.live) trades.onTrade(trade)
    },
    {
      fromBlock,
      onCaughtUp: () => {
        spike.live = true
        launchpads.start()
        logger.info('backfill caught up to chain head, detection is live')
      },
      onError: (err) => logger.warn({ err: err.message }, 'ingest error'),
    },
  )

  ingest.start()
  await launchHistory.start()
  if (telegram) await telegram.start()

  const evalTimer = setInterval(() => {
    const nowS = Math.floor(Date.now() / 1000)
    void spike
      .tick(nowS)
      .then(() => (spike.live ? priceMoves.evaluate(tracker.activeTokens(nowS, 300), nowS) : undefined))
      .catch((err) => logger.error({ err: String(err) }, 'detector tick failed'))
  }, cfg.evalIntervalS * 1000)

  const slowTimer = setInterval(() => {
    if (!spike.live) return
    void liquidity.poll().catch((err) => logger.warn({ err: String(err) }, 'liquidity poll failed'))
    void performance.poll().catch((err) => logger.warn({ err: String(err) }, 'performance poll failed'))
  }, 60_000)

  const statsTimer = setInterval(() => {
    logger.info(
      {
        trades: ingest.tradesIngested,
        lastBlock: String(ingest.lastBlock),
        spikes: spike.alertsEmitted,
        whales: trades.whaleAlerts,
        wallets: trades.walletAlerts,
        priceMoves: priceMoves.alerts,
        rugs: liquidity.alerts,
        launches: launchpads.launches,
        graduations: launchpads.graduations,
        milestones: performance.milestonesEmitted,
      },
      'pipeline stats',
    )
  }, 60_000)

  const stop = async (): Promise<void> => {
    clearInterval(evalTimer)
    clearInterval(slowTimer)
    clearInterval(statsTimer)
    ingest.stop()
    launchpads.stop()
    if (telegram) await telegram.stop()
    store.close()
  }

  return { stop, detector: spike, ingest, performance }
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
