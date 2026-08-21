import { useState, useEffect, useRef, memo } from 'react'
import { RefreshCw, Shield, ShieldAlert, Check, X, FileText, FileCode, FileSpreadsheet, FileImage, ChevronDown, Bot, Brain } from 'lucide-react'
import { Markdown } from './shared/Markdown'
import { ChatMessage, FileAttachmentData } from '../types'
import { fmtSize } from '../utils/format'
import { ScreenshotCard } from './messages/ScreenshotCard'
import { SearchResultCard } from './messages/SearchResultCard'
import { DocumentCard } from './messages/DocumentCard'
import { ToolCallCard } from './messages/ToolCallCard'
import { McpAppPreview } from './artifacts/McpAppPreview'
import { BashOutputCard } from './messages/BashOutputCard'
import { FileResultCard } from './messages/FileResultCard'
import { CodeExecutionCard } from './messages/CodeExecutionCard'
import { SubagentCard } from './messages/SubagentCard'
import { EditableUserMessage, renderUserContent } from './messages/UserMessage'
import { ThinkingStream } from './ThinkingStream'
import { CopyButton } from './messages/shared/CopyButton'
import { VoiceReplayButton } from './messages/shared/VoiceReplayButton'
import { PasteButton } from './messages/shared/PasteButton'
import { useChatStore } from '../stores/chatStore'
import { toolLabel } from '../chat/toolPhrases'
import { getMessageKind, isRenderableToolMessage } from '../chat/messages'
import { useTranslation } from 'react-i18next'
import { formatMessageContentForDisplay, injectNoticeContentForDisplay } from '../chat/messageDisplay'

interface MessageBubbleProps {
  message: ChatMessage
  appName?: string
  roleIcon?: string
  onSend?: (content: string) => void
  onRegenerate?: () => void
  onEditAndResend?: (messageId: string, newContent: string) => void
  onSaveAsAgent?: () => void
  /** 本消息是否为"当前正在流式输出的最后一条 assistant 消息"——由 ChatPanel 统一算好传入
   *  (而非本组件各自订阅 store),否则任意新消息追加都会让全部历史消息重渲染,见下方 memo comparator 注释。 */
  isLastStreaming?: boolean
  /** 本条渲染在 ProcessGroup 展开区里(过程栏)—— 去掉页脚操作行/时间戳:整轮耗时已经写在
   *  分割线上,过程里只留内容本身,一列到底全部左对齐。复制/重新生成属于台面上的结论。 */
  inProcess?: boolean
}

export function formatMessageTime(timestamp: number, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    hour: '2-digit',
    minute: '2-digit',
  }).format(timestamp)
}

// React.memo 显式 comparator —— 为什么不能只靠默认浅比较 + 稳定 message 引用:
// chatStore 的 normalizeChatMessages()(sendMessage/insertVoiceMessages/steer 等多处调用)对整个
// messages 数组做 .map(withMessageMeta),withMessageMeta 内部 `{...message, ...}` 是无条件 shallow
// spread——哪怕这条消息的内容完全没变,也会拿到一个新的顶层对象引用。也就是说"发一条新消息"这种最高频操作,
// 会让历史里每一条消息的 message prop 引用全部失效,单纯 React.memo(默认浅比较)完全挡不住。
// 于是显式逐字段比较 MessageBubble 本体 + 内部各 Card 子组件(ScreenshotCard/SearchResultCard/
// DocumentCard/ToolCallCard/BashOutputCard/FileResultCard/CodeExecutionCard/SubagentCard/
// McpAppPreview/EditableUserMessage)实际读取用于渲染的所有字段。
// 嵌套字段(images/fileAttachments/askOptions/askFields/permissionRequest/mcpAppPayload)按引用比较
// 即可——withMessageMeta 只 shallow spread 顶层,从不重建这些嵌套引用,真正变化时上游会给出新引用。
// 刻意不比较的字段:imagesDroppedFromPayload / messageVersion / voiceItemId / voiceFinal。
// artifactRef 会被 ToolCallCard 用于识别无法恢复的旧版问卷，因此必须参与渲染比较。
const MESSAGE_RENDER_FIELDS: (keyof ChatMessage)[] = [
  'id', 'role', 'content', 'messageKind', 'messageSubtype',
  'syntheticErrorOffset',
  'screenshot', 'screenshotRef', 'images', 'searchResults', 'timestamp',
  'toolName', 'questionsV2Version', 'toolArgs', 'askQuestion', 'askOptions', 'askFields',
  'thinkingContent', 'visualizerHtml', 'visualizerHeight',
  'mcpAppPayload', 'mcpAppRef', 'artifactRef', 'permissionRequest', 'permissionStatus',
  'fileAttachments', 'audioPath'
]

function messagesRenderEqual(a: ChatMessage, b: ChatMessage): boolean {
  if (a === b) return true
  for (const field of MESSAGE_RENDER_FIELDS) {
    if (a[field] !== b[field]) return false
  }
  return true
}

function messageBubblePropsEqual(prev: MessageBubbleProps, next: MessageBubbleProps): boolean {
  return (
    prev.appName === next.appName &&
    prev.roleIcon === next.roleIcon &&
    prev.onSend === next.onSend &&
    prev.onRegenerate === next.onRegenerate &&
    prev.onEditAndResend === next.onEditAndResend &&
    prev.onSaveAsAgent === next.onSaveAsAgent &&
    prev.isLastStreaming === next.isLastStreaming &&
    prev.inProcess === next.inProcess &&
    messagesRenderEqual(prev.message, next.message)
  )
}


// MCP App 成品消息 — 单独消息,只渲染 iframe,放在权限确认之后,作为该轮工具调用的视觉收官
// payload 可能已卸载到附件 sidecar(只剩 mcpAppRef)——挂载时按 ref 懒加载
function McpAppRenderMessage({ message }: { message: ChatMessage }) {
  const cid = useChatStore(s => s.activeConversationId)
  const [lazyPayload, setLazyPayload] = useState<ChatMessage['mcpAppPayload'] | null>(null)
  useEffect(() => {
    if (message.mcpAppPayload || !message.mcpAppRef || !cid) return
    let cancelled = false
    ;(window.api as any).loadConvAttachment?.(cid, message.mcpAppRef)
      ?.then((data: string | null) => {
        if (cancelled || !data) return
        try { setLazyPayload(JSON.parse(data)) } catch { /* 附件损坏则不渲染 */ }
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [message.mcpAppPayload, message.mcpAppRef, cid])

  const payload = message.mcpAppPayload || lazyPayload
  if (!payload) return null
  return (
    <div className="flex justify-start mb-msg animate-fade-in">
      <div className="max-w-msg w-full">
        <div className="rounded-lg overflow-hidden border border-surface-200 bg-white dark:bg-surface-0 w-full">
          <McpAppPreview key={message.id} autoSize payload={payload} />
        </div>
      </div>
    </div>
  )
}

// 内联权限卡片组件
function PermissionCard({ message, roleIcon: _roleIcon }: { message: ChatMessage; roleIcon?: string }) {
  const { t } = useTranslation()
  const request = message.permissionRequest!
  const status = message.permissionStatus || 'pending'
  const isRisky = request.reason.includes('危险') || request.reason.includes('删除')
  const toolDisplayName = toolLabel(request.tool, t)
  const respondInlinePermission = useChatStore(s => s.respondInlinePermission)

  // 格式化参数展示
  const argEntries = Object.entries(request.args || {})
    .filter(([_, v]) => v !== undefined && v !== null)
    .map(([k, v]) => {
      const str = String(v)
      return { key: k, value: str.length > 120 ? str.substring(0, 120) + '...' : str }
    })

  return (
    <div className="flex justify-start mb-msg animate-fade-in">
      <div className="max-w-msg w-full rounded-lg overflow-hidden border border-surface-100 bg-surface-0 dark:bg-surface-50">
        {/* Header */}
        <div className={`px-4 py-3 flex items-center gap-2.5 ${isRisky ? 'bg-red-50 dark:bg-red-900/20' : 'bg-amber-50 dark:bg-amber-900/20'}`}>
          {isRisky ? (
            <ShieldAlert className="w-5 h-5 text-red-500 flex-shrink-0" />
          ) : (
            <Shield className="w-5 h-5 text-amber-500 flex-shrink-0" />
          )}
          <div>
            <p className={`text-chat font-medium ${isRisky ? 'text-red-700 dark:text-red-300' : 'text-amber-700 dark:text-amber-300'}`}>
              {isRisky ? t('chat.permission.highRiskConfirmation') : t('chat.permission.confirmation')}
            </p>
            <p className="text-chat-meta text-surface-500 mt-0.5">{request.reason}</p>
          </div>
        </div>

        {/* Content */}
        <div className="px-4 py-3 space-y-2.5">
          <div className="flex items-center gap-2">
            <span className="text-chat-meta text-surface-400 w-10">{t('chat.permission.tool')}</span>
            <span className="text-chat text-surface-700 font-medium">{toolDisplayName}</span>
          </div>

          {argEntries.length > 0 && (
            <div className="bg-surface-100/60 dark:bg-surface-100 rounded-lg px-3 py-2 max-h-32 overflow-y-auto">
              {argEntries.map(({ key, value }) => (
                <div key={key} className="flex gap-1.5 text-chat-meta mb-1 last:mb-0">
                  <span className="text-surface-400 shrink-0">{key}:</span>
                  <span className="text-surface-600 break-all font-mono text-chat-small">{value}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Buttons or Status */}
        {status === 'pending' ? (
          <div className="px-4 py-3 border-t border-surface-100 space-y-2">
            <div className="flex items-center gap-2">
              <button
                onClick={() => respondInlinePermission(request.requestId, false)}
                className="flex-1 text-chat-label py-2 rounded-lg border border-surface-200 text-surface-500 hover:bg-surface-50 transition-colors"
              >
                {t('chat.permission.deny')}
              </button>
              <button
                onClick={() => respondInlinePermission(request.requestId, true)}
                className={`flex-1 text-chat-label py-2 rounded-lg text-white transition-colors ${
                  isRisky
                    ? 'bg-red-500 hover:bg-red-600'
                    : 'bg-brand-500 hover:bg-brand-600'
                }`}
              >
                {t('chat.permission.allow')}
              </button>
            </div>
            {!isRisky && (
              <button
                onClick={() => {
                  window.api.respondPermissionInline?.(request.requestId, true, true)
                  // 直接更新 store 中的状态
                  useChatStore.getState().respondInlinePermission(request.requestId, true)
                }}
                className="w-full text-chat-meta py-1.5 rounded-lg text-surface-400 hover:text-brand-600 dark:hover:text-brand-400 hover:bg-brand-50 dark:hover:bg-brand-900/20 transition-colors"
              >
                {t('chat.permission.allowForSession')}
              </button>
            )}
          </div>
        ) : (
          <div className="px-4 py-3 border-t border-surface-100 flex items-center gap-2">
            {status === 'approved' ? (
              <>
                <Check className="w-4 h-4 text-emerald-500" />
                <span className="text-chat-label text-surface-500">{t('chat.permission.approved')}</span>
              </>
            ) : (
              <>
                <X className="w-4 h-4 text-surface-400" />
                <span className="text-chat-label text-surface-500">{t('chat.permission.denied')}</span>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// 根据文件类型选择图标
function getFileIcon(fileType: string) {
  const imageTypes = ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'svg', 'webp']
  const codeTypes = ['js', 'ts', 'jsx', 'tsx', 'html', 'css', 'json', 'xml', 'md', 'txt', 'py', 'java', 'c', 'cpp', 'go', 'rs', 'rb', 'php']
  const sheetTypes = ['csv', 'xls', 'xlsx']

  if (imageTypes.includes(fileType)) return <FileImage className="w-4 h-4" />
  if (codeTypes.includes(fileType)) return <FileCode className="w-4 h-4" />
  if (sheetTypes.includes(fileType)) return <FileSpreadsheet className="w-4 h-4" />
  return <FileText className="w-4 h-4" />
}

// 文件附件卡片组件
function FileAttachmentCard({ file, isUser }: { file: FileAttachmentData; isUser: boolean }) {
  return (
    <div className={`flex items-center gap-2 px-3 py-2 rounded-lg border ${
      isUser
        ? 'bg-surface-0 border-border text-ink-primary'
        : 'bg-surface-50 dark:bg-surface-50/50 border-surface-200 text-surface-700'
    }`}>
      {getFileIcon(file.fileType)}
      <div className="flex-1 min-w-0">
        <p className={`text-chat-label font-medium truncate ${isUser ? 'text-ink-primary' : 'text-surface-700'}`}>
          {file.fileName}
        </p>
        <p className={`text-chat-small ${isUser ? 'text-ink-tertiary' : 'text-surface-400'}`}>
          {fmtSize(file.sizeBytes)} • {file.fileType}
        </p>
      </div>
    </div>
  )
}

// 折叠式思考内容组件
/**
 * 旧数据回放用的思考折叠行 —— assistant 消息自带 thinkingContent 的那种形态。
 * 现在的流式协议把 thinking 落成独立消息,由过程栏的 ThinkGroup 渲染;这里**没有 live 态**
 * (它曾经有一整套扫光/定格逻辑,但走不到,已删)。要改进行中的思考 UI 请去 ProcessGroup。
 */
function ThinkingCollapsible({ content }: { content: string }) {
  const { t } = useTranslation()
  // 思考内容量大,默认折叠成一行,点开才看全文
  const [expanded, setExpanded] = useState(false)
  const isExpanded = expanded

  return (
    <div className="group/think mb-2">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1.5 text-chat-small font-medium text-surface-300 uppercase tracking-wider hover:text-surface-400 transition-colors"
        aria-expanded={isExpanded}
      >
        {/* 展开控件一律排在文字**后面**,隐身时也不占位,左边界因此恒定。 */}
        <Brain className="w-3 h-3 shrink-0" strokeWidth={1.75} />
        <span>{t('chat.message.thoughtProcess')}</span>
        <ChevronDown
          className={`w-3 h-3 shrink-0 transition duration-200 ${isExpanded ? 'rotate-180' : ''} opacity-0 group-hover/think:opacity-100 group-has-[:focus-visible]/think:opacity-100`}
        />
      </button>
      {isExpanded && (
        /* D 第二批:thinking 内部展开容器也去外框,改成左 border 浅竖线(与过程栏嵌套竖轨同款);
           限高裁切处上下渐隐 —— 让"还有更多、不是断了"这件事自己说清楚 */
        <div className="mt-1 ml-1.5 pl-3 border-l border-border animate-fade-in">
          <ThinkingStream content={content} maxHeightClass="max-h-[200px]" />
        </div>
      )}
    </div>
  )
}

function MessageBubbleComponent({ message, appName, roleIcon, onSend, onRegenerate, onEditAndResend, onSaveAsAgent, isLastStreaming = false, inProcess = false }: MessageBubbleProps) {
  const { t, i18n } = useTranslation()
  const messageKind = getMessageKind(message)
  const isUser = message.role === 'user'
  const isTool = messageKind === 'tool'
  const displayContent = formatMessageContentForDisplay(message, t)

  // Phase B 流式协议:streaming 中的最后一条 assistant 消息,文本尾部追加光标。
  // isLastStreaming 由 ChatPanel 统一算好作为 prop 传入,本组件不再自己订阅 isStreaming/messages
  // (原实现每条消息各自订阅 store,导致任意新消息追加时全部历史消息都被迫重渲染,memo 形同虚设)。

  // 任务触发产生的"系统内部消息"（含 task prompt + webhook body）——UI 层不渲染
  // 用户看到的应该是 Agent 的回复（下一条 assistant 消息），就像收到了一条通知
  if (messageKind === 'task-trigger') {
    return null
  }

  // Phase E:tool 消息不再 reserve avatar space(整体 timeline 化,无头像)
  const withAvatar = (card: React.ReactNode) => (
    <div className="flex justify-start">
      <div className="flex-1 min-w-0">{card}</div>
    </div>
  )

  if (isTool && !isRenderableToolMessage(message)) return null
  if (isTool && (message.screenshot || message.screenshotRef)) return withAvatar(<ScreenshotCard message={message} />)
  if (isTool && message.searchResults) return withAvatar(<SearchResultCard message={message} />)
  if (isTool && message.toolName === 'generate_document') return withAvatar(<DocumentCard message={message} appName={appName} />)
  // Pi 内置工具：bash 终端输出
  if (isTool && message.toolName === 'bash') return withAvatar(<BashOutputCard message={message} />)
  // 沙箱代码执行
  if (isTool && message.toolName === 'execute_code') return withAvatar(<CodeExecutionCard message={message} />)
  // Pi 内置工具：文件操作
  if (isTool && (message.toolName === 'read' || message.toolName === 'write' || message.toolName === 'edit')) {
    return withAvatar(<FileResultCard message={message} />)
  }
  // MCP App inline 渲染消息 — 单独的"成品展示"消息,只画 iframe,无工具按钮 / 参数 / 输出
  // 由 chatStore 在收到 mcp_app_inline 事件时 push 到 messages 末尾,确保位于权限确认消息之后
  if (isTool && message.toolName === 'mcp_app_render' && (message.mcpAppPayload || message.mcpAppRef)) {
    return withAvatar(<McpAppRenderMessage message={message} />)
  }
  // subagent 工具：折叠态卡片，完整 child history 走 Workspace 侧栏 'subagent-history' artifact
  if (isTool && message.toolName === 'subagent') return withAvatar(<SubagentCard message={message} />)
  if (isTool && message.toolName) return withAvatar(<ToolCallCard message={message} isLastStreaming={isLastStreaming} />)

  // 内联权限卡片
  if (messageKind === 'permission_request' && message.permissionRequest) {
    return (
      <PermissionCard
        message={message}
        roleIcon={roleIcon}
      />
    )
  }

  // 注:messageKind === 'thinking' 不在这里处理 —— thinking 一律由过程栏的
  // ThinkGroup 渲染(classifyRaw 把它归 process,buildProcessRenderItems 再折成一组)。

  // 消息插队 turn 边界通知:左对齐细灰字一行
  // Phase E:无 avatar 后,缩进 pl-3 即可贴左,跟其他 timeline 节点对齐
  if (messageKind === 'inject-notice') {
    return (
      <div className="flex justify-start mb-msg animate-fade-in pl-3">
        <div
          className="text-chat-meta text-ink-tertiary italic"
          data-testid="inject-notice"
          data-subtype={message.messageSubtype || ''}
        >
          {injectNoticeContentForDisplay(message, t)}
        </div>
      </div>
    )
  }

  // Phase E 修正:最终输出 = 纯 inline 文本流(无 timeline 竖线)。
  // Timeline 只属于"过程性消息"(thinking/tool/search/code),最终 assistant 文本不属于。
  // 这是 Codex 的核心视觉协议:过程 vs 最终结果二分。
  // 用户消息靠右(左右布局),浅 parchment 气泡 + 圆角,无头无像;
  // assistant = 裸文本靠左填满列,跟过程内容同栏。
  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'} mb-msg animate-fade-in`}>
      <div className={`group ${
        isUser
          ? 'max-w-msg-user rounded-xl sw-chat-user-bubble bg-surface-100 text-ink-primary'
          : 'max-w-msg w-full text-ink-primary'
      }`}>
        {/* Images */}
        {(message.images?.length || message.screenshot) && (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {(message.images || (message.screenshot ? [message.screenshot] : [])).map((img, i) => (
              <img key={i} src={`data:image/jpeg;base64,${img}`} alt={t('chat.message.imageAlt', { index: i + 1 })}
                className={`rounded-md max-h-32 w-auto ${isUser ? 'opacity-90' : 'border border-surface-100'}`} />
            ))}
          </div>
        )}

        {/* File Attachments */}
        {message.fileAttachments && message.fileAttachments.length > 0 && (
          <div className="mb-2 space-y-1.5">
            {message.fileAttachments.map((file, index) => (
              <FileAttachmentCard key={index} file={file} isUser={isUser} />
            ))}
          </div>
        )}

        {/* Thinking content (折叠式) — 仅在 assistant 消息自带 thinking 且不是独立 thinking 消息时显示 */}
        {!isUser && messageKind === 'assistant' && message.thinkingContent && (
          <ThinkingCollapsible content={message.thinkingContent} />
        )}

        {/* Content */}
        {isUser ? (
          onEditAndResend ? (
            <EditableUserMessage message={message} displayContent={displayContent} onEditAndResend={onEditAndResend} />
          ) : (
            <p className="text-chat whitespace-pre-wrap leading-relaxed">{renderUserContent(displayContent, t)}</p>
          )
        ) : (
          <div className="prose-light sw-chat-prose">
            <Markdown content={displayContent} />
            {isLastStreaming && (
              <span
                className="sw-pulsing-dot align-middle ml-1 text-brand-500"
                aria-hidden
                data-testid="streaming-cursor"
              />
            )}
          </div>
        )}

        {/* ask_user 表单（fields 模式）— 表单本身由 App.tsx 在 InputBar 上方浮层渲染 */}
        {/* 这里只显示一个轻量提示，告诉用户需要填写下方的表单 */}
        {!isUser && message.askFields && message.askFields.length > 0 && (
          <div className="mt-2.5 -mx-3.5 -mb-2.5 px-3.5 py-2 bg-brand-50/50 dark:bg-brand-900/20 border-t border-brand-200/60 dark:border-brand-800 text-chat-meta text-brand-600 dark:text-brand-400">
            {t('chat.message.answerForm', { count: message.askFields.length })}
          </div>
        )}

        {/* ask_user 按钮（options 模式） */}
        {!isUser && !message.askFields && message.askOptions && message.askOptions.length > 0 && (
          <div className="flex flex-wrap gap-2 mt-2.5">
            {message.askOptions.map(opt => (
              <button key={opt.value} onClick={() => onSend?.(opt.label)}
                className="text-chat-label px-3 py-1.5 rounded-lg bg-brand-50 dark:bg-brand-900/30 text-brand-700 dark:text-brand-300 border border-brand-200 dark:border-brand-700 hover:bg-brand-100 dark:hover:bg-brand-800/40 hover:border-brand-300 dark:hover:border-brand-600 active:scale-95 transition-all">
                {opt.label}
              </button>
            ))}
          </div>
        )}

        {/* Footer: copy/paste/regenerate + timestamp —— 过程栏里的中间叙述不带页脚 */}
        {!inProcess && (
        <div className={`flex items-start gap-1.5 mt-1.5 ${isUser ? 'justify-end' : 'justify-between'}`}>
          {!isUser && message.content && !message.askOptions && (
            <div className="min-w-0 flex-1 flex flex-wrap items-center gap-x-0.5 gap-y-1">
              <CopyButton text={displayContent} />
              {message.audioPath && <VoiceReplayButton audioPath={message.audioPath} />}
              {appName && <PasteButton text={displayContent} appName={appName} />}
              {onRegenerate && (
                <button onClick={onRegenerate}
                  className="flex items-center gap-1 text-chat-meta text-surface-400 hover:text-brand-600 dark:hover:text-brand-400 transition-colors px-1.5 py-0.5 rounded hover:bg-brand-50 dark:hover:bg-brand-900/30">
                  <RefreshCw className="w-3 h-3" />
                  <span>{t('chat.message.regenerate')}</span>
                </button>
              )}
              {onSaveAsAgent && (
                <button onClick={onSaveAsAgent}
                  className="flex items-center gap-1 text-chat-meta text-surface-400 hover:text-brand-600 dark:hover:text-brand-400 transition-colors px-1.5 py-0.5 rounded hover:bg-brand-50 dark:hover:bg-brand-900/30">
                  <Bot className="w-3 h-3" />
                  <span>{t('chat.message.saveAsAgent')}</span>
                </button>
              )}
            </div>
          )}
          {/* 用户语音输入的回听(AI 侧已在上面的操作行里) */}
          {isUser && message.audioPath && (
            <div className="flex items-center mr-1.5">
              <VoiceReplayButton audioPath={message.audioPath} />
            </div>
          )}
          <span className="shrink-0 self-end text-chat-small text-ink-tertiary">
            {formatMessageTime(message.timestamp, i18n.resolvedLanguage || i18n.language)}
          </span>
        </div>
        )}
      </div>
    </div>
  )
}

// 长对话性能:历史消息不随任一条消息变化而整体重渲染,见上方 messageBubblePropsEqual 注释。
export const MessageBubble = memo(MessageBubbleComponent, messageBubblePropsEqual)
