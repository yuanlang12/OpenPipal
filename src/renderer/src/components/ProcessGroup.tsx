/**
 * ProcessGroup — Codex 风的"过程折叠"组件
 *
 * 一个 turn 的所有过程性消息(thinking / tool / search / code)折叠成单行:
 *   - 进行中:"处理中…"(shimmer)+ 默认展开,实时显示每一步
 *   - 完成后:"已处理 1m 30s ›" + 默认折叠,只看最终输出
 *   - 用户手动点开/收起后,尊重用户选择(不再自动切换)
 */
import { useState, useEffect, useRef, memo } from 'react'
import { ChevronRight, FileCode, BookOpen } from 'lucide-react'
import { ChatMessage } from '../types'
import { MessageBubble } from './MessageBubble'
import { getMessageKind } from '../chat/messages'
import { toolOngoing } from '../chat/toolPhrases'
import { buildProcessRenderItems } from '../chat/processRender'
import { FileDisplayInfo } from '../chat/fileDisplay'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'

// 折叠行按钮与旋转 chevron——ProcessGroup 主行 / FileEditGroup 共用(色档差异由调用方追加类)
const toggleRowCls = 'flex items-center gap-1.5 pl-1 text-chat-meta transition-colors'

export function formatProcessDuration(ms: number, locale: string, t: TFunction): string {
  const totalSeconds = Math.round(Math.max(0, ms) / 1000)
  const formatter = new Intl.NumberFormat(locale)
  if (totalSeconds < 60) {
    return t('chat.process.duration.seconds', { value: formatter.format(totalSeconds) })
  }
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return seconds > 0
    ? t('chat.process.duration.minutesSeconds', {
        minutes: formatter.format(minutes),
        seconds: formatter.format(seconds),
      })
    : t('chat.process.duration.minutes', { value: formatter.format(minutes) })
}

function ToggleChevron({ open }: { open: boolean }) {
  return <ChevronRight className={`w-3 h-3 transition-transform duration-200 ${open ? 'rotate-90' : ''}`} />
}

/** 连续同文件 edit/write 的聚合行：文件芯片 ×N，点开逐次查看（对标官方文件芯片聚合） */
function FileEditGroup({ path, items, roleIcon }: { path: string; items: ChatMessage[]; roleIcon?: string }) {
  const [open, setOpen] = useState(false)
  const base = path.split('/').pop() || path
  return (
    <div data-testid="file-edit-group">
      <button onClick={() => setOpen(v => !v)} className={`${toggleRowCls} max-w-full text-ink-secondary hover:text-ink-primary`}>
        <ToggleChevron open={open} />
        <FileCode className="w-3 h-3 shrink-0" />
        <span className="font-medium min-w-0 truncate">{base}</span>
        <span className="text-ink-tertiary shrink-0">×{items.length}</span>
      </button>
      {open && (
        <div className="mt-1 space-y-1 pl-4">
          {items.map(m => <MessageBubble key={m.id} message={m} roleIcon={roleIcon} />)}
        </div>
      )}
    </div>
  )
}

/** 同一份长期档案的多次查阅聚合成一行——老师关心"它翻了我的教学风格"，不是翻了哪几个文件名 */
function ArchiveReadGroup({
  info,
  items,
  roleIcon
}: {
  info: FileDisplayInfo
  items: ChatMessage[]
  roleIcon?: string
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const isSystem = info.scope === 'role-system'
  return (
    <div data-testid="archive-read-group">
      <button onClick={() => setOpen(v => !v)} className={`${toggleRowCls} max-w-full text-emerald-700 dark:text-emerald-300 hover:text-emerald-800 dark:hover:text-emerald-200`}>
        <ToggleChevron open={open} />
        <BookOpen className="w-3 h-3 shrink-0" />
        <span className="font-medium min-w-0 truncate">
          {isSystem
            ? t('chat.process.teachingStyle', { groupName: info.groupName })
            : t('chat.process.memory')}
        </span>
        <span className="text-ink-tertiary shrink-0">{t('chat.process.archiveCount', { count: items.length })}</span>
      </button>
      {open && (
        <div className="mt-1 space-y-1 pl-4">
          {items.map(m => <MessageBubble key={m.id} message={m} roleIcon={roleIcon} />)}
        </div>
      )}
    </div>
  )
}

interface ProcessGroupProps {
  messages: ChatMessage[]
  /** 本 turn 是否正在执行(streaming + 最后一个 turn) */
  isActive: boolean
  roleIcon?: string
  /** 整轮起点(用户消息时间戳)— 用于算真实耗时 */
  turnStartTs?: number
  /** 整轮终点(最终回答时间戳)— 用于算真实耗时 */
  turnEndTs?: number
}

function ProcessGroupComponent({ messages, isActive, roleIcon, turnStartTs, turnEndTs }: ProcessGroupProps) {
  const { t, i18n } = useTranslation()
  // 进行中默认展开;完成后默认折叠
  const [expanded, setExpanded] = useState(isActive)
  const userToggled = useRef(false)

  // isActive 变化时(执行完成 active:true→false),若用户没手动操作过则自动折叠
  useEffect(() => {
    if (!userToggled.current) setExpanded(isActive)
  }, [isActive])

  if (messages.length === 0) return null

  // 真实耗时优先用整轮(用户发送→最终回答);回落到过程消息内部首末
  const procStart = messages[0]?.timestamp ?? 0
  const procEnd = messages[messages.length - 1]?.timestamp ?? procStart
  const startTs = turnStartTs ?? procStart
  const endTs = turnEndTs ?? procEnd
  const durationMs = Math.max(0, endTs - startTs)
  const stepCount = messages.length
  const toolCount = messages.filter(m => getMessageKind(m) === 'tool').length

  const handleToggle = () => {
    userToggled.current = true
    setExpanded(v => !v)
  }

  // <1s 不显示 "0s"(避免误以为消息丢失);带步数/工具数提示有内容可展开
  const stepLabel = t('chat.process.stepCount', { count: stepCount })
  const toolSuffix = toolCount > 0 ? ` · ${t('chat.process.toolCount', { count: toolCount })}` : ''
  const label = durationMs >= 1000
    ? t('chat.process.completedWithDuration', {
        duration: formatProcessDuration(durationMs, i18n.resolvedLanguage || i18n.language, t),
        stepLabel,
        toolSuffix,
      })
    : t('chat.process.completed', { stepLabel, toolSuffix })

  // 进行中显示语义化活动短语(末条是尚无结果的工具锚点 → "编辑文件中...")而非恒定"处理中…"
  const lastMsg = messages[messages.length - 1]
  const activeLabel =
    lastMsg && getMessageKind(lastMsg) === 'tool' && lastMsg.toolName && !lastMsg.content
      ? toolOngoing(lastMsg.toolName, t)
      : t('chat.process.processing')

  return (
    <div className="mb-msg" data-testid="process-group">
      <button
        onClick={handleToggle}
        className={`${toggleRowCls} text-ink-tertiary hover:text-ink-secondary`}
        data-testid="process-group-toggle"
      >
        <ToggleChevron open={expanded} />
        {isActive ? (
          <span className="sw-loading-shimmer">{activeLabel}</span>
        ) : (
          <span>{label}</span>
        )}
      </button>

      {expanded && (
        <div className="mt-1 animate-fade-in space-y-1">
          {buildProcessRenderItems(messages).map(item => {
            // 连续同文件 edit/write ≥2 次 → 聚合成"文件 ×N"芯片行
            if (item.kind === 'file-group' && item.items.length > 1) {
              return <FileEditGroup key={item.items[0].id} path={item.path} items={item.items} roleIcon={roleIcon} />
            }
            // 同一份长期档案翻了多份 → 一行"教学风格 · 小学语文 · 3 份"
            if (item.kind === 'archive-group' && item.items.length > 1) {
              return <ArchiveReadGroup key={item.items[0].id} info={item.info} items={item.items} roleIcon={roleIcon} />
            }
            const m = item.kind === 'single' ? item.m : item.items[0]
            // thinking 在组内已展开,不再套第二层折叠 —— 直接平铺为暗色推理文本,
            // 跟官方 reasoning 一致;tool/search/code 保留各自单层卡片(有长输出值得折叠)。
            return getMessageKind(m) === 'thinking' ? (
              <div
                key={m.id}
                data-testid="process-thinking-flat"
                className="pl-3 border-l border-border sw-chat-reasoning text-ink-tertiary whitespace-pre-wrap"
              >
                {m.thinkingContent}
              </div>
            ) : (
              <MessageBubble
                key={m.id}
                message={m}
                roleIcon={roleIcon}
                isLastStreaming={isActive && m.id === lastMsg?.id}
              />
            )
          })}
        </div>
      )}
    </div>
  )
}

/**
 * 已完成 turn 的过程组内容不会再变,但活跃 turn 的每个流事件都会让 ChatPanel 重渲染、
 * groupTurns 重建所有 messages 子数组——逐元素引用比较(chatStore 更新保留未变消息对象
 * 的引用)让历史过程组整组跳过,重渲染成本不再随会话长度线性增长。对齐 MessageBubble
 * 已有的 memo + 自定义比较器模式。
 */
function processGroupPropsEqual(prev: ProcessGroupProps, next: ProcessGroupProps): boolean {
  if (
    prev.isActive !== next.isActive ||
    prev.roleIcon !== next.roleIcon ||
    prev.turnStartTs !== next.turnStartTs ||
    prev.turnEndTs !== next.turnEndTs
  ) return false
  if (prev.messages === next.messages) return true
  if (prev.messages.length !== next.messages.length) return false
  for (let i = 0; i < prev.messages.length; i++) {
    if (prev.messages[i] !== next.messages[i]) return false
  }
  return true
}

export const ProcessGroup = memo(ProcessGroupComponent, processGroupPropsEqual)
