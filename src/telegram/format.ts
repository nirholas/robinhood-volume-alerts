import { MAINNET_EXPLORER_URL } from 'hoodchain'
import type { SpikeAlert } from '../engine/detector.js'

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

export function escapeHtml(s: string): string {
  return s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

function emojiFor(multiple: number): string {
  if (multiple >= 20) return '\u{1F4A5}' // collision
  if (multiple >= 10) return '\u{1F680}' // rocket
  if (multiple >= 6) return '\u{1F525}' // fire
  return '\u{1F4C8}' // chart increasing
}

const LAUNCHPAD_LABELS: Record<string, string> = {
  noxa: 'NOXA',
  odyssey: 'The Odyssey',
}

export function dexScreenerUrl(token: string): string {
  return `https://dexscreener.com/robinhood/${token}`
}

export function explorerTokenUrl(token: string): string {
  return `${MAINNET_EXPLORER_URL}/token/${token}`
}

export function chartUrl(token: string): string {
  return `https://three.ws/markets/robinhood/coin/${token}`
}

/**
 * Render a spike alert as Telegram HTML, in the compact card layout:
 * headline (emoji, symbol, name), the spike line, a quoted stats block,
 * optional dev-sold warning, the copyable contract address, and a link row.
 */
export function renderAlertHtml(a: SpikeAlert): string {
  const symbol = a.symbol ? escapeHtml(a.symbol) : `${a.token.slice(0, 6)}…${a.token.slice(-4)}`
  const name = a.name && a.name !== a.symbol ? ` <i>${escapeHtml(a.name)}</i>` : ''

  const head = `${emojiFor(a.multiple)} <b>${symbol}</b>${name}`
  const spike = `<b>${fmtMult(a.multiple)} volume</b> · ${fmtUsd(a.volumeUsd)} in 1m vs ${fmtUsd(a.baselinePerMin)}/min normal · Robinhood`

  const priceParts = [`Price ${fmtPrice(a.priceUsd)}`]
  if (a.d1m !== null) priceParts.push(`1m ${fmtPct(a.d1m)}`)
  if (a.d5m !== null) priceParts.push(`5m ${fmtPct(a.d5m)}`)
  if (a.d1h !== null) priceParts.push(`1h ${fmtPct(a.d1h)}`)

  const statLines = [
    priceParts.join('  '),
    `Swaps ${a.swaps} (${fmtMult(a.swapsMultiple)} normal)  buys ${a.buys} / sells ${a.sells}`,
  ]
  const marketParts: string[] = []
  if (a.mcapUsd !== null) marketParts.push(`MCap ${fmtUsd(a.mcapUsd)}`)
  if (a.liquidityUsd !== null) marketParts.push(`Liquidity ${fmtUsd(a.liquidityUsd)}`)
  if (a.holders !== null) marketParts.push(`Holders ${fmtInt(a.holders)}`)
  if (marketParts.length > 0) statLines.push(marketParts.join('  '))

  const originParts: string[] = []
  if (a.ageS !== null) originParts.push(`Age ${fmtAge(a.ageS)}`)
  if (a.launchpad) originParts.push(`Platform ${LAUNCHPAD_LABELS[a.launchpad] ?? a.launchpad}`)
  if (originParts.length > 0) statLines.push(originParts.join('  '))

  const warning = a.devSold === true ? '\n⚠️ dev sold' : ''

  const links = [
    `<a href="${explorerTokenUrl(a.token)}">Scan</a>`,
    `<a href="${dexScreenerUrl(a.token)}">DexScreener</a>`,
    `<a href="${chartUrl(a.token)}">Chart</a>`,
  ].join(' · ')

  return [
    `${head}\n${spike}`,
    `<blockquote>${statLines.join('\n')}</blockquote>${warning}`,
    `<code>${a.token}</code>`,
    links,
  ].join('\n')
}
