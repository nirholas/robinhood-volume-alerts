/**
 * Mock-free verification run: the full live pipeline against Robinhood Chain
 * mainnet with the console transport, no Telegram token required.
 *
 *   npm run dry-run                 10 minutes at the default sensitivity
 *   npm run dry-run -- --minutes 5 --spike 2 --vol 200 --swaps 3
 *
 * Loosening the gates (--spike/--vol/--swaps) makes quiet market stretches
 * still produce output so the run proves the pipeline end to end.
 */
import { SETTING_DEFAULTS } from '../src/config.js'
import { startApp } from '../src/index.js'
import { logger } from '../src/logger.js'

function arg(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`)
  if (i === -1 || i + 1 >= process.argv.length) return fallback
  const n = Number(process.argv[i + 1])
  return Number.isFinite(n) && n > 0 ? n : fallback
}

const minutes = arg('minutes', 10)
const spikeX = arg('spike', SETTING_DEFAULTS.spikeX)
const minVolumeUsd = arg('vol', SETTING_DEFAULTS.minVolumeUsd)
const minSwaps = arg('swaps', SETTING_DEFAULTS.minSwaps)

logger.info({ minutes, spikeX, minVolumeUsd, minSwaps }, 'dry run starting')

const app = await startApp({
  telegramToken: null,
  dbPath: process.env.DB_PATH?.trim() || './data/dry-run.db',
  defaults: { spikeX, minVolumeUsd, minSwaps, newTokens: true },
})

setTimeout(
  () => {
    logger.info(
      { trades: app.ingest.tradesIngested, alerts: app.detector.alertsEmitted },
      'dry run complete',
    )
    void app.stop().then(() => process.exit(0))
  },
  minutes * 60 * 1000,
)
