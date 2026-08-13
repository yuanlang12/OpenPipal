import type { TFunction } from 'i18next'
import type { ChatMessage } from '../types'
import { parseModelStallNotice } from '../../../shared/runtime-notice'

const QUESTIONS_ANSWERED = '[Questions answered]'
const ERROR_PREFIX = '[Error]'
const QUESTIONS_ANSWERED_TITLE = /^\[Questions answered\] \u95ee\u9898\u5361「([^\n]*)」(?=\n|$)/

/**
 * Convert only OpenPipal-owned transcript sentinels into localized display
 * chrome. The stored message and every dynamic title/error byte remain
 * unchanged so replay and model context stay protocol-compatible.
 */
export function formatMessageContentForDisplay(
  message: Pick<ChatMessage, 'role' | 'content' | 'messageKind' | 'messageSubtype' | 'syntheticErrorOffset'>,
  t: TFunction
): string {
  let display = message.content
  if (message.role === 'user') {
    const titled = QUESTIONS_ANSWERED_TITLE.exec(display)
    if (titled) {
      display = `${t('chat.message.questionsAnsweredWithTitle', { title: titled[1] })}${display.slice(titled[0].length)}`
    } else if (display === QUESTIONS_ANSWERED || display.startsWith(`${QUESTIONS_ANSWERED}\n`)) {
      display = `${t('chat.message.questionsAnswered')}${display.slice(QUESTIONS_ANSWERED.length)}`
    }
  }
  if (
    message.role === 'assistant' &&
    message.messageKind === 'incomplete' &&
    message.messageSubtype === 'stream-error' &&
    Number.isInteger(message.syntheticErrorOffset) &&
    (message.syntheticErrorOffset as number) >= 0 &&
    (message.syntheticErrorOffset as number) + ERROR_PREFIX.length <= display.length &&
    display.slice(message.syntheticErrorOffset).startsWith(ERROR_PREFIX)
  ) {
    const offset = message.syntheticErrorOffset as number
    const rawBody = display.slice(offset + ERROR_PREFIX.length)
    // Runtime 自有的哨兵在这里翻译；网关原文（外部内容）仍逐字保留
    const stallSeconds = parseModelStallNotice(rawBody)
    const body = stallSeconds === null
      ? rawBody
      : ` ${t('runtimeChrome.errors.modelStall', { seconds: stallSeconds })}`
    display = `${display.slice(0, offset)}[${t('chat.message.errorPrefix')}]${body}`
  }
  return display
}

export function injectNoticeContentForDisplay(message: Pick<ChatMessage, 'content' | 'messageSubtype'>, t: TFunction): string {
  if (message.messageSubtype === 'steer') return t('chat.message.injectSteered')
  if (message.messageSubtype === 'queue') return t('chat.message.injectQueued')
  if (message.content === '↳ 已引导对话') return t('chat.message.injectSteered')
  if (message.content === '↳ 已加入跟单队列') return t('chat.message.injectQueued')
  return message.content
}
