import { describe, expect, it } from 'vitest'
import type { SpikeAlert } from '../src/engine/detector.js'
import { fmtAge, fmtMult, fmtPct, fmtPrice, fmtUsd, renderAlertHtml } from '../src/telegram/format.js'

const alert: SpikeAlert = {
  token: '0x39dbed3a2bd333467115de45665cc57f813c4571',
  symbol: 'PONS',
  name: 'Pons',
  multiple: 6.23,
  volumeUsd: 5810,
  baselinePerMin: 931.61,
  swaps: 29,
  swapsMultiple: 5.3,
  buys: 14,
  sells: 15,
  priceUsd: 0.0262,
  d1m: 1.4,
  d5m: 1.3,
  d1h: 3.9,
  mcapUsd: 26_180_000,
  liquidityUsd: 1_050_000,
  holders: 21_784,
  devSold: true,
  ageS: Math.round(17.7 * 3600),
  launchpad: 'noxa',
  at: 1_780_000_000,
}

describe('formatters', () => {
  it('formats USD like the card layout', () => {
    expect(fmtUsd(3400)).toBe('$3.4K')
    expect(fmtUsd(5810)).toBe('$5.8K')
    expect(fmtUsd(37_600)).toBe('$37.6K')
    expect(fmtUsd(26_180_000)).toBe('$26.18M')
    expect(fmtUsd(93.49)).toBe('$93.49')
  })

  it('formats prices with 3 significant digits', () => {
    expect(fmtPrice(0.0000376)).toBe('$0.0000376')
    expect(fmtPrice(0.0262)).toBe('$0.0262')
    expect(fmtPrice(23.4)).toBe('$23.40')
  })

  it('formats percents, multiples, and ages', () => {
    expect(fmtPct(59.83)).toBe('+59.8%')
    expect(fmtPct(-12.3)).toBe('-12.3%')
    expect(fmtMult(36.94)).toBe('36.9×')
    expect(fmtMult(123.4)).toBe('123×')
    expect(fmtAge(30 * 60)).toBe('30m')
    expect(fmtAge(Math.round(17.7 * 3600))).toBe('17.7h')
    expect(fmtAge(3 * 86_400)).toBe('3.0d')
  })
})

describe('renderAlertHtml', () => {
  it('renders the full card', () => {
    const html = renderAlertHtml(alert)
    expect(html).toContain('<b>PONS</b> <i>Pons</i>')
    expect(html).toContain('<b>6.2× volume</b> · $5.8K in 1m vs $931.61/min normal · Robinhood')
    expect(html).toContain('Price $0.0262  1m +1.4%  5m +1.3%  1h +3.9%')
    expect(html).toContain('Swaps 29 (5.3× normal)  buys 14 / sells 15')
    expect(html).toContain('MCap $26.18M  Liquidity $1.05M  Holders 21,784')
    expect(html).toContain('Age 17.7h  Platform NOXA')
    expect(html).toContain('⚠️ dev sold')
    expect(html).toContain('<code>0x39dbed3a2bd333467115de45665cc57f813c4571</code>')
    expect(html).toContain('dexscreener.com/robinhood/0x39dbed3a2bd333467115de45665cc57f813c4571')
  })

  it('drops unknown lines instead of rendering placeholders', () => {
    const bare = renderAlertHtml({
      ...alert,
      symbol: null,
      name: null,
      d1m: null,
      d5m: null,
      d1h: null,
      mcapUsd: null,
      liquidityUsd: null,
      holders: null,
      devSold: null,
      ageS: null,
      launchpad: null,
    })
    expect(bare).toContain('0x39db…4571')
    expect(bare).not.toContain('MCap')
    expect(bare).not.toContain('Age')
    expect(bare).not.toContain('dev sold')
    expect(bare).not.toContain('null')
  })

  it('escapes hostile token names', () => {
    const hostile = renderAlertHtml({ ...alert, symbol: '<b>X</b>', name: 'a & b' })
    expect(hostile).toContain('&lt;b&gt;X&lt;/b&gt;')
    expect(hostile).toContain('a &amp; b')
  })
})
