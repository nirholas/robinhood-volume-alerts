/** Runtime configuration, resolved once at startup from the environment. */
export interface Defaults {
  /** Rolling-minute volume must be at least this many times the baseline. */
  spikeX: number
  /** Ignore spikes smaller than this many USD in the spiking minute. */
  minVolumeUsd: number
  /** Ignore spikes with fewer swaps than this in the spiking minute. */
  minSwaps: number
  /** Whether tokens younger than one baseline window alert at all. */
  newTokens: boolean
}

export interface Config {
  telegramToken: string | null
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

/** Sensitivity defaults for a chat that has never touched the keyboard. */
export const SETTING_DEFAULTS: Defaults = {
  spikeX: 4,
  minVolumeUsd: 3000,
  minSwaps: 10,
  newTokens: true,
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    telegramToken: env.TELEGRAM_BOT_TOKEN?.trim() || null,
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
