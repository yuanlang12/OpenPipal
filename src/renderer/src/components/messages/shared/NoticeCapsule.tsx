/**
 * NoticeCapsule —— 对话流里"顺手的事"的胶囊：居中、小、不打断主线，长期留在它发生的位置
 * （随会话落盘为 inject-notice 消息，不发给模型、不算对话历史）。
 * 规则（HookNoticeRow）与记忆（MemoryNoticeRow）共用。tone：brand 正常 / warn 出错 / muted 已撤销等。
 */
import type { ReactNode } from 'react'

export type NoticeCapsuleTone = 'brand' | 'warn' | 'muted'

const TONES: Record<NoticeCapsuleTone, string> = {
  brand: 'bg-brand-50/60 dark:bg-brand-900/20 border-brand-100/50 dark:border-brand-800/40 text-brand-600 dark:text-brand-400',
  warn: 'bg-amber-50/70 dark:bg-amber-900/20 border-amber-200/60 dark:border-amber-800/40 text-amber-700 dark:text-amber-400',
  // surface / ink 令牌自带暗色值，不另配 dark: 搭档（配错阶会被 dark-surface-ladder 测试拦下）
  muted: 'bg-surface-50 border-surface-100 text-ink-tertiary'
}

export function NoticeCapsule({
  subtype,
  tone = 'brand',
  icon,
  title,
  attrs,
  children
}: {
  /** data-subtype，与消息的 messageSubtype 一致（hook / memory） */
  subtype: string
  tone?: NoticeCapsuleTone
  icon: ReactNode
  title?: string
  /** 额外的 data-* 属性（测试与状态用） */
  attrs?: Record<string, string>
  children: ReactNode
}) {
  return (
    <div className="flex justify-center my-2 animate-fade-in">
      <div
        className={`flex items-center gap-2 px-3 py-1.5 rounded-full border text-[11px] max-w-[90%] ${TONES[tone]}`}
        data-testid="inject-notice"
        data-subtype={subtype}
        title={title}
        {...attrs}
      >
        <span className="flex flex-shrink-0 opacity-60">{icon}</span>
        {children}
      </div>
    </div>
  )
}
