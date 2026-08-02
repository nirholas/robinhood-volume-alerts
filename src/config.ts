import { ALERT_KINDS, type AlertKind } from './engine/events.js'

/** Per-chat tunables. Every field is settable from the Telegram keyboard. */
export interface Defaults {
  /** Rolling-minute volume must be at least this many times the baseline. */
  spikeX: number
  /** Ignore spikes smaller than this many USD in the spiking minute. */
  minVolumeUsd: number
  /** Ignore spikes with fewer swaps than this in the spiking minute. */
  minSwaps: number
  /** Whether tokens younger than an hour alert at all. */
  newTokens: boolean
  /** Which alert families are delivered. */
  kinds: AlertKind[]
  /** Single-trade dollar floor for whale alerts. */
  whaleMinUsd: number
  /** Absolute percent move over 5 minutes that triggers a price alert. */
  priceMovePct: number
  /** Percent liquidity drop that triggers a rug warning. */
  rugDropPct: number
}

export interface Config {
  telegramToken: string | null
  /** Channel (@name or -100… id) that mirrors the feed at default sensitivity. */
  telegramChannelId: string | null
  rpcUrl: string | undefined
  dbPath: string
  baselineMinutes: number
  evalIntervalS: number
  cooldownMinutes: number
  backfillMinutes: number
  logLevel: string
  defaults: Defaults
}

function num(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value === '') return fallback
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a positive number, got "${value}"`)
  return n
}

/** Settings for a chat that has never touched the keyboard. */
export const SETTING_DEFAULTS: Defaults = {
  spikeX: 4,
  minVolumeUsd: 3000,
  minSwaps: 10,
  newTokens: true,
  // Wallet trades need a watchlist to fire, so enabling them by default costs
  // nothing. Launches are the noisiest family, so they start off.
  kinds: ALERT_KINDS.filter((k) => k !== 'launch'),
  whaleMinUsd: 5000,
  priceMovePct: 25,
  rugDropPct: 40,
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    telegramToken: env.TELEGRAM_BOT_TOKEN?.trim() || null,
    telegramChannelId: env.TELEGRAM_CHANNEL_ID?.trim() || null,
    rpcUrl: env.RPC_URL?.trim() || undefined,
    dbPath: env.DB_PATH?.trim() || './data/volume-alerts.db',
    baselineMinutes: num(env.BASELINE_MINUTES, 60, 'BASELINE_MINUTES'),
    evalIntervalS: num(env.EVAL_INTERVAL_S, 15, 'EVAL_INTERVAL_S'),
    cooldownMinutes: num(env.COOLDOWN_MINUTES, 30, 'COOLDOWN_MINUTES'),
    backfillMinutes: num(env.BACKFILL_MINUTES, 70, 'BACKFILL_MINUTES'),
    logLevel: env.LOG_LEVEL?.trim() || 'info',
    defaults: SETTING_DEFAULTS,
  }
}
