import { useState, ReactNode } from 'react'
import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'
import { ChatMessage } from '../../types'

/**
 * 把 user content 里的两类标签解析成 chip：
 * - <mentioned-element ref dom text>...</mentioned-element> —— Comment 点选的元素引用
 * - <skill-request>技能名</skill-request> —— 发送时选中的技能（只作用于这条消息）
 * 发给 agent 的原文不变（content 字段不动），只是渲染时变好看。
 */
function translate(t: TFunction, key: string, options?: Record<string, unknown>): string {
  return t(key, options)
}

export function renderUserContent(text: string, t: TFunction): ReactNode[] {
  if (!text || (text.indexOf('<mentioned-element') < 0 && text.indexOf('<skill-request>') < 0)) return [text]
  const re = /<mentioned-element\s+([^>]*)>([\s\S]*?)<\/mentioned-element>|<skill-request>([\s\S]*?)<\/skill-request>/g
  const parts: ReactNode[] = []
  let last = 0
  let m: RegExpExecArray | null
  let key = 0
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push(text.slice(last, m.index))
    if (m[3] !== undefined) {
      const skill = m[3].trim()
      parts.push(
        <span
          key={`s-${key++}`}
          className="inline-flex items-center gap-1 mx-0.5 px-1.5 py-0.5 rounded bg-brand-50 dark:bg-brand-900/30 text-brand-600 dark:text-brand-300 text-[11px] align-baseline border border-brand-100 dark:border-brand-800"
          title={translate(t, 'chat.userMessage.skillTitle', { skill })}
        >
          ⚡ {skill}
        </span>
      )
      last = m.index + m[0].length
      continue
    }
    const attrs = m[1]
    const inner = m[2]
    // 解析属性
    const dom = (attrs.match(/dom="([^"]*)"/) || [])[1] || ''
    const ref = (attrs.match(/ref="([^"]*)"/) || [])[1] || ''
    const summary = inner.trim().slice(0, 28) || dom.split('>').pop()?.trim().slice(0, 28) || translate(t, 'chat.userMessage.elementFallback')
    parts.push(
      <span
        key={`m-${key++}`}
        className="inline-flex items-center gap-1 mx-0.5 px-1.5 py-0.5 rounded bg-white/15 text-white text-[11px] align-baseline border border-white/20"
        title={translate(t, 'chat.userMessage.elementTitle', {
          reference: dom || ref,
          text: inner.trim(),
        })}
      >
        💬 {summary}
      </span>
    )
    last = m.index + m[0].length
  }
  if (last < text.length) parts.push(text.slice(last))
  return parts
}

export function EditableUserMessage({
  message,
  displayContent,
  onEditAndResend
}: {
  message: ChatMessage
  displayContent?: string
  onEditAndResend: (messageId: string, newContent: string) => void
}) {
  const { t } = useTranslation()
  const [editing, setEditing] = useState(false)
  const [editContent, setEditContent] = useState(message.content)

  if (!editing) {
    return (
      <div className="group/edit relative">
        <p className="text-[13px] whitespace-pre-wrap leading-relaxed">{renderUserContent(displayContent ?? message.content, t)}</p>
        <button
          onClick={() => { setEditContent(message.content); setEditing(true) }}
          className="absolute -bottom-5 right-0 opacity-0 group-hover/edit:opacity-100 text-[10px] text-white/60 hover:text-white/90 transition-all px-1.5 py-0.5 rounded"
        >
          {t('chat.userMessage.edit')}
        </button>
      </div>
    )
  }

  return (
    <div>
      <textarea
        value={editContent}
        onChange={(e) => setEditContent(e.target.value)}
        className="w-full bg-brand-700 dark:bg-brand-600 text-ink-on-accent text-[13px] rounded-md px-2 py-1.5 resize-none outline-none border border-brand-500 leading-relaxed"
        rows={Math.min(editContent.split('\n').length + 1, 6)}
        autoFocus
      />
      <div className="flex gap-1.5 mt-1.5 justify-end">
        <button onClick={() => setEditing(false)} className="text-[11px] text-white/60 px-2 py-0.5 rounded hover:text-white/90">
          {t('chat.userMessage.cancel')}
        </button>
        <button
          onClick={() => { if (editContent.trim()) { onEditAndResend(message.id, editContent.trim()); setEditing(false) } }}
          className="text-[11px] text-ink-on-accent hover:text-ink-on-accent px-2 py-0.5 rounded bg-brand-500 dark:bg-brand-400 hover:bg-brand-400 dark:hover:bg-brand-300"
        >
          {t('chat.userMessage.resend')}
        </button>
      </div>
    </div>
  )
}
