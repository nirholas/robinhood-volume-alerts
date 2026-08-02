import { MAINNET_EXPLORER_URL } from 'hoodchain'
import type { Alert, MarketContext } from '../engine/events.js'

/** Compact USD: $931.61 below $1k, $5.8K to $999.9K, $26.18M above. */
export function fmtUsd(n: number): string {
  if (n >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(2)}B`
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`
  return `$${n.toFixed(2)}`
}

/** Price with 3 significant digits: $0.0000376, $0.0262, $1.05, $23.40. */
export function fmtPrice(n: number): string {
  if (n <= 0 || !Number.isFinite(n)) return '$0'
  if (n >= 1) return `$${n.toFixed(2)}`
  return `$${Number(n.toPrecision(3)).toFixed(Math.max(2, -Math.floor(Math.log10(n)) + 2))}`
}

export function fmtPct(n: number): string {
  const sign = n >= 0 ? '+' : ''
  return `${sign}${n.toFixed(1)}%`
}

export function fmtMult(n: number): string {
  return `${n >= 100 ? Math.round(n) : n.toFixed(1)}×`
}

export function fmtInt(n: number): string {
  return Math.round(n).toLocaleString('en-US')
}

/** 0m, 45m, 17.7h, 3.2d. */
export function fmtAge(seconds: number): string {
  const minutes = seconds / 60
  if (minutes < 60) return `${Math.floor(minutes)}m`
  const hours = minutes / 60
  if (hours < 48) return `${hours.toFixed(1)}h`
  return `${(hours / 24).toFixed(1)}d`
}

export function shortAddr(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`
}

export function escapeHtml(s: string): string {
  return s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

const LAUNCHPAD_LABELS: Record<string, string> = { noxa: 'NOXA', odyssey: 'The Odyssey' }

export function dexScreenerUrl(token: string): string {
  return `https://dexscreener.com/robinhood/${token}`
}

export function explorerTokenUrl(token: string): string {
  return `${MAINNET_EXPLORER_URL}/token/${token}`
}

export function explorerTxUrl(hash: string): string {
  return `${MAINNET_EXPLORER_URL}/tx/${hash}`
}

export function explorerAddressUrl(address: string): string {
  return `${MAINNET_EXPLORER_URL}/address/${address}`
}

export function chartUrl(token: string): string {
  return `https://three.ws/markets/robinhood/coin/${token}`
}

function emojiForSpike(multiple: number): string {
  if (multiple >= 20) return '\u{1F4A5}'
  if (multiple >= 10) return '\u{1F680}'
  if (multiple >= 6) return '\u{1F525}'
  return '\u{1F4C8}'
}

/** `SYMBOL Name` headline, falling back to a shortened address. */
function title(alert: Alert): string {
  const symbol = alert.symbol ? escapeHtml(alert.symbol) : shortAddr(alert.token)
  const name = alert.name && alert.name !== alert.symbol ? ` <i>${escapeHtml(alert.name)}</i>` : ''
  return `<b>${symbol}</b>${name}`
}

/** The price/market lines shared by most cards, as blockquote content. */
function statLines(context: MarketContext, extra: string[] = []): string[] {
  const lines: string[] = []
  if (context.priceUsd > 0) {
    const parts = [`Price ${fmtPrice(context.priceUsd)}`]
    if (context.d1m !== null) parts.push(`1m ${fmtPct(context.d1m)}`)
    if (context.d5m !== null) parts.push(`5m ${fmtPct(context.d5m)}`)
    if (context.d1h !== null) parts.push(`1h ${fmtPct(context.d1h)}`)
    lines.push(parts.join('  '))
  }
  lines.push(...extra)

  const market: string[] = []
  if (context.mcapUsd !== null) market.push(`MCap ${fmtUsd(context.mcapUsd)}`)
  if (context.liquidityUsd !== null) market.push(`Liquidity ${fmtUsd(context.liquidityUsd)}`)
  if (context.holders !== null) market.push(`Holders ${fmtInt(context.holders)}`)
  if (market.length > 0) lines.push(market.join('  '))

  const origin: string[] = []
  if (context.ageS !== null) origin.push(`Age ${fmtAge(context.ageS)}`)
  if (context.launchpad) origin.push(`Platform ${LAUNCHPAD_LABELS[context.launchpad] ?? context.launchpad}`)
  if (origin.length > 0) lines.push(origin.join('  '))

  return lines
}

function block(lines: string[]): string {
  return lines.length > 0 ? `<blockquote>${lines.join('\n')}</blockquote>` : ''
}

function footer(alert: Alert, links: string[]): string {
  return [`<code>${alert.token}</code>`, links.join(' · ')].join('\n')
}

function defaultLinks(token: string): string[] {
  return [
    `<a href="${explorerTokenUrl(token)}">Scan</a>`,
    `<a href="${dexScreenerUrl(token)}">DexScreener</a>`,
    `<a href="${chartUrl(token)}">Chart</a>`,
  ]
}

/** Render any alert as Telegram HTML. */
export function renderAlertHtml(alert: Alert): string {
  const warning = alert.context.devSold === true ? '\n⚠️ dev sold' : ''

  switch (alert.kind) {
    case 'spike': {
      const head = `${emojiForSpike(alert.multiple)} ${title(alert)}`
      const spike = `<b>${fmtMult(alert.multiple)} volume</b> · ${fmtUsd(alert.volumeUsd)} in 1m vs ${fmtUsd(
        alert.baselinePerMin,
      )}/min normal · Robinhood`
      const swaps = `Swaps ${alert.swaps} (${fmtMult(alert.swapsMultiple)} normal)  buys ${alert.buys} / sells ${alert.sells}`
      return [
        `${head}\n${spike}`,
        `${block(statLines(alert.context, [swaps]))}${warning}`,
        footer(alert, defaultLinks(alert.token)),
      ].join('\n')
    }

    case 'whale': {
      const emoji = alert.side === 'buy' ? '\u{1F40B}' : '\u{1F4B8}'
      const head = `${emoji} ${title(alert)}`
      const line = `<b>${fmtUsd(alert.usd)} ${alert.side}</b> · ${
        alert.venue === 'odyssey-curve' ? 'Odyssey curve' : 'Uniswap v3'
      } · Robinhood`
      const trader = alert.trader ? [`Trader ${shortAddr(alert.trader)}`] : []
      return [
        `${head}\n${line}`,
        `${block(statLines(alert.context, trader))}${warning}`,
        footer(alert, [
          ...defaultLinks(alert.token),
          `<a href="${explorerTxUrl(alert.txHash)}">Tx</a>`,
        ]),
      ].join('\n')
    }

    case 'launch': {
      const head = `\u{1F331} <b>New launch</b> ${title(alert)}`
      const line = `${escapeHtml(alert.launchpadName)} · Robinhood`
      const lines = [
        `Creator ${shortAddr(alert.creator)}`,
        alert.pool ? `Pool ${shortAddr(alert.pool)}` : 'Trading on the curve until it graduates',
      ]
      return [`${head}\n${line}`, block(lines), footer(alert, defaultLinks(alert.token))].join('\n')
    }

    case 'graduation': {
      const head = `\u{1F393} <b>Graduated</b> ${title(alert)}`
      const line = 'The curve filled; liquidity migrated to a locked Uniswap v3 pool.'
      return [
        `${head}\n${line}`,
        block([`Pool ${shortAddr(alert.pool)}`, ...statLines(alert.context)]),
        footer(alert, defaultLinks(alert.token)),
      ].join('\n')
    }

    case 'price_move': {
      const up = alert.pct >= 0
      const head = `${up ? '\u{1F4C8}' : '\u{1F4C9}'} ${title(alert)}`
      const line = `<b>${fmtPct(alert.pct)} in ${alert.windowMinutes}m</b> · ${fmtPrice(alert.fromUsd)} to ${fmtPrice(
        alert.toUsd,
      )} · Robinhood`
      return [
        `${head}\n${line}`,
        `${block(statLines(alert.context))}${warning}`,
        footer(alert, defaultLinks(alert.token)),
      ].join('\n')
    }

    case 'liquidity_pull': {
      const head = `\u{1F6A8} <b>Liquidity pulled</b> ${title(alert)}`
      const line = `<b>-${alert.droppedPct.toFixed(1)}%</b> · ${fmtUsd(alert.beforeUsd)} to ${fmtUsd(
        alert.afterUsd,
      )} · Robinhood`
      return [
        `${head}\n${line}`,
        `${block(statLines(alert.context))}${warning}`,
        footer(alert, defaultLinks(alert.token)),
      ].join('\n')
    }

    case 'wallet_trade': {
      const who = alert.walletLabel ? escapeHtml(alert.walletLabel) : shortAddr(alert.wallet)
      const head = `\u{1F464} <b>${who}</b> ${alert.side === 'buy' ? 'bought' : 'sold'} ${title(alert)}`
      const line = `<b>${fmtUsd(alert.usd)} ${alert.side}</b> · Robinhood`
      return [
        `${head}\n${line}`,
        `${block(statLines(alert.context))}${warning}`,
        footer(alert, [
          ...defaultLinks(alert.token),
          `<a href="${explorerAddressUrl(alert.wallet)}">Wallet</a>`,
          `<a href="${explorerTxUrl(alert.txHash)}">Tx</a>`,
        ]),
      ].join('\n')
    }

    case 'performance': {
      const head = `\u{1F3C6} ${title(alert)} hit <b>${fmtMult(alert.milestone)}</b>`
      const line = `${fmtPrice(alert.entryPriceUsd)} to ${fmtPrice(alert.peakPriceUsd)} in ${fmtAge(
        alert.elapsedS,
      )} since the alert`
      return [
        `${head}\n${line}`,
        block([`Peak ${fmtMult(alert.multiple)} from the alert price`, ...statLines(alert.context).slice(1)]),
        footer(alert, defaultLinks(alert.token)),
      ].join('\n')
    }
  }
}
