import { useEffect, RefObject, MutableRefObject } from 'react'
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
  // 模型还没开口的那段等待由分割线的「连接模型…」承担,这里只管**步骤之间**的空档
  const modelResponded = useChatStore((s) => !!s.modelRespondedConvIds[s.activeConversationId || ''])
  const roleIcon = useAppStore((s) => s.currentRole?.icon)
  const text = useLiveStreamStore((s) => s.text)
  const toolStatus = useLiveStreamStore((s) => s.toolStatus)
  const toolStreamingTitle = useLiveStreamStore((s) => s.toolStreamingTitle)
  const toolStreamingPath = useLiveStreamStore((s) => s.toolStreamingPath)
  const toolProgressChars = useLiveStreamStore((s) => s.toolProgressChars)

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

      {/* 步骤之间的空档标记 —— 上一步做完了、下一步还没吐出第一个字节的那几秒。
          没有它,台面最后一行是一张做完的工具卡,看上去就像执行中断了(用户实锤 2026-08-18)。
          刻意**不带边框、不带底色**:上一版是个方框气泡,读起来像一个独立控件浮在流里;
          现在它就是过程清单末尾又长出来的一行,和上面的元信息同一号字。
          两个门:有正文在流 / 有工具在跑 —— 任一为真都让位(那时台面已经在动了)。
          曾经还有第三个门 isThinking("过程栏里已经写着思考中,别说两遍"),已经去掉:
          那行字只在过程组**展开**时才存在,用户一旦手动收起,它就成了一个看不见的让位理由,
          于是长思考期间台面上除了分割线的秒数什么都没有 —— 正是删掉方框气泡后要补的那个洞。 */}
      {modelResponded && !text && !toolStatus && (
        <div className="flex items-center gap-2 mb-msg text-chat-meta text-ink-tertiary animate-fade-in">
          <div className="flex gap-1">
            <div className="w-1 h-1 bg-success rounded-full animate-pulse-soft" />
            <div className="w-1 h-1 bg-success rounded-full animate-pulse-soft" style={{ animationDelay: '0.2s' }} />
            <div className="w-1 h-1 bg-success rounded-full animate-pulse-soft" style={{ animationDelay: '0.4s' }} />
          </div>
          <span className="op-shimmer-text">{t('chat.process.working')}</span>
        </div>
      )}
    </>
  )
}
