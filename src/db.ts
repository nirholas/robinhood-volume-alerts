import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import Database from 'better-sqlite3'
import type { Defaults } from './config.js'

/** Per-chat sensitivity settings, as stored. */
export interface ChatSettings extends Defaults {
  chatId: string
  paused: boolean
}

/** One closed one-minute volume bucket for a token. */
export interface MinuteBucket {
  volumeUsd: number
  swaps: number
  buys: number
  sells: number
  closePrice: number
}

/** Cached classification of a v3-style pool. */
export interface PoolRow {
  pool: string
  /** The non-quote side of the pool, lowercase. Null when the pool is skipped. */
  token: string | null
  /** 'USDG' | 'WETH', or null when the pool has no dollar-priceable quote side. */
  quote: string | null
  tokenIs0: number
  decimalsToken: number
  decimalsQuote: number
}

/** Everything we know about a token. All fields except the address are lazy. */
export interface TokenRow {
  token: string
  symbol: string | null
  name: string | null
  decimals: number | null
  totalSupply: string | null
  creator: string | null
  launchpad: string | null
  firstSeenS: number | null
}

export class Store {
  readonly db: Database.Database

  constructor(path: string, private readonly defaults: Defaults) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.db = new Database(path)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('synchronous = NORMAL')
    this.migrate()
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chats (
        chat_id        TEXT PRIMARY KEY,
        spike_x        REAL NOT NULL,
        min_volume_usd REAL NOT NULL,
        min_swaps      INTEGER NOT NULL,
        new_tokens     INTEGER NOT NULL,
        paused         INTEGER NOT NULL DEFAULT 0,
        created_at     INTEGER NOT NULL,
        updated_at     INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS mutes (
        chat_id    TEXT NOT NULL,
        token      TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (chat_id, token)
      );
      CREATE TABLE IF NOT EXISTS minute_buckets (
        token       TEXT NOT NULL,
        minute      INTEGER NOT NULL,
        volume_usd  REAL NOT NULL,
        swaps       INTEGER NOT NULL,
        buys        INTEGER NOT NULL,
        sells       INTEGER NOT NULL,
        close_price REAL NOT NULL,
        PRIMARY KEY (token, minute)
      );
      CREATE INDEX IF NOT EXISTS idx_buckets_minute ON minute_buckets (minute);
      CREATE TABLE IF NOT EXISTS pools (
        pool           TEXT PRIMARY KEY,
        token          TEXT,
        quote          TEXT,
        token_is0      INTEGER NOT NULL DEFAULT 0,
        decimals_token INTEGER NOT NULL DEFAULT 18,
        decimals_quote INTEGER NOT NULL DEFAULT 18
      );
      CREATE INDEX IF NOT EXISTS idx_pools_token ON pools (token);
      CREATE TABLE IF NOT EXISTS tokens (
        token        TEXT PRIMARY KEY,
        symbol       TEXT,
        name         TEXT,
        decimals     INTEGER,
        total_supply TEXT,
        creator      TEXT,
        launchpad    TEXT,
        first_seen_s INTEGER
      );
      CREATE TABLE IF NOT EXISTS cooldowns (
        chat_id     TEXT NOT NULL,
        token       TEXT NOT NULL,
        last_sent_s INTEGER NOT NULL,
        PRIMARY KEY (chat_id, token)
      );
      CREATE TABLE IF NOT EXISTS app_state (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `)
  }

  // ---- chats ---------------------------------------------------------------

  getChat(chatId: string): ChatSettings {
    const row = this.db
      .prepare('SELECT * FROM chats WHERE chat_id = ?')
      .get(chatId) as
      | { chat_id: string; spike_x: number; min_volume_usd: number; min_swaps: number; new_tokens: number; paused: number }
      | undefined
    if (!row) return { chatId, ...this.defaults, paused: false }
    return {
      chatId: row.chat_id,
      spikeX: row.spike_x,
      minVolumeUsd: row.min_volume_usd,
      minSwaps: row.min_swaps,
      newTokens: row.new_tokens === 1,
      paused: row.paused === 1,
    }
  }

  upsertChat(settings: ChatSettings): void {
    const now = Math.floor(Date.now() / 1000)
    this.db
      .prepare(
        `INSERT INTO chats (chat_id, spike_x, min_volume_usd, min_swaps, new_tokens, paused, created_at, updated_at)
         VALUES (@chatId, @spikeX, @minVolumeUsd, @minSwaps, @newTokens, @paused, @now, @now)
         ON CONFLICT (chat_id) DO UPDATE SET
           spike_x = @spikeX, min_volume_usd = @minVolumeUsd, min_swaps = @minSwaps,
           new_tokens = @newTokens, paused = @paused, updated_at = @now`,
      )
      .run({
        chatId: settings.chatId,
        spikeX: settings.spikeX,
        minVolumeUsd: settings.minVolumeUsd,
        minSwaps: settings.minSwaps,
        newTokens: settings.newTokens ? 1 : 0,
        paused: settings.paused ? 1 : 0,
        now,
      })
  }

  listActiveChats(): ChatSettings[] {
    const rows = this.db.prepare('SELECT chat_id FROM chats WHERE paused = 0').all() as { chat_id: string }[]
    return rows.map((r) => this.getChat(r.chat_id))
  }

  deleteChat(chatId: string): void {
    this.db.prepare('DELETE FROM chats WHERE chat_id = ?').run(chatId)
    this.db.prepare('DELETE FROM mutes WHERE chat_id = ?').run(chatId)
    this.db.prepare('DELETE FROM cooldowns WHERE chat_id = ?').run(chatId)
  }

  // ---- mutes ---------------------------------------------------------------

  mute(chatId: string, token: string): void {
    this.db
      .prepare('INSERT OR IGNORE INTO mutes (chat_id, token, created_at) VALUES (?, ?, ?)')
      .run(chatId, token.toLowerCase(), Math.floor(Date.now() / 1000))
  }

  unmute(chatId: string, token: string): void {
    this.db.prepare('DELETE FROM mutes WHERE chat_id = ? AND token = ?').run(chatId, token.toLowerCase())
  }

  isMuted(chatId: string, token: string): boolean {
    return (
      this.db.prepare('SELECT 1 FROM mutes WHERE chat_id = ? AND token = ?').get(chatId, token.toLowerCase()) !==
      undefined
    )
  }

  listMutes(chatId: string): string[] {
    const rows = this.db
      .prepare('SELECT token FROM mutes WHERE chat_id = ? ORDER BY created_at DESC')
      .all(chatId) as { token: string }[]
    return rows.map((r) => r.token)
  }

  // ---- minute buckets ------------------------------------------------------

  /** Accumulate a closed minute bucket (idempotent re-adds merge). */
  addBucket(token: string, minute: number, b: MinuteBucket): void {
    this.db
      .prepare(
        `INSERT INTO minute_buckets (token, minute, volume_usd, swaps, buys, sells, close_price)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (token, minute) DO UPDATE SET
           volume_usd = volume_usd + excluded.volume_usd,
           swaps = swaps + excluded.swaps,
           buys = buys + excluded.buys,
           sells = sells + excluded.sells,
           close_price = excluded.close_price`,
      )
      .run(token.toLowerCase(), minute, b.volumeUsd, b.swaps, b.buys, b.sells, b.closePrice)
  }

  /** Buckets in [fromMinute, toMinute], keyed by minute. Missing minutes are absent. */
  getBuckets(token: string, fromMinute: number, toMinute: number): Map<number, MinuteBucket> {
    const rows = this.db
      .prepare('SELECT minute, volume_usd, swaps, buys, sells, close_price FROM minute_buckets WHERE token = ? AND minute BETWEEN ? AND ?')
      .all(token.toLowerCase(), fromMinute, toMinute) as {
      minute: number
      volume_usd: number
      swaps: number
      buys: number
      sells: number
      close_price: number
    }[]
    const map = new Map<number, MinuteBucket>()
    for (const r of rows) {
      map.set(r.minute, { volumeUsd: r.volume_usd, swaps: r.swaps, buys: r.buys, sells: r.sells, closePrice: r.close_price })
    }
    return map
  }

  /** Latest close price at or before `minute`, looking back up to `lookback` minutes. */
  closePriceAtOrBefore(token: string, minute: number, lookback: number): number | null {
    const row = this.db
      .prepare('SELECT close_price FROM minute_buckets WHERE token = ? AND minute <= ? AND minute >= ? ORDER BY minute DESC LIMIT 1')
      .get(token.toLowerCase(), minute, minute - lookback) as { close_price: number } | undefined
    return row ? row.close_price : null
  }

  /** Earliest minute we have ever seen a bucket for this token, or null. */
  earliestBucketMinute(token: string): number | null {
    const row = this.db
      .prepare('SELECT MIN(minute) AS m FROM minute_buckets WHERE token = ?')
      .get(token.toLowerCase()) as { m: number | null }
    return row.m
  }

  pruneBuckets(beforeMinute: number): void {
    this.db.prepare('DELETE FROM minute_buckets WHERE minute < ?').run(beforeMinute)
  }

  // ---- pools ---------------------------------------------------------------

  getPool(pool: string): PoolRow | null {
    const row = this.db.prepare('SELECT * FROM pools WHERE pool = ?').get(pool.toLowerCase()) as
      | { pool: string; token: string | null; quote: string | null; token_is0: number; decimals_token: number; decimals_quote: number }
      | undefined
    if (!row) return null
    return {
      pool: row.pool,
      token: row.token,
      quote: row.quote,
      tokenIs0: row.token_is0,
      decimalsToken: row.decimals_token,
      decimalsQuote: row.decimals_quote,
    }
  }

  savePool(row: PoolRow): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO pools (pool, token, quote, token_is0, decimals_token, decimals_quote)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(row.pool.toLowerCase(), row.token?.toLowerCase() ?? null, row.quote, row.tokenIs0, row.decimalsToken, row.decimalsQuote)
  }

  poolsForToken(token: string): PoolRow[] {
    const rows = this.db.prepare('SELECT * FROM pools WHERE token = ?').all(token.toLowerCase()) as {
      pool: string
      token: string | null
      quote: string | null
      token_is0: number
      decimals_token: number
      decimals_quote: number
    }[]
    return rows.map((row) => ({
      pool: row.pool,
      token: row.token,
      quote: row.quote,
      tokenIs0: row.token_is0,
      decimalsToken: row.decimals_token,
      decimalsQuote: row.decimals_quote,
    }))
  }

  // ---- tokens --------------------------------------------------------------

  getToken(token: string): TokenRow | null {
    const row = this.db.prepare('SELECT * FROM tokens WHERE token = ?').get(token.toLowerCase()) as
      | { token: string; symbol: string | null; name: string | null; decimals: number | null; total_supply: string | null; creator: string | null; launchpad: string | null; first_seen_s: number | null }
      | undefined
    if (!row) return null
    return {
      token: row.token,
      symbol: row.symbol,
      name: row.name,
      decimals: row.decimals,
      totalSupply: row.total_supply,
      creator: row.creator,
      launchpad: row.launchpad,
      firstSeenS: row.first_seen_s,
    }
  }

  /** Merge non-null fields into the token row; first_seen_s keeps the minimum. */
  upsertToken(partial: Partial<TokenRow> & { token: string }): void {
    this.db
      .prepare(
        `INSERT INTO tokens (token, symbol, name, decimals, total_supply, creator, launchpad, first_seen_s)
         VALUES (@token, @symbol, @name, @decimals, @totalSupply, @creator, @launchpad, @firstSeenS)
         ON CONFLICT (token) DO UPDATE SET
           symbol       = COALESCE(excluded.symbol, symbol),
           name         = COALESCE(excluded.name, name),
           decimals     = COALESCE(excluded.decimals, decimals),
           total_supply = COALESCE(excluded.total_supply, total_supply),
           creator      = COALESCE(excluded.creator, creator),
           launchpad    = COALESCE(excluded.launchpad, launchpad),
           first_seen_s = CASE
             WHEN excluded.first_seen_s IS NULL THEN first_seen_s
             WHEN first_seen_s IS NULL THEN excluded.first_seen_s
             ELSE MIN(first_seen_s, excluded.first_seen_s)
           END`,
      )
      .run({
        token: partial.token.toLowerCase(),
        symbol: partial.symbol ?? null,
        name: partial.name ?? null,
        decimals: partial.decimals ?? null,
        totalSupply: partial.totalSupply ?? null,
        creator: partial.creator?.toLowerCase() ?? null,
        launchpad: partial.launchpad ?? null,
        firstSeenS: partial.firstSeenS ?? null,
      })
  }

  // ---- cooldowns -------------------------------------------------------------

  lastAlertS(chatId: string, token: string): number | null {
    const row = this.db
      .prepare('SELECT last_sent_s FROM cooldowns WHERE chat_id = ? AND token = ?')
      .get(chatId, token.toLowerCase()) as { last_sent_s: number } | undefined
    return row ? row.last_sent_s : null
  }

  setLastAlert(chatId: string, token: string, atS: number): void {
    this.db
      .prepare(
        `INSERT INTO cooldowns (chat_id, token, last_sent_s) VALUES (?, ?, ?)
         ON CONFLICT (chat_id, token) DO UPDATE SET last_sent_s = excluded.last_sent_s`,
      )
      .run(chatId, token.toLowerCase(), atS)
  }

  // ---- app state -------------------------------------------------------------

  getState(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM app_state WHERE key = ?').get(key) as { value: string } | undefined
    return row ? row.value : null
  }

  setState(key: string, value: string): void {
    this.db
      .prepare('INSERT INTO app_state (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value')
      .run(key, value)
  }

  close(): void {
    this.db.close()
  }
}
