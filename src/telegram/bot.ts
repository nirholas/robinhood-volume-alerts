import { Bot, GrammyError, InlineKeyboard } from 'grammy'
import type { Config } from '../config.js'
import type { ChatSettings, Store } from '../db.js'
import type { SpikeAlert } from '../engine/detector.js'
import { logger } from '../logger.js'
import { dexScreenerUrl, escapeHtml, explorerTokenUrl, renderAlertHtml } from './format.js'
import { newTokensLabel, spikeLabel, step, SPIKE_STEPS, swapsLabel, SWAPS_STEPS, volumeLabel, VOLUME_STEPS } from './settings.js'

const SENSITIVITY_TEXT = [
  '🎚 <b>Sensitivity</b>',
  '',
  'How big a jump has to be before it reaches you. Tap a value to step it up; it wraps around at the top.',
  '',
  '<blockquote><b>Spike</b>: how many times its own normal minute the token must trade. 3× is loose, 10× is rare.',
  '<b>Volume</b>: ignore anything smaller than this in the spiking minute. The floor that keeps dust out.',
  '<b>Swaps</b>: the minimum number of trades in that minute, so one whale print alone does not page you.',
  '<b>New tokens</b>: whether coins younger than an hour (thin history, wild multiples) may alert at all.</blockquote>',
].join('\n')

const HELP_TEXT = [
  '<b>Robinhood Volume Alerts</b>',
  '',
  'I watch every DEX trade on Robinhood Chain, learn each token\'s normal per-minute volume, and message you when a token suddenly trades a multiple of it.',
  '',
  '/settings: sensitivity panel and status',
  '/pause: stop alerts, keep settings',
  '/resume: start alerts again',
  '/muted: tokens you muted, with unmute buttons',
  '/help: this message',
  '',
  'Every alert shows the spike multiple, dollar volume, price moves (1m/5m/1h), swap counts, market cap, liquidity, holders, and the contract address. Mute any token straight from its alert.',
].join('\n')

/** Delay between outgoing alert messages, well under Telegram's global limit. */
const SEND_SPACING_MS = 50

export class TelegramAlertBot {
  readonly bot: Bot
  private queue: Promise<void> = Promise.resolve()
  alertsSent = 0

  constructor(
    token: string,
    private readonly store: Store,
    private readonly cfg: Config,
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
      .text('‹ Back', 'menu:main')
      .text('✕ Close', 'menu:close')
  }

  private mainText(s: ChatSettings): string {
    return [
      '<b>Robinhood Volume Alerts</b>',
      '',
      s.paused ? '⏸ Alerts are <b>paused</b>.' : '▶️ Alerts are <b>on</b>.',
      `Current sensitivity: ${spikeLabel(s)} · ${volumeLabel(s)} · ${swapsLabel(s)} · ${newTokensLabel(s)}`,
      `Muted tokens: ${this.store.listMutes(s.chatId).length}`,
    ].join('\n')
  }

  private mainKeyboard(s: ChatSettings): InlineKeyboard {
    return new InlineKeyboard()
      .text('🎚 Sensitivity', 'menu:sensitivity')
      .text(s.paused ? '▶️ Resume' : '⏸ Pause', 'toggle:paused')
      .row()
      .text('🔕 Muted tokens', 'menu:muted')
      .text('✕ Close', 'menu:close')
  }

  private mutedPanel(chatId: string): { text: string; keyboard: InlineKeyboard } {
    const mutes = this.store.listMutes(chatId)
    const keyboard = new InlineKeyboard()
    for (const token of mutes.slice(0, 10)) {
      const row = this.store.getToken(token)
      const label = row?.symbol ? `🔊 Unmute ${row.symbol}` : `🔊 ${token.slice(0, 10)}…`
      keyboard.text(label, `unmute:${token}`).row()
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

  // ---- wiring ---------------------------------------------------------------

  private wire(): void {
    this.bot.command('start', async (ctx) => {
      const chatId = String(ctx.chat.id)
      const settings = this.store.getChat(chatId)
      this.store.upsertChat(settings)
      await ctx.reply(SENSITIVITY_TEXT, {
        parse_mode: 'HTML',
        reply_markup: this.sensitivityKeyboard(settings),
        link_preview_options: { is_disabled: true },
      })
    })

    this.bot.command('settings', async (ctx) => {
      const s = this.store.getChat(String(ctx.chat.id))
      await ctx.reply(this.mainText(s), { parse_mode: 'HTML', reply_markup: this.mainKeyboard(s) })
    })

    this.bot.command('pause', async (ctx) => {
      const s = this.store.getChat(String(ctx.chat.id))
      this.store.upsertChat({ ...s, paused: true })
      await ctx.reply('⏸ Alerts paused. /resume brings them back.')
    })

    this.bot.command('resume', async (ctx) => {
      const s = this.store.getChat(String(ctx.chat.id))
      this.store.upsertChat({ ...s, paused: false })
      await ctx.reply('▶️ Alerts resumed.')
    })

    this.bot.command('muted', async (ctx) => {
      const { text, keyboard } = this.mutedPanel(String(ctx.chat.id))
      await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard })
    })

    this.bot.command('help', async (ctx) => {
      await ctx.reply(HELP_TEXT, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } })
    })

    this.bot.on('callback_query:data', async (ctx) => {
      const data = ctx.callbackQuery.data
      const chatId = String(ctx.chat?.id ?? ctx.callbackQuery.from.id)
      const s = this.store.getChat(chatId)

      const editTo = async (text: string, keyboard: InlineKeyboard): Promise<void> => {
        try {
          await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard, link_preview_options: { is_disabled: true } })
        } catch (error) {
          // "message is not modified" is harmless; anything else should log.
          if (!(error instanceof GrammyError && error.description.includes('not modified'))) {
            logger.warn({ err: String(error) }, 'panel edit failed')
          }
        }
      }

      if (data === 'set:spike') {
        const next = { ...s, spikeX: step(SPIKE_STEPS, s.spikeX) }
        this.store.upsertChat(next)
        await editTo(SENSITIVITY_TEXT, this.sensitivityKeyboard(next))
        await ctx.answerCallbackQuery({ text: `Spike threshold: ${next.spikeX}× normal` })
      } else if (data === 'set:vol') {
        const next = { ...s, minVolumeUsd: step(VOLUME_STEPS, s.minVolumeUsd) }
        this.store.upsertChat(next)
        await editTo(SENSITIVITY_TEXT, this.sensitivityKeyboard(next))
        await ctx.answerCallbackQuery({ text: `Volume floor: $${next.minVolumeUsd.toLocaleString('en-US')}` })
      } else if (data === 'set:swaps') {
        const next = { ...s, minSwaps: step(SWAPS_STEPS, s.minSwaps) }
        this.store.upsertChat(next)
        await editTo(SENSITIVITY_TEXT, this.sensitivityKeyboard(next))
        await ctx.answerCallbackQuery({ text: `Swap floor: ${next.minSwaps} per minute` })
      } else if (data === 'set:new') {
        const next = { ...s, newTokens: !s.newTokens }
        this.store.upsertChat(next)
        await editTo(SENSITIVITY_TEXT, this.sensitivityKeyboard(next))
        await ctx.answerCallbackQuery({ text: next.newTokens ? 'New tokens may alert' : 'New tokens muted for the first hour' })
      } else if (data === 'menu:sensitivity') {
        await editTo(SENSITIVITY_TEXT, this.sensitivityKeyboard(s))
        await ctx.answerCallbackQuery()
      } else if (data === 'menu:main') {
        await editTo(this.mainText(s), this.mainKeyboard(s))
        await ctx.answerCallbackQuery()
      } else if (data === 'menu:muted') {
        const { text, keyboard } = this.mutedPanel(chatId)
        await editTo(text, keyboard)
        await ctx.answerCallbackQuery()
      } else if (data === 'menu:close') {
        try {
          await ctx.deleteMessage()
        } catch {
          // Older messages cannot be deleted; clearing the keyboard is enough.
          await ctx.editMessageReplyMarkup().catch(() => undefined)
        }
        await ctx.answerCallbackQuery()
      } else if (data === 'toggle:paused') {
        const next = { ...s, paused: !s.paused }
        this.store.upsertChat(next)
        await editTo(this.mainText(next), this.mainKeyboard(next))
        await ctx.answerCallbackQuery({ text: next.paused ? 'Paused' : 'Resumed' })
      } else if (data.startsWith('mute:')) {
        const token = data.slice(5)
        this.store.mute(chatId, token)
        this.store.upsertChat(s)
        await ctx.answerCallbackQuery({ text: 'Muted. /muted to manage.' })
      } else if (data.startsWith('unmute:')) {
        const token = data.slice(7)
        this.store.unmute(chatId, token)
        const { text, keyboard } = this.mutedPanel(chatId)
        await editTo(text, keyboard)
        await ctx.answerCallbackQuery({ text: 'Unmuted.' })
      } else {
        await ctx.answerCallbackQuery()
      }
    })

    this.bot.catch((err) => logger.error({ err: String(err.error) }, 'telegram update error'))
  }

  // ---- delivery ---------------------------------------------------------------

  /** Fan an alert out to every eligible subscriber. */
  async deliver(alert: SpikeAlert): Promise<void> {
    const chats = this.store.listActiveChats()
    for (const chat of chats) {
      if (!this.eligible(chat, alert)) continue
      this.enqueue(async () => {
        try {
          await this.bot.api.sendMessage(Number(chat.chatId), renderAlertHtml(alert), {
            parse_mode: 'HTML',
            link_preview_options: { is_disabled: true },
            reply_markup: new InlineKeyboard()
              .url('📊 DexScreener', dexScreenerUrl(alert.token))
              .url('🔍 Scan', explorerTokenUrl(alert.token))
              .row()
              .text('🔇 Mute this token', `mute:${alert.token}`),
          })
          this.store.setLastAlert(chat.chatId, alert.token, alert.at)
          this.alertsSent++
        } catch (error) {
          if (error instanceof GrammyError && (error.error_code === 403 || error.error_code === 400)) {
            // Blocked the bot or the chat is gone: stop delivering there.
            logger.info({ chatId: chat.chatId, code: error.error_code }, 'chat unreachable, pausing it')
            this.store.upsertChat({ ...chat, paused: true })
          } else {
            logger.warn({ chatId: chat.chatId, err: String(error) }, 'alert send failed')
          }
        }
      })
    }
  }

  eligible(chat: ChatSettings, alert: SpikeAlert): boolean {
    if (chat.paused) return false
    if (alert.multiple < chat.spikeX) return false
    if (alert.volumeUsd < chat.minVolumeUsd) return false
    if (alert.swaps < chat.minSwaps) return false
    if (!chat.newTokens && alert.ageS !== null && alert.ageS < 3600) return false
    if (this.store.isMuted(chat.chatId, alert.token)) return false
    const last = this.store.lastAlertS(chat.chatId, alert.token)
    if (last !== null && alert.at - last < this.cfg.cooldownMinutes * 60) return false
    return true
  }

  private enqueue(task: () => Promise<void>): void {
    this.queue = this.queue.then(task).then(() => new Promise((r) => setTimeout(r, SEND_SPACING_MS)))
  }

  async start(): Promise<void> {
    await this.bot.api.setMyCommands([
      { command: 'start', description: 'Sensitivity panel' },
      { command: 'settings', description: 'Status, pause, muted tokens' },
      { command: 'pause', description: 'Stop alerts, keep settings' },
      { command: 'resume', description: 'Start alerts again' },
      { command: 'muted', description: 'Manage muted tokens' },
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
