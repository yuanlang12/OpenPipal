import { useState, useRef, useEffect } from 'react'
import { Check, X, Wrench, ChevronDown, Eye } from 'lucide-react'
import { ChatMessage } from '../../types'
import { useArtifactStore } from '../../stores/artifactStore'
import { useChatStore } from '../../stores/chatStore'
import { useWorkspaceStore } from '../../stores/workspaceStore'
import { stripDcSuffix } from '../../utils/format'
import { isLegacyQuestionWithoutPayload } from '../../chat/questionsPending'
import { formatToolResultForDisplay } from '../../chat/toolResultDisplay'
import { useTranslation } from 'react-i18next'

import { toolLabel } from '../../chat/toolPhrases'

function isToolSuccess(content: string): boolean {
  return content.includes('成功') || content.includes('✅')
}

function formatArgs(argsStr: string): { key: string; value: string }[] {
  try {
    const obj = JSON.parse(argsStr)
    return Object.entries(obj)
      .filter(([key]) => key !== 'code') // mcp_execute: 代码过长不显示在参数列表
      .map(([key, value]) => ({
        key,
        value: typeof value === 'string' ? value : JSON.stringify(value)
      }))
  } catch { return [] }
}

/**
 * 高度回报器 — 随 AI 内容一起注入沙箱帧。
 * 帧内无法被宿主读取（sandbox 不给 allow-same-origin），只能由帧主动报高度。
 */
const HEIGHT_REPORTER = `
<script>
(function () {
  function report() {
    var h = document.body ? document.body.scrollHeight : 0
    if (h > 0) parent.postMessage({ type: 'sw-embed-height', height: h }, '*')
  }
  window.addEventListener('load', report)
  window.addEventListener('resize', report)
  requestAnimationFrame(report)
})()
</script>`

/**
 * 可视化内容内联渲染 — 直接使用 iframe 渲染 visualizerHtml，
 * 不依赖 visualizerStore，确保即使重载也能正确显示。
 *
 * sandbox 绝不能加 allow-same-origin：srcdoc 帧加了它就与宿主同源，
 * 帧内脚本可经 parent 摸到 preload 暴露的 window.api（与 HtmlPreview 同一纪律）。
 * 自适应高度因此改走 postMessage，不再读 contentDocument。
 */
function VisualizerEmbed({ html, preferredHeight }: { html: string; preferredHeight?: number }) {
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const [height, setHeight] = useState(0)

  useEffect(() => {
    if (iframeRef.current && html) {
      iframeRef.current.srcdoc = html + HEIGHT_REPORTER
    }
  }, [html])

  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      // 只认自己那一帧：沙箱帧来源不透明（origin 恒为 'null'），只能按 source 认人
      if (e.source !== iframeRef.current?.contentWindow) return
      if (e.data?.type === 'sw-embed-height' && typeof e.data.height === 'number' && e.data.height > 0) {
        setHeight(e.data.height)
      }
    }
    window.addEventListener('message', onMsg)
    return () => window.removeEventListener('message', onMsg)
  }, [])

  return (
    <div className="mt-2 rounded-lg overflow-hidden border border-surface-200">
      <iframe
        ref={iframeRef}
        sandbox="allow-scripts"
        className="w-full bg-transparent border-0 block"
        scrolling="no"
        style={{
          height: height > 0 ? `${height}px` : `${preferredHeight || 300}px`,
          overflow: 'hidden',
          transition: 'height 0.2s ease-out'
        }}
      />
    </div>
  )
}

export function ToolCallCard({ message, isLastStreaming = false }: { message: ChatMessage; isLastStreaming?: boolean }) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)
  const { artifacts, setActive } = useArtifactStore()
  const name = message.toolName || ''
  const artifactForMessage = message.artifactRef
    ? artifacts.find(artifact => artifact.id === message.artifactRef?.id)
    : artifacts[artifacts.length - 1]
  const artifactDisplayTitle = stripDcSuffix(message.artifactRef?.title || artifactForMessage?.title || '')
    || t('chat.toolCard.artifactFallback')
  const displayContent = formatToolResultForDisplay(name, message.content, t)
  const displayName = toolLabel(name, t)
  const success = isToolSuccess(message.content)
  const isError = message.content.includes('失败') || message.content.includes('❌') || message.content.includes('error') || message.content.includes('Error')
  const args = message.toolArgs ? formatArgs(message.toolArgs) : []
  // 部署过渡期的新版问卷可能还没有锚点版本标记：只要当前 pending 状态或后续回答
  // 已证明题目存在，就不能把它冒充成“旧版内容丢失”。selector 返回 boolean，避免整条
  // messages 数组变化时无谓地重渲染所有普通工具卡。
  const legacyQuestionWithoutPayload = useChatStore(state => name === 'questions_v2' && isLegacyQuestionWithoutPayload(message, {
    pendingArtifactId: state.pendingQuestionsV2?.artifactId,
    messages: state.messages
  }))

  // 「还在跑」= 结果还没回来 **且** 会话确实在流式中。
  //
  // 之前写成 `!success && !isError` 是错的:success/isError 都是从 message.content
  // 里嗅关键词猜出来的,一条完成了、但结果文案里既没有成功标记也没有「失败/error」
  // 字样的工具(比如「创建预览」返回一个文件名),两边都判不中,于是历史记录里
  // 它会永远扫光。判据换成组件自己那套「结果到了没有」的标准(skeleton 占位用的
  // 就是 !message.content),再与 isStreaming 取交集,历史消息就一定不会亮。
  // 「还在跑」= 结果没回来 + 这是流式中的最后一条。
  // isLastStreaming 由 ChatPanel / ProcessGroup 统一算好往下传 —— 不在这里自己订阅
  // store:MessageBubble 的注释已经写过,每条消息各自订阅会让 memo 形同虚设。
  const running = !message.content && isLastStreaming

  return (
    <div className="flex justify-start mb-msg animate-fade-in">
      <div className="max-w-msg w-full">
        {/* D3 Phase D:tool 卡片视觉变轻 — 左竖线 + 无外框,hover 显微弱 bg。
            设计规范:进行中的步骤永远「扫光」而不是干转一个圈 —— 整张卡走 .op-sweep,
            工具名走 .op-shimmer-text,两者都在 prefers-reduced-motion 下自动退化。 */}
        <button
          onClick={() => setExpanded(!expanded)}
          className={`w-full flex items-center gap-2 pl-3 pr-2 py-1.5 border-l border-border hover:bg-surface-50 dark:hover:bg-surface-100/50 rounded-r transition-colors text-left ${running ? 'op-sweep' : ''}`}
        >
          {isError ? (
            <X className="w-3.5 h-3.5 text-danger shrink-0" strokeWidth={1.75} />
          ) : running ? (
            /* 运行中是 agent 活动 —— 官方色板里这归 clay,不归 accent */
            <Wrench className="w-3.5 h-3.5 text-clay shrink-0" />
          ) : success ? (
            <Check className="w-3.5 h-3.5 text-success shrink-0" strokeWidth={1.75} />
          ) : (
            /* 跑完了但结果文案没命中成功关键词:静默收尾,不要挂着 clay 扳手
               装作还在干活 —— 那正是历史记录里永远扫光的同一个错。 */
            <Check className="w-3.5 h-3.5 text-surface-300 shrink-0" strokeWidth={1.75} />
          )}
          <span className={`text-chat-label font-medium truncate flex-1 ${running ? 'op-shimmer-text' : 'text-surface-600'}`}>{displayName}</span>
          {!expanded && (
            message.content ? (
              <span className="text-chat-meta text-surface-400 truncate max-w-[40%]">
                {displayContent.slice(0, 50)}
              </span>
            ) : (
              /* Phase B 流式协议:tool 还在 running(没结果),用 skeleton 占位提示"有结果会来" */
              <span className="sw-skeleton-shimmer h-3 w-16 rounded" aria-hidden data-testid="tool-running-skeleton" />
            )
          )}
          <ChevronDown className={`w-3.5 h-3.5 text-surface-300 dark:text-surface-500 shrink-0 transition-transform duration-200 ${expanded ? 'rotate-180' : ''}`} />
        </button>

        {/* 展开内容（Input/Output） */}
        {expanded && (
          <div className="mt-1 ml-3 pl-3 pr-2 py-2 border-l border-border animate-fade-in">
            {args.length > 0 && (
              <div className="mb-2">
                <span className="text-chat-small font-medium text-surface-300 uppercase tracking-wider">{t('chat.toolCard.input')}</span>
                <div className="mt-1 space-y-0.5">
                  {args.map(({ key, value }) => (
                    <div key={key} className="flex gap-1.5 text-chat-meta">
                      <span className="text-surface-400 shrink-0">{key}:</span>
                      <span className="text-surface-600 break-all">{value}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            <div>
              <span className="text-chat-small font-medium text-surface-300 uppercase tracking-wider">{t('chat.toolCard.output')}</span>
              <div className="mt-1 text-chat-meta text-surface-500 whitespace-pre-wrap leading-relaxed max-h-48 overflow-y-auto">
                {displayContent}
              </div>
            </div>
          </div>
        )}

        {legacyQuestionWithoutPayload && (
          <div
            data-testid="legacy-question-unavailable"
            className="mt-1 rounded-r border-l border-amber-300 bg-amber-50/70 px-3 py-2 text-chat-meta leading-relaxed text-amber-800 dark:border-amber-700 dark:bg-amber-950/20 dark:text-amber-200"
          >
            {t('chat.toolCard.legacyQuestionUnavailable')}
          </div>
        )}

        {/* Artifact: 在工作空间打开 */}
        {name === 'create_artifact' && artifacts.length > 0 && (
          <button
            onClick={() => {
              const latest = artifactForMessage
              if (!latest) return
              setActive(latest.id)
              useWorkspaceStore.getState().openTab({
                kind: 'artifact',
                title: stripDcSuffix(latest.title) || t('chat.toolCard.artifactFallback'),
                artifactId: latest.id
              })
            }}
            className="mt-1 w-full flex items-center gap-2 rounded-lg px-3 py-2 bg-brand-50 dark:bg-brand-900/20 text-brand-600 dark:text-brand-400 hover:bg-brand-100 dark:hover:bg-brand-900/30 transition-colors"
          >
            <Eye className="w-3.5 h-3.5 shrink-0" />
            {/* 标题不许被长结果文案(如门闩"已拒绝:…")挤成竖排;尾注截断留省略号 */}
            <span className="text-chat-label font-medium whitespace-nowrap shrink-0">{t('chat.toolCard.openInWorkspace')}</span>
            <span className="text-chat-meta text-brand-400 dark:text-brand-500 ml-auto min-w-0 truncate">{artifactDisplayTitle}</span>
          </button>
        )}

        {/* Visualizer: 直接渲染 HTML（不依赖 store，确保重载后也能显示） */}
        {name === 'create_visualizer' && message.visualizerHtml && (
          <VisualizerEmbed html={message.visualizerHtml} preferredHeight={message.visualizerHeight} />
        )}

        {/* MCP App 成品现在走独立的 'mcp_app_render' 消息(由 chatStore 在 mcp_app_inline 事件里 push 到末尾)
            这样视觉顺序自然:工具调用 → 权限确认 → 渲染结果。详见 MessageBubble 的 McpAppRenderMessage。*/}
      </div>
    </div>
  )
}
