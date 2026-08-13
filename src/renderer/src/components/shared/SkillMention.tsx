import { useCallback, useEffect, useMemo, useRef, useState, ChangeEvent, KeyboardEvent, ReactNode, RefObject } from 'react'
import { Zap } from 'lucide-react'
import { findSkillMentions } from '../../chat/skillRequest'

export interface SkillInfo { name: string; description: string; enabled?: boolean }

/**
 * 输入框 @ 触发技能 + 内联混排（InputBar / WelcomePage 共用）。
 *
 * - 选中即在光标处插入 `@技能名 ` 纯文本，与正文自然混排（不再有输入框上方的 chip）
 * - 视觉上 @token 由「镜像层」着色：textarea 文字透明、背后叠一个同排版的 div 画淡色底
 *   （只在文本确实含已知技能 token 时才启用，避免影响普通输入的选区/可读性）
 * - 发送时由 chat/skillRequest.expandSkillMentions 把 token 换成 <skill-request> 标签
 */

/** 从光标往回找当前正在补全的 @ 片段；遇空白或超长即判定不在补全态 */
function activeMentionAt(text: string, caret: number): { start: number; query: string } | null {
  for (let i = caret - 1; i >= 0 && caret - i <= 40; i--) {
    const ch = text[i]
    if (ch === '@') return { start: i, query: text.slice(i + 1, caret) }
    if (/\s/.test(ch)) return null
  }
  return null
}

/** 名称前缀 > 名称包含 > 描述包含 > 名称子序列 */
function filterSkills(skills: SkillInfo[], query: string): SkillInfo[] {
  if (!query) return skills
  const q = query.toLowerCase()
  const scored: Array<[number, SkillInfo]> = []
  for (const s of skills) {
    const name = s.name.toLowerCase()
    const desc = (s.description || '').toLowerCase()
    if (name.startsWith(q)) scored.push([0, s])
    else if (name.includes(q)) scored.push([1, s])
    else if (desc.includes(q)) scored.push([2, s])
    else if (isSubsequence(name, q)) scored.push([3, s])
  }
  return scored.sort((a, b) => a[0] - b[0]).map(([, s]) => s)
}

function isSubsequence(text: string, q: string): boolean {
  let i = 0
  for (const ch of text) if (ch === q[i] && ++i === q.length) return true
  return false
}

export interface SkillMentionsApi {
  /** 弹层节点（无则 null）——宿主放进 textarea 的 relative 容器里 */
  popup: ReactNode
  /** 镜像层节点（无 token 时 null）——同上，必须与 textarea 同一 relative 容器 */
  mirror: ReactNode
  /** textarea 需要叠加的 class（镜像激活时让文字透明、保住光标与选区可见） */
  textareaClass: string
  textareaStyle: { color: string } | undefined
  /** 宿主 onChange 里调用 */
  handleChange: (e: ChangeEvent<HTMLTextAreaElement>) => void
  /** 宿主 onKeyDown 最前面调用；返回 true 表示弹层吃掉了这个按键 */
  handleKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => boolean
  handleSelect: () => void
  handleScroll: () => void
  handleBlur: () => void
  handleFocus: () => void
  handleCompositionStart: () => void
  handleCompositionEnd: (e: { currentTarget: HTMLTextAreaElement }) => void
  /** 「+ → 添加技能」等外部入口：在光标处插入 token */
  insertSkill: (name: string) => void
}

export function useSkillMentions(opts: {
  skills: SkillInfo[]
  value: string
  onChange: (next: string) => void
  textareaRef: RefObject<HTMLTextAreaElement | null>
  /** 镜像层要复刻的排版 class（padding / 字号 / 行高 / 字色），与 textarea 保持一致 */
  mirrorClassName: string
}): SkillMentionsApi {
  const { skills, value, onChange, textareaRef, mirrorClassName } = opts
  const [caret, setCaret] = useState(0)
  const [focused, setFocused] = useState(false)
  const [dismissedAt, setDismissedAt] = useState<number | null>(null)
  const [activeIndex, setActiveIndex] = useState(0)
  const composingRef = useRef(false)
  const caretRef = useRef<number | null>(null)
  const mirrorRef = useRef<HTMLDivElement>(null)

  const names = useMemo(() => skills.map(s => s.name), [skills])

  const active = composingRef.current || !focused ? null : activeMentionAt(value, caret)
  const items = useMemo(
    () => (active ? filterSkills(skills, active.query) : []),
    [active?.start, active?.query, skills] // eslint-disable-line react-hooks/exhaustive-deps
  )
  const open = !!active && dismissedAt !== active.start && items.length > 0

  // @ 位置或过滤词一变，高亮回到第一项
  useEffect(() => { setActiveIndex(0) }, [active?.start, active?.query])

  const syncCaret = useCallback(() => {
    const el = textareaRef.current
    if (!el) return
    const pos = el.selectionStart ?? el.value.length
    caretRef.current = pos
    setCaret(pos)
  }, [textareaRef])

  const syncScroll = useCallback(() => {
    const el = textareaRef.current
    const m = mirrorRef.current
    if (el && m) { m.scrollTop = el.scrollTop; m.scrollLeft = el.scrollLeft }
  }, [textareaRef])

  useEffect(() => { syncScroll() }, [value, syncScroll])

  const handleChange = useCallback((e: ChangeEvent<HTMLTextAreaElement>) => {
    const pos = e.target.selectionStart ?? e.target.value.length
    caretRef.current = pos
    setCaret(pos)
    onChange(e.target.value)
  }, [onChange])

  const insertSkill = useCallback((name: string) => {
    const el = textareaRef.current
    const cur = el ? el.value : value
    const isFocused = !!el && document.activeElement === el
    const pos = isFocused ? (el!.selectionStart ?? cur.length) : (caretRef.current ?? cur.length)
    const a = activeMentionAt(cur, pos)
    const from = a ? a.start : pos
    const sep = cur[pos] === ' ' ? '' : ' '
    const next = `${cur.slice(0, from)}@${name}${sep}${cur.slice(pos)}`
    const nextCaret = from + name.length + 1 + sep.length
    setDismissedAt(null)
    caretRef.current = nextCaret
    setCaret(nextCaret)
    onChange(next)
    requestAnimationFrame(() => {
      const t = textareaRef.current
      if (!t) return
      t.focus()
      // 这一帧内用户已经继续打字的话，别把光标拽回去（否则后续字符会插错位置）
      if (t.value === next) t.setSelectionRange(nextCaret, nextCaret)
    })
  }, [onChange, textareaRef, value])

  const handleKeyDown = useCallback((e: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!open || e.nativeEvent.isComposing) return false
    if (e.key === 'ArrowDown') { e.preventDefault(); setActiveIndex(i => (i + 1) % items.length); return true }
    if (e.key === 'ArrowUp') { e.preventDefault(); setActiveIndex(i => (i - 1 + items.length) % items.length); return true }
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault()
      insertSkill(items[Math.min(activeIndex, items.length - 1)].name)
      return true
    }
    if (e.key === 'Escape') { e.preventDefault(); setDismissedAt(active!.start); return true }
    return false
  }, [open, items, activeIndex, active?.start, insertSkill])

  const mentions = useMemo(() => findSkillMentions(value, names), [value, names])

  const popup = open ? (
    <div
      data-testid="skill-mention-popup"
      className="absolute bottom-full left-0 mb-1 w-72 max-h-56 overflow-y-auto z-50 op-menu py-1 animate-fade-in"
    >
      {items.map((s, i) => (
        <button
          key={s.name}
          data-testid="skill-mention-item"
          onMouseDown={e => { e.preventDefault(); insertSkill(s.name) }}
          onMouseEnter={() => setActiveIndex(i)}
          className={`w-full text-left px-3 py-1.5 text-[12px] flex items-center gap-2 transition-colors ${
            i === activeIndex
              ? 'bg-brand-50 dark:bg-brand-900/20 text-brand-600 dark:text-brand-300'
              : 'text-surface-600'
          }`}
        >
          <Zap className="w-3 h-3 shrink-0" />
          <span className="shrink-0 max-w-[40%] truncate">{s.name}</span>
          {s.description && <span className="truncate text-[10px] text-surface-400">{s.description}</span>}
        </button>
      ))}
    </div>
  ) : null

  const mirror = mentions.length > 0 ? (
    <div
      ref={mirrorRef}
      aria-hidden
      data-testid="skill-mention-mirror"
      className={`absolute inset-0 overflow-hidden whitespace-pre-wrap break-words pointer-events-none ${mirrorClassName}`}
    >
      {(() => {
        const parts: ReactNode[] = []
        let last = 0
        mentions.forEach((m, i) => {
          if (m.start > last) parts.push(value.slice(last, m.start))
          parts.push(
            <span key={i} className="rounded bg-brand-100 dark:bg-brand-900/40 text-brand-700 dark:text-brand-300">
              {value.slice(m.start, m.end)}
            </span>
          )
          last = m.end
        })
        parts.push(value.slice(last))
        return parts
      })()}
      {'​'}
    </div>
  ) : null

  return {
    popup,
    mirror,
    textareaClass: mentions.length > 0
      ? 'caret-surface-800 dark:caret-surface-50 selection:bg-brand-300/40 dark:selection:bg-brand-500/40'
      : '',
    textareaStyle: mentions.length > 0 ? { color: 'transparent' } : undefined,
    handleChange,
    handleKeyDown,
    handleSelect: syncCaret,
    handleScroll: syncScroll,
    handleBlur: () => setFocused(false),
    handleFocus: () => { setFocused(true); syncCaret() },
    handleCompositionStart: () => { composingRef.current = true },
    handleCompositionEnd: (e) => {
      composingRef.current = false
      const pos = e.currentTarget.selectionStart ?? e.currentTarget.value.length
      caretRef.current = pos
      setCaret(pos)
    },
    insertSkill
  }
}
