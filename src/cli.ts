#!/usr/bin/env node
/**
 * The robinhood-volume-alerts command line.
 *
 *   robinhood-volume-alerts start      run the bot (also the default command)
 *   robinhood-volume-alerts dry-run    live pipeline, console output, no Telegram needed
 *   robinhood-volume-alerts doctor     verify RPC, Telegram, channel rights, database
 *   robinhood-volume-alerts version    print the version
 *   robinhood-volume-alerts help       this text
 *
 * The CLI is a thin shell over the same startApp() the daemon uses; there is
 * no separate code path to drift out of date.
 */
import { createRequire } from 'node:module'
import { createHoodClient } from 'hoodchain'
import { loadConfig, SETTING_DEFAULTS } from './config.js'
import { loadDotEnv } from './env.js'
import { Store } from './db.js'
import { logger } from './logger.js'

const require = createRequire(import.meta.url)
// One level up when running from src/ under tsx, two when compiled to dist/src/.
const VERSION: string = (() => {
  for (const p of ['../package.json', '../../package.json']) {
    try {
      const manifest = require(p) as { name?: string; version?: string }
      if (manifest.name === 'robinhood-volume-alerts' && manifest.version) return manifest.version
    } catch {
      /* try the next depth */
    }
  }
  return '0.0.0'
})()

/** Robinhood Chain mainnet. Anything else means the RPC URL points elsewhere. */
const EXPECTED_CHAIN_ID = 4663

const HELP = `robinhood-volume-alerts ${VERSION}
Real-time trading alerts for Robinhood Chain (chain id 4663), delivered to Telegram.

Usage
  robinhood-volume-alerts <command> [options]

Commands
  start              Run the bot. Reads .env from the working directory.
  dry-run            Run the full live pipeline with console output only.
                     No Telegram token required; nothing is sent anywhere.
    --minutes <n>      How long to run (default 10)
    --spike <x>        Spike multiple gate (default ${SETTING_DEFAULTS.spikeX})
    --vol <usd>        Volume floor in USD (default ${SETTING_DEFAULTS.minVolumeUsd})
    --swaps <n>        Swap-count floor (default ${SETTING_DEFAULTS.minSwaps})
  doctor             Check every external dependency and report what is wrong:
                     RPC reachability and chain id, log-scan support, database
                     writability, Telegram token, channel post permission.
  version            Print the version and exit.
  help               Print this text and exit.

Configuration is environment based; see .env.example or
https://github.com/nirholas/robinhood-volume-alerts#configuration
`

function numFlag(argv: string[], name: string, fallback: number): number {
  const i = argv.indexOf(`--${name}`)
  if (i === -1 || i + 1 >= argv.length) return fallback
  const n = Number(argv[i + 1])
  return Number.isFinite(n) && n > 0 ? n : fallback
}

async function cmdStart(): Promise<void> {
  const { startApp } = await import('./index.js')
  const app = await startApp()
  const shutdown = (signal: string): void => {
    logger.info({ signal }, 'shutting down')
    void app.stop().then(() => process.exit(0))
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}

async function cmdDryRun(argv: string[]): Promise<void> {
  const minutes = numFlag(argv, 'minutes', 10)
  const spikeX = numFlag(argv, 'spike', SETTING_DEFAULTS.spikeX)
  const minVolumeUsd = numFlag(argv, 'vol', SETTING_DEFAULTS.minVolumeUsd)
  const minSwaps = numFlag(argv, 'swaps', SETTING_DEFAULTS.minSwaps)
  logger.info({ minutes, spikeX, minVolumeUsd, minSwaps }, 'dry run starting')

  const { startApp } = await import('./index.js')
  const app = await startApp({
    telegramToken: null,
    dbPath: process.env.DB_PATH?.trim() || './data/dry-run.db',
    defaults: { ...SETTING_DEFAULTS, spikeX, minVolumeUsd, minSwaps, newTokens: true },
  })
  setTimeout(
    () => {
      logger.info({ trades: app.ingest.tradesIngested, alerts: app.detector.alertsEmitted }, 'dry run complete')
      void app.stop().then(() => process.exit(0))
    },
    minutes * 60 * 1000,
  )
}

interface CheckResult {
  label: string
  level: 'ok' | 'warn' | 'fail'
  detail: string
}

/**
 * Every failure mode this bot has actually hit in production has a check
 * here, so "doctor" answers the question a broken deployment really asks:
 * which link in the chain is the one that is down.
 */
async function cmdDoctor(): Promise<void> {
  loadDotEnv()
  const cfg = loadConfig()
  const results: CheckResult[] = []
  const push = (label: string, level: CheckResult['level'], detail: string): void => {
    results.push({ label, level, detail })
    const tag = level === 'ok' ? ' ok ' : level === 'warn' ? 'warn' : 'FAIL'
    console.log(`[${tag}] ${label}: ${detail}`)
  }

  // 1. RPC reachability, identity, and latency.
  const client = createHoodClient(cfg.rpcUrl ? { rpcUrl: cfg.rpcUrl } : {})
  let head = 0n
  try {
    const t0 = Date.now()
    const [block, chainId] = await Promise.all([client.public.getBlockNumber(), client.public.getChainId()])
    head = block
    const ms = Date.now() - t0
    if (chainId !== EXPECTED_CHAIN_ID) {
      push('rpc', 'fail', `reachable but chain id is ${chainId}, expected ${EXPECTED_CHAIN_ID} (Robinhood Chain mainnet)`)
    } else {
      push('rpc', ms > 2000 ? 'warn' : 'ok', `head block ${block}, chain id ${chainId}, ${ms}ms`)
    }
  } catch (error) {
    push('rpc', 'fail', `unreachable: ${String(error).slice(0, 120)}`)
  }

  // 2. Topic-only log scans, the read pattern ingest depends on. Some RPCs
  //    reject getLogs without an address filter; this one must not.
  if (head > 0n) {
    try {
      const logs = await client.public.getLogs({ fromBlock: head - 200n, toBlock: head })
      push('log scan', 'ok', `address-less getLogs works (${logs.length} logs in the last 200 blocks)`)
    } catch (error) {
      push('log scan', 'fail', `getLogs without an address filter rejected: ${String(error).slice(0, 100)}`)
    }
  }

  // 3. Database: create, migrate, write, read back.
  try {
    const store = new Store(cfg.dbPath, cfg.defaults)
    store.setState('doctor_probe', String(Date.now()))
    const echo = store.getState('doctor_probe')
    store.close()
    push('database', echo ? 'ok' : 'fail', `${cfg.dbPath} (migrations applied, write verified)`)
  } catch (error) {
    push('database', 'fail', `${cfg.dbPath}: ${String(error).slice(0, 120)}`)
  }

  // 4. Telegram token.
  let botId: string | null = null
  if (!cfg.telegramToken) {
    push('telegram', 'warn', 'TELEGRAM_BOT_TOKEN not set; the bot would run in console-only mode')
  } else {
    try {
      const res = await fetch(`https://api.telegram.org/bot${cfg.telegramToken}/getMe`)
      const json = (await res.json()) as { ok: boolean; result?: { username?: string; id?: number } }
      if (json.ok && json.result) {
        botId = String(json.result.id ?? '')
        push('telegram', 'ok', `token valid, bot is @${json.result.username}`)
      } else {
        push('telegram', 'fail', 'token rejected by the Telegram API')
      }
    } catch (error) {
      push('telegram', 'fail', `api.telegram.org unreachable: ${String(error).slice(0, 100)}`)
    }
  }

  // 5. Channel feed permission, the single most common deployment gap: the
  //    bot is added as admin but "Post Messages" is left toggled off.
  if (cfg.telegramChannelId && cfg.telegramToken && botId) {
    try {
      const res = await fetch(
        `https://api.telegram.org/bot${cfg.telegramToken}/getChatMember?chat_id=${encodeURIComponent(cfg.telegramChannelId)}&user_id=${botId}`,
      )
      const json = (await res.json()) as {
        ok: boolean
        result?: { status?: string; can_post_messages?: boolean }
        description?: string
      }
      if (!json.ok) {
        push('channel', 'fail', `${cfg.telegramChannelId}: ${json.description ?? 'lookup failed'} (is the bot a member?)`)
      } else if (json.result?.status !== 'administrator') {
        push('channel', 'fail', `${cfg.telegramChannelId}: bot status is "${json.result?.status}", needs administrator`)
      } else if (json.result.can_post_messages !== true) {
        push('channel', 'fail', `${cfg.telegramChannelId}: bot is admin but "Post Messages" is toggled OFF in the channel's admin settings`)
      } else {
        push('channel', 'ok', `${cfg.telegramChannelId}: administrator with post permission`)
      }
    } catch (error) {
      push('channel', 'fail', `lookup failed: ${String(error).slice(0, 100)}`)
    }
  } else if (cfg.telegramChannelId) {
    push('channel', 'warn', 'TELEGRAM_CHANNEL_ID set but token check did not pass, skipping')
  }

  const fails = results.filter((r) => r.level === 'fail').length
  const warns = results.filter((r) => r.level === 'warn').length
  console.log(`\n${fails === 0 ? 'Ready.' : 'Not ready.'} ${results.length} checks, ${fails} failing, ${warns} warnings.`)
  process.exit(fails === 0 ? 0 : 1)
}

const [, , rawCommand, ...rest] = process.argv
const command = rawCommand ?? 'start'

switch (command) {
  case 'start':
    await cmdStart()
    break
  case 'dry-run':
    await cmdDryRun(rest)
    break
  case 'doctor':
    await cmdDoctor()
    break
  case 'version':
  case '--version':
  case '-v':
    console.log(VERSION)
    break
  case 'help':
  case '--help':
  case '-h':
    console.log(HELP)
    break
  default:
    console.error(`Unknown command "${command}".\n`)
    console.log(HELP)
    process.exit(2)
}
