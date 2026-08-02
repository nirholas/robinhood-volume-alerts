import { describe, expect, it } from 'vitest'
import type { Alert, MarketContext } from '../src/engine/events.js'
import { fmtAge, fmtMult, fmtPct, fmtPrice, fmtUsd, renderAlertHtml } from '../src/telegram/format.js'

const context: MarketContext = {
  priceUsd: 0.0262,
  mcapUsd: 26_180_000,
  liquidityUsd: 1_050_000,
  holders: 21_784,
  devSold: true,
  ageS: Math.round(17.7 * 3600),
  launchpad: 'noxa',
  d1m: 1.4,
  d5m: 1.3,
  d1h: 3.9,
}

const spike: Alert = {
  kind: 'spike',
  token: '0x39dbed3a2bd333467115de45665cc57f813c4571',
  symbol: 'PONS',
  name: 'Pons',
  at: 1_780_000_000,
  context,
  multiple: 6.23,
  volumeUsd: 5810,
  baselinePerMin: 931.61,
  swaps: 29,
  swapsMultiple: 5.3,
  buys: 14,
  sells: 15,
}

describe('formatters', () => {
  it('formats USD like the card layout', () => {
    expect(fmtUsd(3400)).toBe('$3.4K')
    expect(fmtUsd(5810)).toBe('$5.8K')
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

describe('spike cards', () => {
  it('renders the full card', () => {
    const html = renderAlertHtml(spike)
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
      ...spike,
      symbol: null,
      name: null,
      context: {
        priceUsd: 0.0262,
        mcapUsd: null,
        liquidityUsd: null,
        holders: null,
        devSold: null,
        ageS: null,
        launchpad: null,
        d1m: null,
        d5m: null,
        d1h: null,
      },
    })
    expect(bare).toContain('0x39db…4571')
    expect(bare).not.toContain('MCap')
    expect(bare).not.toContain('Age')
    expect(bare).not.toContain('dev sold')
    expect(bare).not.toContain('null')
  })

  it('escapes hostile token names', () => {
    const hostile = renderAlertHtml({ ...spike, symbol: '<b>X</b>', name: 'a & b' })
    expect(hostile).toContain('&lt;b&gt;X&lt;/b&gt;')
    expect(hostile).toContain('a &amp; b')
  })
})

describe('other alert cards', () => {
  const base = { token: spike.token, symbol: 'PONS', name: 'Pons', at: spike.at, context }

  it('renders a whale trade', () => {
    const html = renderAlertHtml({
      ...base,
      kind: 'whale',
      usd: 12_400,
      side: 'buy',
      trader: '0x1111111111111111111111111111111111111111',
      txHash: '0xabc',
      venue: 'uniswap-v3',
    })
    expect(html).toContain('<b>$12.4K buy</b> · Uniswap v3 · Robinhood')
    expect(html).toContain('Trader 0x1111…1111')
    expect(html).toContain('/tx/0xabc')
  })

  it('renders a launch', () => {
    const html = renderAlertHtml({
      ...base,
      kind: 'launch',
      creator: '0x2222222222222222222222222222222222222222',
      pool: '0x3333333333333333333333333333333333333333',
      launchpadName: 'NOXA',
    })
    expect(html).toContain('<b>New launch</b>')
    expect(html).toContain('Creator 0x2222…2222')
    expect(html).toContain('Pool 0x3333…3333')
  })

  it('renders a price move', () => {
    const html = renderAlertHtml({
      ...base,
      kind: 'price_move',
      pct: -34.2,
      windowMinutes: 5,
      fromUsd: 0.04,
      toUsd: 0.0262,
    })
    expect(html).toContain('<b>-34.2% in 5m</b>')
    expect(html).toContain('$0.0400 to $0.0262')
  })

  it('renders a rug warning', () => {
    const html = renderAlertHtml({
      ...base,
      kind: 'liquidity_pull',
      droppedPct: 62,
      beforeUsd: 52_100,
      afterUsd: 19_800,
    })
    expect(html).toContain('<b>Liquidity pulled</b>')
    expect(html).toContain('<b>-62.0%</b> · $52.1K to $19.8K')
  })

  it('renders a watched-wallet trade with its label', () => {
    const html = renderAlertHtml({
      ...base,
      kind: 'wallet_trade',
      wallet: '0x4444444444444444444444444444444444444444',
      walletLabel: 'Whale Bob',
      side: 'sell',
      usd: 3200,
      txHash: '0xdef',
      audience: ['1'],
    })
    expect(html).toContain('<b>Whale Bob</b> sold')
    expect(html).toContain('<b>$3.2K sell</b>')
  })

  it('renders a performance follow-up', () => {
    const html = renderAlertHtml({
      ...base,
      kind: 'performance',
      multiple: 5.4,
      milestone: 5,
      entryPriceUsd: 0.0262,
      peakPriceUsd: 0.1415,
      elapsedS: 38 * 60,
      sourceKind: 'spike',
      audience: ['1'],
    })
    expect(html).toContain('hit <b>5.0×</b>')
    expect(html).toContain('$0.0262 to $0.141 in 38m since the alert')
    expect(html).toContain('Peak 5.4× from the alert price')
  })
})
