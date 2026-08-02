import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import Database from 'better-sqlite3'
import type { Defaults } from './config.js'
import { ALERT_KINDS, isAlertKind, type AlertKind } from './engine/events.js'

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

/** A wallet or token a chat asked to follow. */
export interface WatchRow {
  chatId: string
  kind: 'wallet' | 'token'
  target: string
  label: string | null
  createdAt: number
}

/** An alert whose subsequent price action is being tracked. */
export interface TrackedAlert {
  id: number
  token: string
  sourceKind: AlertKind
  alertedAt: number
  entryPrice: number
  peakPrice: number
  peakAt: number
  lastMilestone: number
  closed: number
}

/** One row of the /top leaderboard. */
export interface MoverRow {
  token: string
  symbol: string | null
  volumeUsd: number
  swaps: number
  firstPrice: number
  lastPrice: number
  pct: number
}

/** Aggregate performance of tracked alerts, for /scorecard. */
export interface Scorecard {
  tracked: number
  settled: number
  hit2x: number
  hit5x: number
  hit10x: number
  medianPeak: number
  best: { token: string; symbol: string | null; multiple: number } | null
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
      CREATE TABLE IF NOT EXISTS app_state (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS alert_cooldowns (
        chat_id     TEXT NOT NULL,
        kind        TEXT NOT NULL,
        token       TEXT NOT NULL,
        last_sent_s INTEGER NOT NULL,
        PRIMARY KEY (chat_id, kind, token)
      );
      CREATE TABLE IF NOT EXISTS watches (
        chat_id    TEXT NOT NULL,
        kind       TEXT NOT NULL,
        target     TEXT NOT NULL,
        label      TEXT,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (chat_id, kind, target)
      );
      CREATE INDEX IF NOT EXISTS idx_watches_target ON watches (kind, target);
      CREATE TABLE IF NOT EXISTS tracked_alerts (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        token          TEXT NOT NULL,
        source_kind    TEXT NOT NULL,
        alerted_at     INTEGER NOT NULL,
        entry_price    REAL NOT NULL,
        peak_price     REAL NOT NULL,
        peak_at        INTEGER NOT NULL,
        last_milestone REAL NOT NULL DEFAULT 1,
        closed         INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_tracked_open ON tracked_alerts (closed);
      CREATE TABLE IF NOT EXISTS alert_recipients (
        tracked_id INTEGER NOT NULL,
        chat_id    TEXT NOT NULL,
        PRIMARY KEY (tracked_id, chat_id)
      );
    `)

    // Columns added after the first release: applied in place so an existing
    // database keeps its baselines and subscriber settings.
    this.addColumn('chats', 'kinds', `TEXT NOT NULL DEFAULT '${ALERT_KINDS.join(',')}'`)
    this.addColumn('chats', 'whale_min_usd', 'REAL NOT NULL DEFAULT 5000')
    this.addColumn('chats', 'price_move_pct', 'REAL NOT NULL DEFAULT 25')
    this.addColumn('chats', 'rug_drop_pct', 'REAL NOT NULL DEFAULT 40')

    // The pre-kind cooldown table carried spike cooldowns only.
    const legacy = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'cooldowns'")
      .get() as { name: string } | undefined
    if (legacy) {
      this.db.exec(`
        INSERT OR IGNORE INTO alert_cooldowns (chat_id, kind, token, last_sent_s)
          SELECT chat_id, 'spike', token, last_sent_s FROM cooldowns;
        DROP TABLE cooldowns;
      `)
    }
  }

  private addColumn(table: string, column: string, ddl: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
    if (!columns.some((c) => c.name === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`)
    }
  }

  // ---- chats ---------------------------------------------------------------

  getChat(chatId: string): ChatSettings {
    const row = this.db.prepare('SELECT * FROM chats WHERE chat_id = ?').get(chatId) as
      | {
          chat_id: string
          spike_x: number
          min_volume_usd: number
          min_swaps: number
          new_tokens: number
          paused: number
          kinds: string
          whale_min_usd: number
          price_move_pct: number
          rug_drop_pct: number
        }
      | undefined
    if (!row) return { chatId, ...this.defaults, paused: false }
    return {
      chatId: row.chat_id,
      spikeX: row.spike_x,
      minVolumeUsd: row.min_volume_usd,
      minSwaps: row.min_swaps,
      newTokens: row.new_tokens === 1,
      paused: row.paused === 1,
      kinds: parseKinds(row.kinds, this.defaults.kinds),
      whaleMinUsd: row.whale_min_usd,
      priceMovePct: row.price_move_pct,
      rugDropPct: row.rug_drop_pct,
    }
  }

  upsertChat(settings: ChatSettings): void {
    const now = Math.floor(Date.now() / 1000)
    this.db
      .prepare(
        `INSERT INTO chats (chat_id, spike_x, min_volume_usd, min_swaps, new_tokens, paused,
                            kinds, whale_min_usd, price_move_pct, rug_drop_pct, created_at, updated_at)
         VALUES (@chatId, @spikeX, @minVolumeUsd, @minSwaps, @newTokens, @paused,
                 @kinds, @whaleMinUsd, @priceMovePct, @rugDropPct, @now, @now)
         ON CONFLICT (chat_id) DO UPDATE SET
           spike_x = @spikeX, min_volume_usd = @minVolumeUsd, min_swaps = @minSwaps,
           new_tokens = @newTokens, paused = @paused, kinds = @kinds,
           whale_min_usd = @whaleMinUsd, price_move_pct = @priceMovePct,
           rug_drop_pct = @rugDropPct, updated_at = @now`,
      )
      .run({
        chatId: settings.chatId,
        spikeX: settings.spikeX,
        minVolumeUsd: settings.minVolumeUsd,
        minSwaps: settings.minSwaps,
        newTokens: settings.newTokens ? 1 : 0,
        paused: settings.paused ? 1 : 0,
        kinds: settings.kinds.join(','),
        whaleMinUsd: settings.whaleMinUsd,
        priceMovePct: settings.priceMovePct,
        rugDropPct: settings.rugDropPct,
        now,
      })
  }

  listActiveChats(): ChatSettings[] {
    const rows = this.db.prepare('SELECT chat_id FROM chats WHERE paused = 0').all() as { chat_id: string }[]
    return rows.map((r) => this.getChat(r.chat_id))
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

  // ---- watches -------------------------------------------------------------

  addWatch(chatId: string, kind: 'wallet' | 'token', target: string, label: string | null): void {
    this.db
      .prepare(
        `INSERT INTO watches (chat_id, kind, target, label, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (chat_id, kind, target) DO UPDATE SET label = COALESCE(excluded.label, label)`,
      )
      .run(chatId, kind, target.toLowerCase(), label, Math.floor(Date.now() / 1000))
  }

  removeWatch(chatId: string, kind: 'wallet' | 'token', target: string): boolean {
    const info = this.db
      .prepare('DELETE FROM watches WHERE chat_id = ? AND kind = ? AND target = ?')
      .run(chatId, kind, target.toLowerCase())
    return info.changes > 0
  }

  listWatches(chatId: string, kind?: 'wallet' | 'token'): WatchRow[] {
    const rows = (
      kind
        ? this.db.prepare('SELECT * FROM watches WHERE chat_id = ? AND kind = ? ORDER BY created_at DESC').all(chatId, kind)
        : this.db.prepare('SELECT * FROM watches WHERE chat_id = ? ORDER BY created_at DESC').all(chatId)
    ) as { chat_id: string; kind: string; target: string; label: string | null; created_at: number }[]
    return rows.map((r) => ({
      chatId: r.chat_id,
      kind: r.kind === 'wallet' ? 'wallet' : 'token',
      target: r.target,
      label: r.label,
      createdAt: r.created_at,
    }))
  }

  /** Every chat watching `target`, with the label each gave it. */
  watchersOf(kind: 'wallet' | 'token', target: string): { chatId: string; label: string | null }[] {
    const rows = this.db
      .prepare('SELECT chat_id, label FROM watches WHERE kind = ? AND target = ?')
      .all(kind, target.toLowerCase()) as { chat_id: string; label: string | null }[]
    return rows.map((r) => ({ chatId: r.chat_id, label: r.label }))
  }

  /** All distinct watched targets of a kind, for the in-memory hot set. */
  allWatchTargets(kind: 'wallet' | 'token'): string[] {
    const rows = this.db.prepare('SELECT DISTINCT target FROM watches WHERE kind = ?').all(kind) as {
      target: string
    }[]
    return rows.map((r) => r.target)
  }

  // ---- minute buckets ------------------------------------------------------

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

  getBuckets(token: string, fromMinute: number, toMinute: number): Map<number, MinuteBucket> {
    const rows = this.db
      .prepare(
        'SELECT minute, volume_usd, swaps, buys, sells, close_price FROM minute_buckets WHERE token = ? AND minute BETWEEN ? AND ?',
      )
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
      map.set(r.minute, {
        volumeUsd: r.volume_usd,
        swaps: r.swaps,
        buys: r.buys,
        sells: r.sells,
        closePrice: r.close_price,
      })
    }
    return map
  }

  closePriceAtOrBefore(token: string, minute: number, lookback: number): number | null {
    const row = this.db
      .prepare(
        'SELECT close_price FROM minute_buckets WHERE token = ? AND minute <= ? AND minute >= ? ORDER BY minute DESC LIMIT 1',
      )
      .get(token.toLowerCase(), minute, minute - lookback) as { close_price: number } | undefined
    return row ? row.close_price : null
  }

  /** Minute index of the most recent bucket at or after `sinceMinute`. */
  latestBucketMinute(token: string, sinceMinute: number): number | null {
    const row = this.db
      .prepare('SELECT minute FROM minute_buckets WHERE token = ? AND minute >= ? ORDER BY minute DESC LIMIT 1')
      .get(token.toLowerCase(), sinceMinute) as { minute: number } | undefined
    return row ? row.minute : null
  }

  /** Most recent close price for a token, at or after `sinceMinute`. */
  latestPrice(token: string, sinceMinute: number): number | null {
    const row = this.db
      .prepare('SELECT close_price FROM minute_buckets WHERE token = ? AND minute >= ? ORDER BY minute DESC LIMIT 1')
      .get(token.toLowerCase(), sinceMinute) as { close_price: number } | undefined
    return row ? row.close_price : null
  }

  /** Highest close price seen in a minute range, for peak tracking. */
  peakPrice(token: string, fromMinute: number, toMinute: number): { price: number; minute: number } | null {
    const row = this.db
      .prepare(
        'SELECT close_price, minute FROM minute_buckets WHERE token = ? AND minute BETWEEN ? AND ? ORDER BY close_price DESC LIMIT 1',
      )
      .get(token.toLowerCase(), fromMinute, toMinute) as { close_price: number; minute: number } | undefined
    return row ? { price: row.close_price, minute: row.minute } : null
  }

  earliestBucketMinute(token: string): number | null {
    const row = this.db.prepare('SELECT MIN(minute) AS m FROM minute_buckets WHERE token = ?').get(token.toLowerCase()) as {
      m: number | null
    }
    return row.m
  }

  pruneBuckets(beforeMinute: number): void {
    this.db.prepare('DELETE FROM minute_buckets WHERE minute < ?').run(beforeMinute)
  }

  /**
   * Tokens that traded in the window, heaviest first. Powers /top and the
   * liquidity monitor's candidate set.
   */
  topMovers(fromMinute: number, toMinute: number, limit: number): MoverRow[] {
    const rows = this.db
      .prepare(
        `SELECT b.token AS token,
                t.symbol AS symbol,
                SUM(b.volume_usd) AS volume_usd,
                SUM(b.swaps) AS swaps,
                (SELECT close_price FROM minute_buckets f WHERE f.token = b.token AND f.minute BETWEEN ? AND ? ORDER BY f.minute ASC LIMIT 1) AS first_price,
                (SELECT close_price FROM minute_buckets l WHERE l.token = b.token AND l.minute BETWEEN ? AND ? ORDER BY l.minute DESC LIMIT 1) AS last_price
         FROM minute_buckets b
         LEFT JOIN tokens t ON t.token = b.token
         WHERE b.minute BETWEEN ? AND ?
         GROUP BY b.token
         ORDER BY volume_usd DESC
         LIMIT ?`,
      )
      .all(fromMinute, toMinute, fromMinute, toMinute, fromMinute, toMinute, limit) as {
      token: string
      symbol: string | null
      volume_usd: number
      swaps: number
      first_price: number | null
      last_price: number | null
    }[]
    return rows.map((r) => {
      const first = r.first_price ?? 0
      const last = r.last_price ?? 0
      return {
        token: r.token,
        symbol: r.symbol,
        volumeUsd: r.volume_usd,
        swaps: r.swaps,
        firstPrice: first,
        lastPrice: last,
        pct: first > 0 && last > 0 ? ((last - first) / first) * 100 : 0,
      }
    })
  }

  // ---- pools ---------------------------------------------------------------

  getPool(pool: string): PoolRow | null {
    const row = this.db.prepare('SELECT * FROM pools WHERE pool = ?').get(pool.toLowerCase()) as
      | {
          pool: string
          token: string | null
          quote: string | null
          token_is0: number
          decimals_token: number
          decimals_quote: number
        }
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
      .run(
        row.pool.toLowerCase(),
        row.token?.toLowerCase() ?? null,
        row.quote,
        row.tokenIs0,
        row.decimalsToken,
        row.decimalsQuote,
      )
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

  /** Pools for many tokens at once, for the batched liquidity poll. */
  poolsForTokens(tokens: string[]): PoolRow[] {
    if (tokens.length === 0) return []
    const placeholders = tokens.map(() => '?').join(',')
    const rows = this.db
      .prepare(`SELECT * FROM pools WHERE token IN (${placeholders}) AND quote IS NOT NULL`)
      .all(...tokens.map((t) => t.toLowerCase())) as {
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
      | {
          token: string
          symbol: string | null
          name: string | null
          decimals: number | null
          total_supply: string | null
          creator: string | null
          launchpad: string | null
          first_seen_s: number | null
        }
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

  // ---- cooldowns -----------------------------------------------------------

  lastAlertS(chatId: string, kind: AlertKind, token: string): number | null {
    const row = this.db
      .prepare('SELECT last_sent_s FROM alert_cooldowns WHERE chat_id = ? AND kind = ? AND token = ?')
      .get(chatId, kind, token.toLowerCase()) as { last_sent_s: number } | undefined
    return row ? row.last_sent_s : null
  }

  setLastAlert(chatId: string, kind: AlertKind, token: string, atS: number): void {
    this.db
      .prepare(
        `INSERT INTO alert_cooldowns (chat_id, kind, token, last_sent_s) VALUES (?, ?, ?, ?)
         ON CONFLICT (chat_id, kind, token) DO UPDATE SET last_sent_s = excluded.last_sent_s`,
      )
      .run(chatId, kind, token.toLowerCase(), atS)
  }

  // ---- tracked alerts (performance) ----------------------------------------

  /** Start tracking an alert's subsequent price action. Returns its id. */
  trackAlert(token: string, sourceKind: AlertKind, atS: number, entryPrice: number): number {
    const info = this.db
      .prepare(
        `INSERT INTO tracked_alerts (token, source_kind, alerted_at, entry_price, peak_price, peak_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(token.toLowerCase(), sourceKind, atS, entryPrice, entryPrice, atS)
    return Number(info.lastInsertRowid)
  }

  addAlertRecipient(trackedId: number, chatId: string): void {
    this.db
      .prepare('INSERT OR IGNORE INTO alert_recipients (tracked_id, chat_id) VALUES (?, ?)')
      .run(trackedId, chatId)
  }

  recipientsOf(trackedId: number): string[] {
    const rows = this.db.prepare('SELECT chat_id FROM alert_recipients WHERE tracked_id = ?').all(trackedId) as {
      chat_id: string
    }[]
    return rows.map((r) => r.chat_id)
  }

  openTrackedAlerts(): TrackedAlert[] {
    const rows = this.db.prepare('SELECT * FROM tracked_alerts WHERE closed = 0').all() as {
      id: number
      token: string
      source_kind: string
      alerted_at: number
      entry_price: number
      peak_price: number
      peak_at: number
      last_milestone: number
      closed: number
    }[]
    return rows.map((r) => ({
      id: r.id,
      token: r.token,
      sourceKind: isAlertKind(r.source_kind) ? r.source_kind : 'spike',
      alertedAt: r.alerted_at,
      entryPrice: r.entry_price,
      peakPrice: r.peak_price,
      peakAt: r.peak_at,
      lastMilestone: r.last_milestone,
      closed: r.closed,
    }))
  }

  updateTracked(id: number, peakPrice: number, peakAt: number, lastMilestone: number): void {
    this.db
      .prepare('UPDATE tracked_alerts SET peak_price = ?, peak_at = ?, last_milestone = ? WHERE id = ?')
      .run(peakPrice, peakAt, lastMilestone, id)
  }

  closeTracked(id: number): void {
    this.db.prepare('UPDATE tracked_alerts SET closed = 1 WHERE id = ?').run(id)
  }

  /** Whether this token already has an open tracker, to avoid duplicates. */
  hasOpenTracker(token: string): boolean {
    return (
      this.db.prepare('SELECT 1 FROM tracked_alerts WHERE token = ? AND closed = 0').get(token.toLowerCase()) !==
      undefined
    )
  }

  /**
   * How the bot's own alerts have performed. Only settled (closed) trackers
   * count toward the hit rates, so an in-flight call cannot flatter the
   * numbers.
   */
  scorecard(sinceS: number): Scorecard {
    const rows = this.db
      .prepare(
        `SELECT a.token AS token, t.symbol AS symbol, a.entry_price AS entry, a.peak_price AS peak, a.closed AS closed
         FROM tracked_alerts a LEFT JOIN tokens t ON t.token = a.token
         WHERE a.alerted_at >= ?`,
      )
      .all(sinceS) as { token: string; symbol: string | null; entry: number; peak: number; closed: number }[]

    const multiples: number[] = []
    let settled = 0
    let best: Scorecard['best'] = null
    for (const r of rows) {
      if (r.entry <= 0) continue
      const multiple = r.peak / r.entry
      if (r.closed === 1) {
        settled++
        multiples.push(multiple)
      }
      if (!best || multiple > best.multiple) best = { token: r.token, symbol: r.symbol, multiple }
    }
    const sorted = [...multiples].sort((a, b) => a - b)
    const median = sorted.length === 0 ? 0 : (sorted[Math.floor((sorted.length - 1) / 2)] ?? 0)
    return {
      tracked: rows.length,
      settled,
      hit2x: multiples.filter((m) => m >= 2).length,
      hit5x: multiples.filter((m) => m >= 5).length,
      hit10x: multiples.filter((m) => m >= 10).length,
      medianPeak: median,
      best,
    }
  }

  // ---- app state -----------------------------------------------------------

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

function parseKinds(csv: string, fallback: AlertKind[]): AlertKind[] {
  const parsed = csv
    .split(',')
    .map((s) => s.trim())
    .filter(isAlertKind)
  return parsed.length > 0 ? parsed : fallback
}
