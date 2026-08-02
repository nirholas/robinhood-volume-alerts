import { erc20Abi, MAINNET_ADDRESSES, watchGraduations, watchLaunches, type HoodClient } from 'hoodchain'
import type { Address } from 'viem'
import type { Enricher } from '../chain/enrich.js'
import type { EthPrice } from '../chain/eth-price.js'
import type { Trade } from '../chain/ingest.js'
import type { TokenMetaCache } from '../chain/token-meta.js'
import type { Store } from '../db.js'
import { logger } from '../logger.js'
import { pctChange } from './baseline.js'
import { buildSnapshot } from './context.js'
import type { EmitAlert } from './detector.js'
import { EMPTY_CONTEXT } from './events.js'

const LAUNCHPAD_LABELS: Record<string, string> = { noxa: 'NOXA', odyssey: 'The Odyssey' }

/**
 * Trade-level detectors: single large trades, and trades by wallets someone
 * put on a watchlist. Both run on the raw ingest stream, so they see every
 * swap on the chain, and both are bounded by cooldowns to keep one busy
 * token from flooding a chat.
 */
export class TradeDetectors {
  /** Absolute floor so an empty subscriber list cannot enrich every trade. */
  private static readonly ABSOLUTE_WHALE_FLOOR = 1000
  private readonly lastWhale = new Map<string, { at: number; usd: number }>()
  /** Lowercase wallets currently watched by at least one chat. */
  private watchedWallets = new Set<string>()
  private refreshedAt = 0
  whaleAlerts = 0
  walletAlerts = 0

  constructor(
    private readonly store: Store,
    private readonly meta: TokenMetaCache,
    private readonly enricher: Enricher,
    /**
     * Floor used when no chat has registered yet. The channel feed and dry
     * runs both deliver at the default sensitivity without appearing in the
     * chats table, so falling back to Infinity here would silence whale
     * alerts on exactly those deployments.
     */
    private readonly fallbackWhaleUsd: number,
    private readonly emit: EmitAlert,
  ) {}

  /** Cheapest possible whale gate across active subscribers. */
  private whaleFloor(): number {
    const chats = this.store.listActiveChats().filter((c) => c.kinds.includes('whale'))
    const floor = chats.length === 0 ? this.fallbackWhaleUsd : Math.min(...chats.map((c) => c.whaleMinUsd))
    return Math.max(TradeDetectors.ABSOLUTE_WHALE_FLOOR, floor)
  }

  /** Reload the watched-wallet hot set from SQLite at most once a minute. */
  private refreshWatches(nowS: number): void {
    if (nowS - this.refreshedAt < 60) return
    this.refreshedAt = nowS
    this.watchedWallets = new Set(this.store.allWatchTargets('wallet'))
  }

  /**
   * Called for every ingested trade. Returns immediately for the common case
   * (small trade, unwatched wallet); the async work only starts once a trade
   * actually qualifies.
   */
  onTrade(trade: Trade, nowS = Math.floor(Date.now() / 1000)): void {
    this.refreshWatches(nowS)

    for (const party of trade.parties) {
      if (!this.watchedWallets.has(party)) continue
      const watchers = this.store.watchersOf('wallet', party)
      if (watchers.length === 0) continue
      void this.emitWalletTrade(trade, party, watchers).catch((error) =>
        logger.warn({ err: String(error) }, 'wallet trade alert failed'),
      )
      break
    }

    const floor = this.whaleFloor()
    if (!Number.isFinite(floor) || trade.volumeUsd < floor) return
    const recent = this.lastWhale.get(trade.token)
    // One whale per token per 5 minutes, unless this print doubles the last.
    if (recent && nowS - recent.at < 300 && trade.volumeUsd < recent.usd * 2) return
    this.lastWhale.set(trade.token, { at: nowS, usd: trade.volumeUsd })
    void this.emitWhale(trade).catch((error) => logger.warn({ err: String(error) }, 'whale alert failed'))
  }

  private async emitWhale(trade: Trade): Promise<void> {
    const snapshot = await buildSnapshot(
      this.store,
      this.meta,
      this.enricher,
      trade.token,
      trade.priceUsd,
      Math.floor(trade.ts / 60),
    )
    this.whaleAlerts++
    await this.emit({
      kind: 'whale',
      token: trade.token,
      symbol: snapshot.symbol,
      name: snapshot.name,
      at: trade.ts,
      context: snapshot.context,
      usd: trade.volumeUsd,
      side: trade.isBuy ? 'buy' : 'sell',
      trader: trade.parties[trade.parties.length - 1] ?? trade.parties[0] ?? '',
      txHash: trade.txHash,
      venue: trade.venue,
    })
  }

  private async emitWalletTrade(
    trade: Trade,
    wallet: string,
    watchers: { chatId: string; label: string | null }[],
  ): Promise<void> {
    const snapshot = await buildSnapshot(
      this.store,
      this.meta,
      this.enricher,
      trade.token,
      trade.priceUsd,
      Math.floor(trade.ts / 60),
    )
    this.walletAlerts++
    await this.emit({
      kind: 'wallet_trade',
      token: trade.token,
      symbol: snapshot.symbol,
      name: snapshot.name,
      at: trade.ts,
      context: snapshot.context,
      wallet,
      walletLabel: watchers.find((w) => w.label)?.label ?? null,
      side: trade.isBuy ? 'buy' : 'sell',
      usd: trade.volumeUsd,
      txHash: trade.txHash,
      audience: watchers.map((w) => w.chatId),
    })
  }
}

/**
 * Price-move detector. Runs on the same tick as the spike detector and
 * compares each active token's latest price against its close five minutes
 * ago, both read from the stored minute buckets. One alert per token per
 * direction per half hour, so a token grinding upward does not repeat.
 */
export class PriceMoveDetector {
  private static readonly WINDOW_MINUTES = 5
  private readonly lastAlert = new Map<string, { at: number; pct: number }>()
  alerts = 0

  constructor(
    private readonly store: Store,
    private readonly meta: TokenMetaCache,
    private readonly enricher: Enricher,
    private readonly fallbackPct: number,
    private readonly emit: EmitAlert,
  ) {}

  private threshold(): number {
    const chats = this.store.listActiveChats().filter((c) => c.kinds.includes('price_move'))
    return chats.length === 0 ? this.fallbackPct : Math.min(...chats.map((c) => c.priceMovePct))
  }

  async evaluate(tokens: string[], nowS: number): Promise<void> {
    const threshold = this.threshold()
    const nowMinute = Math.floor(nowS / 60)
    for (const token of tokens) {
      try {
        await this.evaluateToken(token, nowS, nowMinute, threshold)
      } catch (error) {
        logger.warn({ token, err: String(error) }, 'price move evaluation failed')
      }
    }
    for (const [token, mark] of this.lastAlert) {
      if (nowS - mark.at > 2 * 3600) this.lastAlert.delete(token)
    }
  }

  private async evaluateToken(token: string, nowS: number, nowMinute: number, threshold: number): Promise<void> {
    const now = this.store.latestPrice(token, nowMinute - 2)
    const before = this.store.closePriceAtOrBefore(token, nowMinute - PriceMoveDetector.WINDOW_MINUTES, 5)
    const pct = pctChange(before, now ?? 0)
    if (pct === null || Math.abs(pct) < threshold || now === null) return

    const direction = pct >= 0 ? 'up' : 'down'
    const recent = this.lastAlert.get(`${token}:${direction}`)
    if (recent && nowS - recent.at < 1800 && Math.abs(pct) < Math.abs(recent.pct) * 2) return
    this.lastAlert.set(`${token}:${direction}`, { at: nowS, pct })

    const snapshot = await buildSnapshot(this.store, this.meta, this.enricher, token, now, nowMinute)
    this.alerts++
    await this.emit({
      kind: 'price_move',
      token,
      symbol: snapshot.symbol,
      name: snapshot.name,
      at: nowS,
      context: snapshot.context,
      pct,
      windowMinutes: PriceMoveDetector.WINDOW_MINUTES,
      fromUsd: before ?? 0,
      toUsd: now,
    })
  }
}

/**
 * Liquidity monitor: the rug early warning.
 *
 * Every poll it reads the quote-side balance of every pool belonging to a
 * recently active token in ONE multicall, converts to USD, and compares
 * against the previous sample. A drop past the threshold means liquidity
 * left the pool, which is what a pull looks like before the price collapses.
 *
 * The candidate set is capped; the cap is logged rather than silently
 * applied, because a silently truncated sweep reads as full coverage.
 */
export class LiquidityMonitor {
  private static readonly MAX_TOKENS = 400
  private readonly lastLiquidity = new Map<string, number>()
  private readonly lastAlert = new Map<string, number>()
  alerts = 0

  constructor(
    private readonly client: HoodClient,
    private readonly store: Store,
    private readonly ethPrice: EthPrice,
    private readonly meta: TokenMetaCache,
    private readonly enricher: Enricher,
    private readonly fallbackDropPct: number,
    private readonly emit: EmitAlert,
  ) {}

  private threshold(): number {
    const chats = this.store.listActiveChats().filter((c) => c.kinds.includes('liquidity_pull'))
    return chats.length === 0 ? this.fallbackDropPct : Math.min(...chats.map((c) => c.rugDropPct))
  }

  async poll(nowS = Math.floor(Date.now() / 1000)): Promise<void> {
    const nowMinute = Math.floor(nowS / 60)
    const movers = this.store.topMovers(nowMinute - 30, nowMinute, LiquidityMonitor.MAX_TOKENS)
    if (movers.length === LiquidityMonitor.MAX_TOKENS) {
      logger.info({ cap: LiquidityMonitor.MAX_TOKENS }, 'liquidity sweep hit its token cap, quieter tokens skipped')
    }
    const pools = this.store.poolsForTokens(movers.map((m) => m.token))
    if (pools.length === 0) return

    const eth = (await this.ethPrice.get()) ?? this.ethPrice.lastKnown
    const balances = await this.client.public.multicall({
      contracts: pools.map((p) => ({
        address: p.quote === 'USDG' ? MAINNET_ADDRESSES.usdg : MAINNET_ADDRESSES.weth,
        abi: erc20Abi,
        functionName: 'balanceOf' as const,
        args: [p.pool as Address] as const,
      })),
      allowFailure: true,
    })

    const totals = new Map<string, number>()
    balances.forEach((res, i) => {
      const pool = pools[i]
      if (!pool || pool.token === null || res.status !== 'success') return
      const human = Number(res.result as bigint) / 10 ** pool.decimalsQuote
      const usd = pool.quote === 'USDG' ? human : eth !== null ? human * eth : 0
      totals.set(pool.token, (totals.get(pool.token) ?? 0) + usd * 2)
    })

    const threshold = this.threshold()
    for (const [token, current] of totals) {
      const previous = this.lastLiquidity.get(token)
      this.lastLiquidity.set(token, current)
      // Only meaningful pools qualify: a $200 pool losing half is noise.
      if (previous === undefined || previous < 2000) continue
      const droppedPct = ((previous - current) / previous) * 100
      if (droppedPct < threshold) continue
      const alertedAt = this.lastAlert.get(token)
      if (alertedAt !== undefined && nowS - alertedAt < 3600) continue
      this.lastAlert.set(token, nowS)

      try {
        const price = this.store.latestPrice(token, nowMinute - 30) ?? 0
        const snapshot = await buildSnapshot(this.store, this.meta, this.enricher, token, price, nowMinute)
        this.alerts++
        await this.emit({
          kind: 'liquidity_pull',
          token,
          symbol: snapshot.symbol,
          name: snapshot.name,
          at: nowS,
          context: { ...snapshot.context, liquidityUsd: current },
          droppedPct,
          beforeUsd: previous,
          afterUsd: current,
        })
      } catch (error) {
        logger.warn({ token, err: String(error) }, 'liquidity pull alert failed')
      }
    }
  }
}

/**
 * Launchpad detector: new tokens on NOXA and The Odyssey, and Odyssey curves
 * that fill and migrate to a locked Uniswap v3 pool. Both also write the
 * creator / launchpad / first-seen facts that every other card's "Age",
 * "Platform", and "dev sold" lines read.
 */
export class LaunchpadDetectors {
  private stops: Array<() => void> = []
  launches = 0
  graduations = 0

  constructor(
    private readonly client: HoodClient,
    private readonly store: Store,
    private readonly meta: TokenMetaCache,
    private readonly emit: EmitAlert,
  ) {}

  start(): void {
    this.stops.push(
      watchLaunches(
        this.client,
        (launch) => {
          const at = Math.floor(Date.now() / 1000)
          this.store.upsertToken({
            token: launch.token.toLowerCase(),
            creator: launch.creator.toLowerCase(),
            launchpad: launch.launchpad,
            firstSeenS: at,
          })
          void this.emitLaunch(launch.token.toLowerCase(), launch.creator.toLowerCase(), launch.pool, launch.launchpad, at).catch(
            (error) => logger.warn({ err: String(error) }, 'launch alert failed'),
          )
        },
        { onError: (err) => logger.warn({ err: String(err) }, 'launch watcher error') },
      ),
    )
    this.stops.push(
      watchGraduations(
        this.client,
        (graduation) => {
          void this.emitGraduation(graduation.token.toLowerCase(), graduation.pool.toLowerCase()).catch((error) =>
            logger.warn({ err: String(error) }, 'graduation alert failed'),
          )
        },
        { onError: (err) => logger.warn({ err: String(err) }, 'graduation watcher error') },
      ),
    )
  }

  stop(): void {
    for (const stop of this.stops) stop()
    this.stops = []
  }

  private async emitLaunch(
    token: string,
    creator: string,
    pool: string | null,
    launchpad: string,
    at: number,
  ): Promise<void> {
    const identity = await this.meta.get(token as Address)
    this.launches++
    await this.emit({
      kind: 'launch',
      token,
      symbol: identity.symbol,
      name: identity.name,
      at,
      context: { ...EMPTY_CONTEXT, ageS: 0, launchpad },
      creator,
      pool,
      launchpadName: LAUNCHPAD_LABELS[launchpad] ?? launchpad,
    })
  }

  private async emitGraduation(token: string, pool: string): Promise<void> {
    const at = Math.floor(Date.now() / 1000)
    const identity = await this.meta.get(token as Address)
    const row = this.store.getToken(token)
    this.graduations++
    await this.emit({
      kind: 'graduation',
      token,
      symbol: identity.symbol,
      name: identity.name,
      at,
      context: {
        ...EMPTY_CONTEXT,
        launchpad: row?.launchpad ?? 'odyssey',
        ageS: row?.firstSeenS != null ? at - row.firstSeenS : null,
      },
      pool,
    })
  }
}
