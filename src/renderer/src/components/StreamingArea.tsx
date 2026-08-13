import { useEffect, useState, RefObject, MutableRefObject } from 'react'
import { useChatStore } from '../stores/chatStore'
import { useLiveStreamStore } from '../stores/liveStreamStore'
import { useAppStore } from '../stores/appStore'
import { StreamingText } from './StreamingText'
import { StreamingInlinePreview } from './StreamingInlinePreview'
import { stripDcSuffix } from '../utils/format'

import { toolOngoing } from '../chat/toolPhrases'
import { useTranslation } from 'react-i18next'

interface StreamingAreaProps {
  scrollRef: RefObject<HTMLDivElement>
  userScrolledUp: MutableRefObject<boolean>
}

/** 等待文案按耗时分级——长等待时固定一句"正在思考"会让人怀疑卡死。
 *  计时锚定整个流式回合(isStreaming),不随 text/toolStatus 抖动重启——否则多工具
 *  交错的长回合里 elapsed 反复归零,永远升不到"深度思考"档(评审实锤)。 */
function useThinkingLabel(streaming: boolean): string {
  const { t } = useTranslation()
  const [elapsed, setElapsed] = useState(0)
  useEffect(() => {
    if (!streaming) {
      setElapsed(0)
      return
    }
    const startedAt = Date.now()
    const timer = setInterval(() => setElapsed(Date.now() - startedAt), 1000)
    return () => clearInterval(timer)
  }, [streaming])
  if (elapsed >= 30000) return t('chat.streaming.deepThinking')
  if (elapsed >= 8000) return t('chat.streaming.thinkingHard')
  return t('chat.streaming.thinking')
}

/**
 * 流式区(隔离叶子)—— 这是整套架构修复的核心:
 * 它是 *唯一* 订阅 liveStreamStore 的组件,所以每个 token 的高频更新只重渲染本组件,
 * 不再牵动 ChatPanel / 消息列表 / groupTurns。流式滚动跟随也从 ChatPanel 迁到这里
 * (依赖 liveStreamStore 字段),让"内容增长→贴底"的 effect 也只在本叶子里跑。
 *
 * 渲染逻辑与样式与原 ChatPanel 末尾的四个分支逐字一致(工具指示 / 流式预览 /
 * 流式文字 / 思考点),保证用户侧零视觉变化。
 */
export function StreamingArea({ scrollRef, userScrolledUp }: StreamingAreaProps) {
  const { t } = useTranslation()
  const isStreaming = useChatStore((s) => s.isStreaming)
  const roleIcon = useAppStore((s) => s.currentRole?.icon)
  const text = useLiveStreamStore((s) => s.text)
  const toolStatus = useLiveStreamStore((s) => s.toolStatus)
  const toolStreamingTitle = useLiveStreamStore((s) => s.toolStreamingTitle)
  const toolStreamingPath = useLiveStreamStore((s) => s.toolStreamingPath)
  const toolProgressChars = useLiveStreamStore((s) => s.toolProgressChars)
  const thinkingLabel = useThinkingLabel(isStreaming)

  // 流式滚动跟随:内容增长且用户没有上滑时保持贴底。
  // 原本在 ChatPanel(依赖 streamingContent/toolStatus/... 整页随 token 重渲染),
  // 现在只随本叶子重渲染,不再拖动消息列表。
  useEffect(() => {
    if (!userScrolledUp.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [text, toolStatus, toolProgressChars, toolStreamingTitle, scrollRef, userScrolledUp])

  if (!isStreaming) return null

  return (
    <>
      {/* Tool execution indicator */}
      {toolStatus && (
        <div className="flex justify-start mb-3 animate-fade-in">
          <div className="flex items-center gap-2 min-w-0 rounded-lg px-3 py-2 bg-brand-50/80 dark:bg-brand-900/30 border border-brand-200/40 dark:border-brand-700 text-brand-700 dark:text-brand-300 text-xs">
            <div className="w-3.5 h-3.5 border-2 border-brand-300 border-t-brand-600 rounded-full animate-spin shrink-0" />
            <span className="font-medium min-w-0 break-words">
              {stripDcSuffix(toolStreamingTitle || '') ||
                (toolStreamingPath
                  ? `${toolOngoing(toolStatus, t)} · ${toolStreamingPath.split('/').pop()}`
                  : toolOngoing(toolStatus, t))}
            </span>
          </div>
        </div>
      )}

      {/* Streaming visualizer inline preview — 仅在流式生成阶段显示，生成完成后彻底消失 */}
      <StreamingInlinePreview hasAvatar={!!roleIcon} />

      {/* Streaming text — 对齐完成态:无 avatar、无气泡、纯文本填满列(消除流式→完成的宽度/样式跳变) */}
      {text && !toolStatus && (
        <div className="flex justify-start mb-msg animate-fade-in">
          <div className="w-full text-ink-primary">
            <StreamingText content={text} />
          </div>
        </div>
      )}

      {/* Thinking indicator (仅在无任何内容时显示) */}
      {!text && !toolStatus && (
        <div className="flex justify-start mb-3 animate-fade-in">
          {/* 「正在思考」是 live 状态:三点用 sage(agent 活动,不是动作色),
              文案走 .op-shimmer-text —— 一道光从标签里穿过去。 */}
          <div className="rounded-lg px-3.5 py-2.5 bg-surface-0 dark:bg-surface-50 border border-surface-100 flex items-center gap-2">
            <div className="flex gap-1">
              <div className="w-1.5 h-1.5 bg-success rounded-full animate-pulse-soft" />
              <div className="w-1.5 h-1.5 bg-success rounded-full animate-pulse-soft" style={{ animationDelay: '0.2s' }} />
              <div className="w-1.5 h-1.5 bg-success rounded-full animate-pulse-soft" style={{ animationDelay: '0.4s' }} />
            </div>
            <span className="sw-chat-reasoning op-shimmer-text">{thinkingLabel}</span>
          </div>
        </div>
      )}
    </>
  )
}
