/** Every alert family the bot can emit. */
export const ALERT_KINDS = [
  'spike',
  'whale',
  'launch',
  'graduation',
  'price_move',
  'liquidity_pull',
  'wallet_trade',
  'performance',
] as const

export type AlertKind = (typeof ALERT_KINDS)[number]

export function isAlertKind(value: string): value is AlertKind {
  return (ALERT_KINDS as readonly string[]).includes(value)
}

/** Short labels for the settings keyboard. */
export const KIND_LABELS: Record<AlertKind, string> = {
  spike: 'Volume spikes',
  whale: 'Whale trades',
  launch: 'New launches',
  graduation: 'Graduations',
  price_move: 'Price moves',
  liquidity_pull: 'Rug warnings',
  wallet_trade: 'Watched wallets',
  performance: 'Alert follow-ups',
}

/** One-line explanations shown in the alert-type panel. */
export const KIND_DESCRIPTIONS: Record<AlertKind, string> = {
  spike: 'a token trades a multiple of its own normal minute',
  whale: 'a single trade above your dollar threshold',
  launch: 'a new token launches on NOXA or The Odyssey',
  graduation: 'an Odyssey curve fills and liquidity migrates to a pool',
  price_move: 'a token moves more than your percent threshold in 5 minutes',
  liquidity_pull: 'pooled liquidity drops sharply, the rug early warning',
  wallet_trade: 'a wallet on your watchlist trades',
  performance: 'a token you were alerted on hits 2x, 5x, 10x and beyond',
}

/** Market context attached to every alert, each field degrading to null. */
export interface MarketContext {
  priceUsd: number
  mcapUsd: number | null
  liquidityUsd: number | null
  holders: number | null
  devSold: boolean | null
  ageS: number | null
  launchpad: string | null
  /** Signed percent price changes over the trailing windows. */
  d1m: number | null
  d5m: number | null
  d1h: number | null
}

export const EMPTY_CONTEXT: MarketContext = {
  priceUsd: 0,
  mcapUsd: null,
  liquidityUsd: null,
  holders: null,
  devSold: null,
  ageS: null,
  launchpad: null,
  d1m: null,
  d5m: null,
  d1h: null,
}

interface BaseAlert {
  token: string
  symbol: string | null
  name: string | null
  /** Unix seconds. */
  at: number
  context: MarketContext
}

/** Rolling-minute volume ran a multiple above the token's learned normal. */
export interface SpikeAlert extends BaseAlert {
  kind: 'spike'
  multiple: number
  volumeUsd: number
  baselinePerMin: number
  swaps: number
  swapsMultiple: number
  buys: number
  sells: number
}

/** A single trade at or above the whale floor. */
export interface WhaleAlert extends BaseAlert {
  kind: 'whale'
  usd: number
  side: 'buy' | 'sell'
  trader: string
  txHash: string
  venue: 'uniswap-v3' | 'odyssey-curve'
}

/** A new token appeared on a launchpad. */
export interface LaunchAlert extends BaseAlert {
  kind: 'launch'
  creator: string
  pool: string | null
  launchpadName: string
}

/** An Odyssey bonding curve filled and migrated to a locked pool. */
export interface GraduationAlert extends BaseAlert {
  kind: 'graduation'
  pool: string
}

/** Price moved beyond the threshold within the window. */
export interface PriceMoveAlert extends BaseAlert {
  kind: 'price_move'
  pct: number
  windowMinutes: number
  fromUsd: number
  toUsd: number
}

/** Pooled liquidity dropped sharply: the rug early warning. */
export interface LiquidityPullAlert extends BaseAlert {
  kind: 'liquidity_pull'
  droppedPct: number
  beforeUsd: number
  afterUsd: number
}

/** A wallet on someone's watchlist traded. */
export interface WalletTradeAlert extends BaseAlert {
  kind: 'wallet_trade'
  wallet: string
  walletLabel: string | null
  side: 'buy' | 'sell'
  usd: number
  txHash: string
  /** Chats watching this wallet; delivery is restricted to them. */
  audience: string[]
}

/** A previously-alerted token crossed a performance milestone. */
export interface PerformanceAlert extends BaseAlert {
  kind: 'performance'
  /** Peak price divided by the price at alert time. */
  multiple: number
  milestone: number
  entryPriceUsd: number
  peakPriceUsd: number
  /** Seconds between the original alert and the peak. */
  elapsedS: number
  /** The alert that started tracking. */
  sourceKind: AlertKind
  /** Chats that received the original alert. */
  audience: string[]
}

export type Alert =
  | SpikeAlert
  | WhaleAlert
  | LaunchAlert
  | GraduationAlert
  | PriceMoveAlert
  | LiquidityPullAlert
  | WalletTradeAlert
  | PerformanceAlert

/**
 * Alerts that only concern a specific set of chats (rather than everyone who
 * has the kind enabled). Delivery intersects this with the usual gating.
 */
export function audienceOf(alert: Alert): string[] | null {
  if (alert.kind === 'wallet_trade' || alert.kind === 'performance') return alert.audience
  return null
}

/** Stable dedup fingerprint, used to suppress repeats inside a TTL. */
export function fingerprint(alert: Alert): string {
  switch (alert.kind) {
    case 'spike':
      return `spike:${alert.token}:${Math.round(alert.multiple)}`
    case 'whale':
      return `whale:${alert.txHash}:${alert.token}`
    case 'launch':
      return `launch:${alert.token}`
    case 'graduation':
      return `grad:${alert.token}`
    case 'price_move':
      return `price:${alert.token}:${alert.pct >= 0 ? 'up' : 'down'}:${Math.round(alert.pct / 10)}`
    case 'liquidity_pull':
      return `liq:${alert.token}:${Math.round(alert.droppedPct / 10)}`
    case 'wallet_trade':
      return `wallet:${alert.wallet}:${alert.txHash}`
    case 'performance':
      return `perf:${alert.token}:${alert.milestone}:${alert.at}`
  }
}
