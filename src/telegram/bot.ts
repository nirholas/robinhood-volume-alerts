import { Bot, GrammyError, InlineKeyboard } from 'grammy'
import type { Config } from '../config.js'
import type { ChatSettings, Store } from '../db.js'
import { ALERT_KINDS, KIND_DESCRIPTIONS, KIND_LABELS, audienceOf, type Alert, type AlertKind } from '../engine/events.js'
import { logger } from '../logger.js'
import {
  chartUrl,
  dexScreenerUrl,
  escapeHtml,
  explorerTokenUrl,
  fmtAge,
  fmtMult,
  fmtPct,
  fmtUsd,
  renderAlertHtml,
  shortAddr,
} from './format.js'
import {
  moneyLabel,
  newTokensLabel,
  priceMoveLabel,
  PRICE_MOVE_STEPS,
  rugLabel,
  RUG_STEPS,
  spikeLabel,
  SPIKE_STEPS,
  step,
  swapsLabel,
  SWAPS_STEPS,
  volumeLabel,
  VOLUME_STEPS,
  whaleLabel,
  WHALE_STEPS,
} from './settings.js'

const SENSITIVITY_TEXT = [
  '🎚 <b>Sensitivity</b>',
  '',
  'How big a jump has to be before it reaches you. Tap a value to step it up; it wraps around at the top.',
  '',
  '<blockquote><b>Spike</b>: how many times its own normal minute the token must trade. 3× is loose, 10× is rare.',
  '<b>Volume</b>: ignore anything smaller than this in the spiking minute. The floor that keeps dust out.',
  '<b>Swaps</b>: the minimum number of trades in that minute, so one whale print alone does not page you.',
  '<b>New tokens</b>: whether coins younger than an hour (thin history, wild multiples) may alert at all.',
  '<b>Whale</b>, <b>Price move</b>, <b>Rug drop</b>: thresholds for those alert types.</blockquote>',
].join('\n')

const HELP_TEXT = [
  '<b>Robinhood Volume Alerts</b>',
  '',
  "I watch every DEX trade on Robinhood Chain, learn each token's normal per-minute volume, and message you when something breaks pattern.",
  '',
  '<b>Setup</b>',
  '/start: sensitivity panel',
  '/alerts: pick which alert types you get',
  '/settings: status, pause, everything else',
  '',
  '<b>Watchlists</b>',
  '/watch &lt;address&gt; [label]: follow a wallet or token',
  '/unwatch &lt;address&gt;: stop following it',
  '/watching: your watchlist',
  '',
  '<b>Market</b>',
  '/top: the hour&#39;s heaviest tokens',
  '/scorecard: how my alerts have actually performed',
  '/muted: tokens you silenced',
  '/pause and /resume: stop and restart alerts',
  '',
  'Watched tokens bypass your spike thresholds, so you always hear about them.',
].join('\n')

/** Delay between outgoing messages, well under Telegram's global limit. */
const SEND_SPACING_MS = 50

export class TelegramAlertBot {
  readonly bot: Bot
  private queue: Promise<void> = Promise.resolve()
  alertsSent = 0

  constructor(
    token: string,
    private readonly store: Store,
    private readonly cfg: Config,
    /**
     * Resolves symbols for tokens the alert path has never touched. `/top`
     * ranks by raw volume, so it routinely surfaces coins with no cached
     * metadata; without this they would render as bare addresses.
     */
    private readonly meta?: { get: (token: `0x${string}`) => Promise<{ symbol: string | null }> },
  ) {
    this.bot = new Bot(token)
    this.wire()
  }

  // ---- panels ---------------------------------------------------------------

  private sensitivityKeyboard(s: ChatSettings): InlineKeyboard {
    return new InlineKeyboard()
      .text(spikeLabel(s), 'set:spike')
      .text(volumeLabel(s), 'set:vol')
      .row()
      .text(swapsLabel(s), 'set:swaps')
      .text(newTokensLabel(s), 'set:new')
      .row()
      .text(whaleLabel(s), 'set:whale')
      .text(priceMoveLabel(s), 'set:pricemove')
      .row()
      .text(rugLabel(s), 'set:rug')
      .text('🔔 Alert types', 'menu:kinds')
      .row()
      .text('‹ Back', 'menu:main')
      .text('✕ Close', 'menu:close')
  }

  private kindsText(s: ChatSettings): string {
    const lines = ALERT_KINDS.map(
      (k) => `${s.kinds.includes(k) ? '✅' : '⬜️'} <b>${KIND_LABELS[k]}</b>: ${KIND_DESCRIPTIONS[k]}`,
    )
    return ['🔔 <b>Alert types</b>', '', 'Tap to turn a type on or off.', '', `<blockquote>${lines.join('\n')}</blockquote>`].join(
      '\n',
    )
  }

  private kindsKeyboard(s: ChatSettings): InlineKeyboard {
    const keyboard = new InlineKeyboard()
    ALERT_KINDS.forEach((kind, i) => {
      keyboard.text(`${s.kinds.includes(kind) ? '✅' : '⬜️'} ${KIND_LABELS[kind]}`, `kind:${kind}`)
      if (i % 2 === 1) keyboard.row()
    })
    if (ALERT_KINDS.length % 2 === 1) keyboard.row()
    return keyboard.text('‹ Back', 'menu:main').text('✕ Close', 'menu:close')
  }

  private mainText(s: ChatSettings): string {
    const watches = this.store.listWatches(s.chatId)
    return [
      '<b>Robinhood Volume Alerts</b>',
      '',
      s.paused ? '⏸ Alerts are <b>paused</b>.' : '▶️ Alerts are <b>on</b>.',
      `Sensitivity: ${spikeLabel(s)} · ${volumeLabel(s)} · ${swapsLabel(s)} · ${newTokensLabel(s)}`,
      `Alert types on: ${s.kinds.length}/${ALERT_KINDS.length}`,
      `Watching: ${watches.filter((w) => w.kind === 'wallet').length} wallets, ${
        watches.filter((w) => w.kind === 'token').length
      } tokens`,
      `Muted tokens: ${this.store.listMutes(s.chatId).length}`,
    ].join('\n')
  }

  private mainKeyboard(s: ChatSettings): InlineKeyboard {
    return new InlineKeyboard()
      .text('🎚 Sensitivity', 'menu:sensitivity')
      .text('🔔 Alert types', 'menu:kinds')
      .row()
      .text('👁 Watchlist', 'menu:watching')
      .text('🔕 Muted', 'menu:muted')
      .row()
      .text('🏆 Scorecard', 'menu:scorecard')
      .text('📊 Top movers', 'menu:top')
      .row()
      .text(s.paused ? '▶️ Resume' : '⏸ Pause', 'toggle:paused')
      .text('✕ Close', 'menu:close')
  }

  private mutedPanel(chatId: string): { text: string; keyboard: InlineKeyboard } {
    const mutes = this.store.listMutes(chatId)
    const keyboard = new InlineKeyboard()
    for (const token of mutes.slice(0, 10)) {
      const row = this.store.getToken(token)
      keyboard.text(row?.symbol ? `🔊 Unmute ${row.symbol}` : `🔊 ${shortAddr(token)}`, `unmute:${token}`).row()
    }
    keyboard.text('‹ Back', 'menu:main').text('✕ Close', 'menu:close')
    const text =
      mutes.length === 0
        ? '🔕 <b>Muted tokens</b>\n\nNothing muted. Every alert has a mute button when you need one.'
        : `🔕 <b>Muted tokens</b>\n\n${mutes
            .slice(0, 10)
            .map((t) => {
              const row = this.store.getToken(t)
              return `• ${row?.symbol ? escapeHtml(row.symbol) : t}`
            })
            .join('\n')}${mutes.length > 10 ? `\n…and ${mutes.length - 10} more.` : ''}`
    return { text, keyboard }
  }

  private watchingPanel(chatId: string): { text: string; keyboard: InlineKeyboard } {
    const watches = this.store.listWatches(chatId)
    const keyboard = new InlineKeyboard()
    for (const watch of watches.slice(0, 10)) {
      const row = watch.kind === 'token' ? this.store.getToken(watch.target) : null
      const name = watch.label ?? row?.symbol ?? shortAddr(watch.target)
      keyboard.text(`✕ ${name}`, `unwatch:${watch.kind}:${watch.target}`).row()
    }
    keyboard.text('‹ Back', 'menu:main').text('✕ Close', 'menu:close')

    const body =
      watches.length === 0
        ? [
            'Nothing yet. Follow a wallet to see every trade it makes, or a token to get its alerts regardless of your thresholds.',
            '',
            'Add one with <code>/watch 0xaddress Label</code>.',
          ].join('\n')
        : watches
            .slice(0, 10)
            .map((w) => {
              const row = w.kind === 'token' ? this.store.getToken(w.target) : null
              const name = w.label ?? row?.symbol ?? null
              return `• ${w.kind === 'wallet' ? '👤' : '🪙'} ${name ? `${escapeHtml(name)} ` : ''}<code>${shortAddr(
                w.target,
              )}</code>`
            })
            .join('\n') + (watches.length > 10 ? `\n…and ${watches.length - 10} more.` : '')
    return { text: `👁 <b>Watchlist</b>\n\n${body}`, keyboard }
  }

  private async topText(): Promise<string> {
    const nowMinute = Math.floor(Date.now() / 60000)
    const movers = this.store.topMovers(nowMinute - 60, nowMinute, 10)
    if (movers.length === 0) {
      return '📊 <b>Top movers</b>\n\nNo trades recorded in the last hour yet. Give the feed a minute.'
    }
    if (this.meta) {
      const unknown = movers.filter((m) => !m.symbol)
      await Promise.all(
        unknown.map(async (m) => {
          try {
            m.symbol = (await this.meta?.get(m.token as `0x${string}`))?.symbol ?? null
          } catch {
            // Leave it as an address rather than failing the whole panel.
          }
        }),
      )
    }
    const lines = movers.map((m, i) => {
      const name = m.symbol ? escapeHtml(m.symbol) : shortAddr(m.token)
      const move = m.pct !== 0 ? `  ${fmtPct(m.pct)}` : ''
      return `${String(i + 1).padStart(2)}. <b>${name}</b>  ${fmtUsd(m.volumeUsd)}  ${m.swaps} swaps${move}`
    })
    return ['📊 <b>Top movers, last hour</b>', '', `<blockquote>${lines.join('\n')}</blockquote>`].join('\n')
  }

  private scorecardText(): string {
    const since = Math.floor(Date.now() / 1000) - 7 * 24 * 3600
    const card = this.store.scorecard(since)
    if (card.tracked === 0) {
      return [
        '🏆 <b>Scorecard</b>',
        '',
        'No alerts tracked yet. Every volume-spike alert opens a tracker that follows the price for 24 hours, and this is where the results land.',
      ].join('\n')
    }
    const rate = (n: number): string => (card.settled === 0 ? 'n/a' : `${Math.round((n / card.settled) * 100)}%`)
    const best = card.best
      ? `Best: <b>${card.best.symbol ? escapeHtml(card.best.symbol) : shortAddr(card.best.token)}</b> at ${fmtMult(
          card.best.multiple,
        )}`
      : 'Best: not enough data yet'
    return [
      '🏆 <b>Scorecard, last 7 days</b>',
      '',
      '<blockquote>' +
        [
          `Alerts tracked: ${card.tracked} (${card.settled} settled)`,
          `Reached 2×: ${card.hit2x} (${rate(card.hit2x)})`,
          `Reached 5×: ${card.hit5x} (${rate(card.hit5x)})`,
          `Reached 10×: ${card.hit10x} (${rate(card.hit10x)})`,
          `Median peak: ${fmtMult(card.medianPeak)}`,
          best,
        ].join('\n') +
        '</blockquote>',
      '',
      'Rates count settled calls only, so a call still in flight can never flatter them.',
    ].join('\n')
  }

  // ---- commands -------------------------------------------------------------

  private parseWatchArgs(raw: string): { kind: 'wallet' | 'token'; target: string; label: string | null } | null {
    const parts = raw.trim().split(/\s+/).filter(Boolean)
    if (parts.length === 0) return null
    let kind: 'wallet' | 'token' | null = null
    if (parts[0] === 'wallet' || parts[0] === 'token') {
      kind = parts.shift() as 'wallet' | 'token'
    }
    const target = parts.shift()
    if (!target || !/^0x[0-9a-fA-F]{40}$/.test(target)) return null
    const label = parts.length > 0 ? parts.join(' ').slice(0, 40) : null
    // Auto-detect: an address we already know as a traded token is a token,
    // anything else is a wallet.
    const resolved = kind ?? (this.store.poolsForToken(target).length > 0 ? 'token' : 'wallet')
    return { kind: resolved, target: target.toLowerCase(), label }
  }

  private wire(): void {
    const reply = async (
      ctx: { reply: (text: string, opts: Record<string, unknown>) => Promise<unknown> },
      text: string,
      keyboard?: InlineKeyboard,
    ): Promise<void> => {
      await ctx.reply(text, {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        ...(keyboard ? { reply_markup: keyboard } : {}),
      })
    }

    this.bot.command('start', async (ctx) => {
      const settings = this.store.getChat(String(ctx.chat.id))
      this.store.upsertChat(settings)
      await reply(ctx, SENSITIVITY_TEXT, this.sensitivityKeyboard(settings))
    })

    this.bot.command('settings', async (ctx) => {
      const s = this.store.getChat(String(ctx.chat.id))
      await reply(ctx, this.mainText(s), this.mainKeyboard(s))
    })

    this.bot.command('alerts', async (ctx) => {
      const s = this.store.getChat(String(ctx.chat.id))
      this.store.upsertChat(s)
      await reply(ctx, this.kindsText(s), this.kindsKeyboard(s))
    })

    this.bot.command('pause', async (ctx) => {
      const s = this.store.getChat(String(ctx.chat.id))
      this.store.upsertChat({ ...s, paused: true })
      await reply(ctx, '⏸ Alerts paused. /resume brings them back.')
    })

    this.bot.command('resume', async (ctx) => {
      const s = this.store.getChat(String(ctx.chat.id))
      this.store.upsertChat({ ...s, paused: false })
      await reply(ctx, '▶️ Alerts resumed.')
    })

    this.bot.command('muted', async (ctx) => {
      const { text, keyboard } = this.mutedPanel(String(ctx.chat.id))
      await reply(ctx, text, keyboard)
    })

    this.bot.command('watch', async (ctx) => {
      const chatId = String(ctx.chat.id)
      const parsed = this.parseWatchArgs(ctx.match ?? '')
      if (!parsed) {
        await reply(
          ctx,
          [
            'Usage: <code>/watch 0xaddress Label</code>',
            '',
            'I work out whether it is a wallet or a token. Force it with <code>/watch wallet 0x…</code> or <code>/watch token 0x…</code>.',
          ].join('\n'),
        )
        return
      }
      this.store.upsertChat(this.store.getChat(chatId))
      this.store.addWatch(chatId, parsed.kind, parsed.target, parsed.label)
      const what = parsed.kind === 'wallet' ? 'Wallet' : 'Token'
      const effect =
        parsed.kind === 'wallet'
          ? 'Every trade it makes reaches you, whatever your thresholds say.'
          : 'Its spikes reach you regardless of your spike, volume and swap thresholds.'
      await reply(ctx, `👁 ${what} <code>${shortAddr(parsed.target)}</code> added. ${effect}`)
    })

    this.bot.command('unwatch', async (ctx) => {
      const chatId = String(ctx.chat.id)
      const parsed = this.parseWatchArgs(ctx.match ?? '')
      if (!parsed) {
        await reply(ctx, 'Usage: <code>/unwatch 0xaddress</code>')
        return
      }
      const removed =
        this.store.removeWatch(chatId, 'wallet', parsed.target) || this.store.removeWatch(chatId, 'token', parsed.target)
      await reply(ctx, removed ? '✕ Removed from your watchlist.' : 'That address was not on your watchlist.')
    })

    this.bot.command('watching', async (ctx) => {
      const { text, keyboard } = this.watchingPanel(String(ctx.chat.id))
      await reply(ctx, text, keyboard)
    })

    this.bot.command('top', async (ctx) => {
      await reply(ctx, await this.topText())
    })

    this.bot.command('scorecard', async (ctx) => {
      await reply(ctx, this.scorecardText())
    })

    this.bot.command('help', async (ctx) => {
      await reply(ctx, HELP_TEXT)
    })

    this.bot.on('callback_query:data', async (ctx) => {
      const data = ctx.callbackQuery.data
      const chatId = String(ctx.chat?.id ?? ctx.callbackQuery.from.id)
      const s = this.store.getChat(chatId)

      const editTo = async (text: string, keyboard: InlineKeyboard): Promise<void> => {
        try {
          await ctx.editMessageText(text, {
            parse_mode: 'HTML',
            reply_markup: keyboard,
            link_preview_options: { is_disabled: true },
          })
        } catch (error) {
          if (!(error instanceof GrammyError && error.description.includes('not modified'))) {
            logger.warn({ err: String(error) }, 'panel edit failed')
          }
        }
      }

      const stepSetting = async (next: ChatSettings, toast: string): Promise<void> => {
        this.store.upsertChat(next)
        await editTo(SENSITIVITY_TEXT, this.sensitivityKeyboard(next))
        await ctx.answerCallbackQuery({ text: toast })
      }

      if (data === 'set:spike') {
        const next = { ...s, spikeX: step(SPIKE_STEPS, s.spikeX) }
        await stepSetting(next, `Spike threshold: ${next.spikeX}× normal`)
      } else if (data === 'set:vol') {
        const next = { ...s, minVolumeUsd: step(VOLUME_STEPS, s.minVolumeUsd) }
        await stepSetting(next, `Volume floor: ${moneyLabel(next.minVolumeUsd)}`)
      } else if (data === 'set:swaps') {
        const next = { ...s, minSwaps: step(SWAPS_STEPS, s.minSwaps) }
        await stepSetting(next, `Swap floor: ${next.minSwaps} per minute`)
      } else if (data === 'set:new') {
        const next = { ...s, newTokens: !s.newTokens }
        await stepSetting(next, next.newTokens ? 'New tokens may alert' : 'New tokens muted for their first hour')
      } else if (data === 'set:whale') {
        const next = { ...s, whaleMinUsd: step(WHALE_STEPS, s.whaleMinUsd) }
        await stepSetting(next, `Whale trades from ${moneyLabel(next.whaleMinUsd)}`)
      } else if (data === 'set:pricemove') {
        const next = { ...s, priceMovePct: step(PRICE_MOVE_STEPS, s.priceMovePct) }
        await stepSetting(next, `Price moves from ${next.priceMovePct}% in 5 minutes`)
      } else if (data === 'set:rug') {
        const next = { ...s, rugDropPct: step(RUG_STEPS, s.rugDropPct) }
        await stepSetting(next, `Rug warning at a ${next.rugDropPct}% liquidity drop`)
      } else if (data.startsWith('kind:')) {
        const kind = data.slice(5) as AlertKind
        const enabled = s.kinds.includes(kind)
        const kinds = enabled ? s.kinds.filter((k) => k !== kind) : [...s.kinds, kind]
        const next = { ...s, kinds }
        this.store.upsertChat(next)
        await editTo(this.kindsText(next), this.kindsKeyboard(next))
        await ctx.answerCallbackQuery({ text: `${KIND_LABELS[kind]} ${enabled ? 'off' : 'on'}` })
      } else if (data === 'menu:sensitivity') {
        await editTo(SENSITIVITY_TEXT, this.sensitivityKeyboard(s))
        await ctx.answerCallbackQuery()
      } else if (data === 'menu:kinds') {
        await editTo(this.kindsText(s), this.kindsKeyboard(s))
        await ctx.answerCallbackQuery()
      } else if (data === 'menu:main') {
        await editTo(this.mainText(s), this.mainKeyboard(s))
        await ctx.answerCallbackQuery()
      } else if (data === 'menu:muted') {
        const { text, keyboard } = this.mutedPanel(chatId)
        await editTo(text, keyboard)
        await ctx.answerCallbackQuery()
      } else if (data === 'menu:watching') {
        const { text, keyboard } = this.watchingPanel(chatId)
        await editTo(text, keyboard)
        await ctx.answerCallbackQuery()
      } else if (data === 'menu:top') {
        await editTo(await this.topText(), new InlineKeyboard().text('‹ Back', 'menu:main').text('✕ Close', 'menu:close'))
        await ctx.answerCallbackQuery()
      } else if (data === 'menu:scorecard') {
        await editTo(this.scorecardText(), new InlineKeyboard().text('‹ Back', 'menu:main').text('✕ Close', 'menu:close'))
        await ctx.answerCallbackQuery()
      } else if (data === 'menu:close') {
        try {
          await ctx.deleteMessage()
        } catch {
          await ctx.editMessageReplyMarkup().catch(() => undefined)
        }
        await ctx.answerCallbackQuery()
      } else if (data === 'toggle:paused') {
        const next = { ...s, paused: !s.paused }
        this.store.upsertChat(next)
        await editTo(this.mainText(next), this.mainKeyboard(next))
        await ctx.answerCallbackQuery({ text: next.paused ? 'Paused' : 'Resumed' })
      } else if (data.startsWith('mute:')) {
        this.store.mute(chatId, data.slice(5))
        this.store.upsertChat(s)
        await ctx.answerCallbackQuery({ text: 'Muted. /muted to manage.' })
      } else if (data.startsWith('unmute:')) {
        this.store.unmute(chatId, data.slice(7))
        const { text, keyboard } = this.mutedPanel(chatId)
        await editTo(text, keyboard)
        await ctx.answerCallbackQuery({ text: 'Unmuted.' })
      } else if (data.startsWith('unwatch:')) {
        const [, kind, target] = data.split(':')
        if (kind === 'wallet' || kind === 'token') this.store.removeWatch(chatId, kind, target ?? '')
        const { text, keyboard } = this.watchingPanel(chatId)
        await editTo(text, keyboard)
        await ctx.answerCallbackQuery({ text: 'Removed.' })
      } else if (data.startsWith('watch:')) {
        const target = data.slice(6)
        this.store.upsertChat(s)
        this.store.addWatch(chatId, 'token', target, null)
        await ctx.answerCallbackQuery({ text: 'Watching. Its alerts now bypass your thresholds.' })
      } else {
        await ctx.answerCallbackQuery()
      }
    })

    this.bot.catch((err) => logger.error({ err: String(err.error) }, 'telegram update error'))
  }

  // ---- delivery -------------------------------------------------------------

  /**
   * Fan an alert out to the channel feed and every eligible subscriber.
   * Returns the chats it actually reached, which the performance tracker
   * uses as the follow-up audience.
   */
  async deliver(alert: Alert): Promise<string[]> {
    const reached: string[] = []
    if (this.cfg.telegramChannelId) this.deliverToChannel(this.cfg.telegramChannelId, alert)

    const audience = audienceOf(alert)
    for (const chat of this.store.listActiveChats()) {
      if (audience !== null && !audience.includes(chat.chatId)) continue
      if (!this.eligible(chat, alert)) continue
      reached.push(chat.chatId)
      this.enqueue(async () => {
        try {
          await this.bot.api.sendMessage(Number(chat.chatId), renderAlertHtml(alert), {
            parse_mode: 'HTML',
            link_preview_options: { is_disabled: true },
            reply_markup: this.alertKeyboard(alert, chat),
          })
          this.store.setLastAlert(chat.chatId, alert.kind, alert.token, alert.at)
          this.alertsSent++
        } catch (error) {
          if (error instanceof GrammyError && (error.error_code === 403 || error.error_code === 400)) {
            logger.info({ chatId: chat.chatId, code: error.error_code }, 'chat unreachable, pausing it')
            this.store.upsertChat({ ...chat, paused: true })
          } else {
            logger.warn({ chatId: chat.chatId, err: String(error) }, 'alert send failed')
          }
        }
      })
    }
    return reached
  }

  private alertKeyboard(alert: Alert, chat: ChatSettings): InlineKeyboard {
    const keyboard = new InlineKeyboard()
      .url('📊 DexScreener', dexScreenerUrl(alert.token))
      .url('📈 Chart', chartUrl(alert.token))
      .row()
    const watching = this.store.listWatches(chat.chatId, 'token').some((w) => w.target === alert.token)
    if (!watching) keyboard.text('👁 Watch', `watch:${alert.token}`)
    keyboard.text('🔇 Mute this token', `mute:${alert.token}`)
    return keyboard
  }

  /**
   * The public channel feed: default sensitivity, the shared per-token
   * cooldown, and URL-only buttons (a mute button would make no sense on a
   * broadcast). Delivery failures log and retry on the next alert; the
   * common cause is the bot not yet being a channel admin.
   */
  private deliverToChannel(channelId: string, alert: Alert): void {
    // Wallet and follow-up alerts belong to specific chats, never the feed.
    if (audienceOf(alert) !== null) return
    const channelChat: ChatSettings = { chatId: channelId, ...this.cfg.defaults, paused: false }
    if (!this.eligible(channelChat, alert)) return
    this.enqueue(async () => {
      try {
        await this.bot.api.sendMessage(channelId, renderAlertHtml(alert), {
          parse_mode: 'HTML',
          link_preview_options: { is_disabled: true },
          reply_markup: new InlineKeyboard()
            .url('📊 DexScreener', dexScreenerUrl(alert.token))
            .url('🔍 Scan', explorerTokenUrl(alert.token)),
        })
        this.store.setLastAlert(channelId, alert.kind, alert.token, alert.at)
        this.alertsSent++
      } catch (error) {
        logger.warn(
          { channelId, err: String(error) },
          'channel post failed (is the bot an admin with post permission?)',
        )
      }
    })
  }

  eligible(chat: ChatSettings, alert: Alert): boolean {
    if (chat.paused) return false
    if (!chat.kinds.includes(alert.kind)) return false
    if (this.store.isMuted(chat.chatId, alert.token)) return false

    const last = this.store.lastAlertS(chat.chatId, alert.kind, alert.token)
    if (last !== null && alert.at - last < this.cfg.cooldownMinutes * 60) return false

    // A watched token is one the user explicitly asked about, so the
    // volume thresholds below do not apply to it.
    const watched = this.store.listWatches(chat.chatId, 'token').some((w) => w.target === alert.token)

    if (!chat.newTokens && alert.context.ageS !== null && alert.context.ageS < 3600 && alert.kind !== 'launch') {
      return false
    }

    switch (alert.kind) {
      case 'spike':
        if (watched) return true
        return alert.multiple >= chat.spikeX && alert.volumeUsd >= chat.minVolumeUsd && alert.swaps >= chat.minSwaps
      case 'whale':
        return watched || alert.usd >= chat.whaleMinUsd
      case 'price_move':
        return watched || Math.abs(alert.pct) >= chat.priceMovePct
      case 'liquidity_pull':
        return watched || alert.droppedPct >= chat.rugDropPct
      case 'launch':
      case 'graduation':
      case 'wallet_trade':
      case 'performance':
        return true
    }
  }

  private enqueue(task: () => Promise<void>): void {
    this.queue = this.queue.then(task).then(() => new Promise((r) => setTimeout(r, SEND_SPACING_MS)))
  }

  async start(): Promise<void> {
    await this.bot.api.setMyCommands([
      { command: 'start', description: 'Sensitivity panel' },
      { command: 'alerts', description: 'Pick which alert types you get' },
      { command: 'settings', description: 'Status and everything else' },
      { command: 'watch', description: 'Follow a wallet or token' },
      { command: 'unwatch', description: 'Stop following an address' },
      { command: 'watching', description: 'Your watchlist' },
      { command: 'top', description: "The hour's heaviest tokens" },
      { command: 'scorecard', description: 'How my alerts have performed' },
      { command: 'muted', description: 'Manage muted tokens' },
      { command: 'pause', description: 'Stop alerts, keep settings' },
      { command: 'resume', description: 'Start alerts again' },
      { command: 'help', description: 'What this bot does' },
    ])
    void this.bot.start({
      onStart: (me) => logger.info({ username: me.username }, 'telegram bot online'),
    })
  }

  async stop(): Promise<void> {
    await this.queue.catch(() => undefined)
    await this.bot.stop()
  }
}
