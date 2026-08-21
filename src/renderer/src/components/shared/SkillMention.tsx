import { useCallback, useEffect, useMemo, useRef, useState, ChangeEvent, KeyboardEvent, ReactNode, RefObject } from 'react'
import { Zap, Target } from 'lucide-react'
import { findSkillMentions, isTriggerBoundary, SKILL_TRIGGER } from '../../chat/skillRequest'

export interface SkillInfo { name: string; description: string; enabled?: boolean }

/**
 * 输入框 `/` 快捷指令面板 + 内联混排（InputBar / WelcomePage 共用）。
 *
 * - 打 `/`（行首或空格后）就展开面板，选中即在光标处插入 `/名字 ` 纯文本，与正文自然混排
 * - 面板里两类东西：内置命令（只在行首给，如 `/goal`）和技能；技能发送时由
 *   chat/skillRequest.expandSkillMentions 换成 <skill-request> 标签，内置命令由宿主自己拦
 * - 视觉上 token 由「镜像层」着色：textarea 文字透明、背后叠一个同排版的 div 画淡色底
 *   （只在文本确实含已知 token 时才启用，避免影响普通输入的选区/可读性）
 */

/** 面板里的内置命令（`/goal` 这类不进模型、由宿主拦截的） */
export interface CommandInfo { name: string; description: string }

/** 从光标往回找当前正在补全的 `/` 片段；遇空白或超长即判定不在补全态 */
function activeMentionAt(text: string, caret: number): { start: number; query: string } | null {
  for (let i = caret - 1; i >= 0 && caret - i <= 40; i--) {
    const ch = text[i]
    if (ch === SKILL_TRIGGER) {
      return isTriggerBoundary(text, i) ? { start: i, query: text.slice(i + 1, caret) } : null
    }
    if (/\s/.test(ch)) return null
  }
  return null
}

/** 名称前缀 > 名称包含 > 描述包含 > 名称子序列 */
function filterSkills<T extends SkillInfo>(skills: T[], query: string): T[] {
  if (!query) return skills
  const q = query.toLowerCase()
  const scored: Array<[number, T]> = []
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

/** 面板里的一行：技能或内置命令 */
type PanelItem = SkillInfo & { kind: 'skill' | 'command' }

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
  /** 外部入口：在光标处插入 token */
  insertSkill: (name: string) => void
}

export function useSkillMentions(opts: {
  skills: SkillInfo[]
  /** 内置命令（`/goal` 这类）。只在 `/` 位于输入开头时出现——它们改的是会话状态，不能塞在句中 */
  commands?: CommandInfo[]
  value: string
  onChange: (next: string) => void
  textareaRef: RefObject<HTMLTextAreaElement | null>
  /** 镜像层要复刻的排版 class（padding / 字号 / 行高 / 字色），与 textarea 保持一致 */
  mirrorClassName: string
}): SkillMentionsApi {
  const { skills, commands, value, onChange, textareaRef, mirrorClassName } = opts
  const [caret, setCaret] = useState(0)
  const [focused, setFocused] = useState(false)
  const [dismissedAt, setDismissedAt] = useState<number | null>(null)
  const [activeIndex, setActiveIndex] = useState(0)
  const composingRef = useRef(false)
  const caretRef = useRef<number | null>(null)
  const mirrorRef = useRef<HTMLDivElement>(null)

  const names = useMemo(() => skills.map(s => s.name), [skills])

  const active = composingRef.current || !focused ? null : activeMentionAt(value, caret)
  const items = useMemo<PanelItem[]>(() => {
    if (!active) return []
    // 内置命令只在输入开头给：它们是"这条消息就是一条命令"，塞在句中没有意义
    const cmds: PanelItem[] = active.start === 0
      ? (commands || []).map(c => ({ ...c, kind: 'command' as const }))
      : []
    const list: PanelItem[] = [...cmds, ...skills.map(s => ({ ...s, kind: 'skill' as const }))]
    return filterSkills(list, active.query)
  }, [active?.start, active?.query, skills, commands]) // eslint-disable-line react-hooks/exhaustive-deps
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
    // 前面紧挨着字就补个空格：`/` 只有在行首或空白后才算触发符，贴着字插进去等于插了段废文本
    const lead = isTriggerBoundary(cur, from) ? '' : ' '
    const sep = cur[pos] === ' ' ? '' : ' '
    const next = `${cur.slice(0, from)}${lead}${SKILL_TRIGGER}${name}${sep}${cur.slice(pos)}`
    const nextCaret = from + lead.length + name.length + 1 + sep.length
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

  // 着色名单里带上内置命令：用户看不出"这条为什么不高亮"的道理，`/goal` 也该是个 token 模样
  const highlightNames = useMemo(
    () => (commands?.length ? [...names, ...commands.map(c => c.name)] : names),
    [names, commands]
  )
  const mentions = useMemo(() => findSkillMentions(value, highlightNames), [value, highlightNames])

  const popup = open ? (
    // 宽度跟输入框对齐（与目录条同一档内缩），不是一小片浮窗：技能名和说明都长，
    // 挤在 288px 里每行都要截断，用户等于在一列省略号里挑东西
    <div
      data-testid="skill-mention-popup"
      className="absolute bottom-full left-3 right-3 mb-1.5 max-h-80 overflow-y-auto z-50 op-menu py-1.5 animate-fade-in"
    >
      {items.map((s, i) => (
        <button
          key={`${s.kind}:${s.name}`}
          data-testid="skill-mention-item"
          data-kind={s.kind}
          onMouseDown={e => { e.preventDefault(); insertSkill(s.name) }}
          onMouseEnter={() => setActiveIndex(i)}
          className={`w-full text-left px-3.5 py-2.5 text-[13px] flex items-center gap-2.5 transition-colors ${
            i === activeIndex
              ? 'bg-brand-50 dark:bg-brand-900/20 text-brand-600 dark:text-brand-300'
              : 'text-surface-600'
          }`}
        >
          {s.kind === 'command'
            ? <Target className="w-3.5 h-3.5 shrink-0" />
            : <Zap className="w-3.5 h-3.5 shrink-0" />}
          <span className="shrink-0 max-w-[55%] truncate font-medium">{SKILL_TRIGGER}{s.name}</span>
          {s.description && <span className="truncate text-[11px] text-surface-400">{s.description}</span>}
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
