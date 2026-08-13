export interface LayoutManifest {
  preferredLayout: 'study' | 'normal'
  triggerOn: 'always' | 'hasSources'
  transitionMs?: number
  chatSidebarWidth?: number
}

// ---- Sources（Cave 模式资料区 / 知识库）—— P2 数据层 ----
// 每个 source 在 ~/.openpipal/workspace/sources/<id>/ 一个子目录 + meta.json

export type SourceType = 'pdf' | 'md' | 'html' | 'txt' | 'image' | 'url' | 'other'
export type SourceStatus = 'pending' | 'ingesting' | 'ready' | 'failed'

export interface Source {
  id: string
  title: string
  type: SourceType
  status: SourceStatus
  originalFile?: string
  extractedFile?: string
  thumbnailFile?: string
  summary?: string
  sourceUrl?: string
  addedAt: number
  ingestedAt?: number
  byteSize?: number
  /** 学习会话内的引用编号([1]/[2]...)由 listSources 按 addedAt 升序赋值,不持久化 */
  citationIndex?: number
  errorMessage?: string
}

export interface AddSourceParams {
  title: string
  type: SourceType
  filePath?: string
  content?: string
  sourceUrl?: string
}

export interface SourceStatusPatch {
  extractedFile?: string
  thumbnailFile?: string
  summary?: string
  errorMessage?: string
}

export interface RoleInfo {
  name: string
  displayName: string
  icon: string
  layoutManifest?: LayoutManifest
  /** 角色头像 data URL(system-agents/<role>/avatar.* 存在时);无则渲染端回落 Lucide */
  avatarDataUrl?: string
}

export interface PermissionRequestData {
  requestId: string
  tool: string
  args: Record<string, any>
  risk: string
  reason: string
  conversationId?: string
  executionId?: string
}

export interface FileAttachmentData {
  fileName: string
  fileType: string
  sizeBytes: number
  path?: string  // workspace/uploads/ 中的路径（AI 用工具读取）
}

/** 会话前置上传的资产（任意角色通用）*/
export interface InitialAsset {
  /** 'role-system' = 角色资产库里的长期档案文件夹（如教师的教学风格），由代码自动注入而非用户手选 */
  category: 'brand' | 'refs' | 'docs' | 'kits' | 'design-system' | 'role-system'
  fileName: string
  path: string
  /** 'library' = 从资产库勾选的既有条目（如设计系统文件夹），非本次上传 */
  sourceType: 'upload' | 'figma' | 'codebase' | 'screenshot' | 'library'
  sizeBytes?: number
}

export type ChatMessageKind =
  | 'user'
  | 'assistant'
  | 'thinking'
  | 'tool'
  | 'permission_request'
  | 'ask_user'
  | 'voice'
  | 'incomplete'    // 用户 Stop 后保留可见的部分回复，但不作为完整回答回放给模型
  | 'task-trigger'  // 任务触发时的系统内部消息（prompt + event 数据），UI 隐藏
  | 'inject-notice' // 消息插队的 turn 边界通知（"已引导对话" / "已加入跟单队列"），左对齐细灰字，不发给 AI

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'tool'
  content: string
  messageVersion?: number
  messageKind?: ChatMessageKind
  messageSubtype?: string
  /** Offset of the OpenPipal-owned `[Error]` suffix in a stream-error message. */
  syntheticErrorOffset?: number
  screenshot?: string
  /** screenshot 已卸载到会话 attachments/ sidecar 的文件名；有 ref 时落盘投影剥离内联 base64（内存/模型载荷不受影响） */
  screenshotRef?: string
  images?: string[]  // base64 encoded user-pasted images
  /** images 的磁盘落点（相对本会话 artifacts 目录，如 uploads/pasted-<ts>-0.png）。
   *  发送前由主进程落盘写回；模型侧按此注入"图片已存盘"事实，dc 配图直接相对引用。 */
  imagePaths?: string[]
  /** 旧版本遗留字段；新版模型载荷忽略它，图片只在整体 token 压缩时离开上下文。 */
  imagesDroppedFromPayload?: boolean
  searchResults?: string
  timestamp: number
  toolName?: string
  /** 新版 questions_v2 的轻量持久化协议标记；不包含题目正文。 */
  questionsV2Version?: number
  /** Pi provider 原始工具调用 id；并发/同名工具结果必须靠它精确配对，不能只猜最近的同名卡片。 */
  toolCallId?: string
  /** 模型真正发出的工具入参；toolArgs 被 UI 卡片复用为展示数据时，跨轮回放优先使用此字段。 */
  modelToolArgs?: string
  toolArgs?: string
  askQuestion?: string
  askOptions?: { label: string; value: string }[]
  askFields?: { label: string; placeholder?: string; type?: string; options?: string[]; required?: boolean }[]
  // 思考内容（持久化）
  thinkingContent?: string
  // 可视化 HTML 内容（持久化，用于重载后渲染）
  visualizerHtml?: string
  visualizerHeight?: number
  /** mcpAppPayload 已卸载到会话 attachments/ sidecar 的文件名；渲染层无内联 payload 时按 ref 懒加载 */
  mcpAppRef?: string
  /** MCP App inline 渲染 payload(独立 mcp_app_render 消息) */
  mcpAppPayload?: {
    serverName: string
    serverBinding: string
    toolName: string
    conversationId?: string
    resourceUri: string
    html: string
    args: Record<string, any>
    /** ContentBlock 数组(image/text/resource) — push 到 iframe 时放在 content 字段 */
    contentBlocks: any[]
    /** typed 结构化数据 — push 到 iframe 时放在 structuredContent 字段 */
    structuredContent: any
    permissions: string[]
    csp: any
  }
  // 内联权限请求
  permissionRequest?: PermissionRequestData
  permissionStatus?: 'pending' | 'approved' | 'denied'
  // 文件附件
  fileAttachments?: FileAttachmentData[]
  /** 消息触发创建的 artifact 的元数据引用（content 存磁盘 sidecar，switchConversation 据此 rehydrate）*/
  artifactRef?: {
    id: string
    type: string
    title: string
    path: string
    language?: string
  }
  /** Realtime API 的 item_id —— 作为 voice transcript 流式 upsert 的稳定键 */
  voiceItemId?: string
  /** voice transcript 是否已收到 *.done 终态事件（false = 还在 streaming） */
  voiceFinal?: boolean
  /** 这段语音的音频 WAV 路径（~/.openpipal/voice-audio/...）—— 有则气泡上显示 ▶ 回听。随消息持久化 */
  audioPath?: string
}

export interface TargetAppStatus {
  connected: boolean
  appName?: string
  windowTitle?: string
  /** 前台应用是否处于 macOS 原生全屏（独立 Space）— 用于 Orb 悬浮球模式触发 */
  isFullscreen?: boolean
}

export interface VoiceTranscriptItem {
  itemId: string
  role: 'user' | 'assistant'
  transcript: string
  isFinal: boolean
}

export type VoiceSessionState = 'idle' | 'connecting' | 'connected' | 'error'

export interface RealtimeConfig {
  url: string
  model: string
  hasKey: boolean
}

// ---- 统一任务模型 ----

export interface ScheduleConfig {
  type: 'fixed' | 'interval' | 'cron'
  time?: string
  days?: string[]
  intervalMs?: number
  cron?: string
}

/** 任务触发条件 — discriminated union */
export type TaskTrigger =
  | { type: 'schedule'; schedule: ScheduleConfig }
  | { type: 'webhook'; secret?: string }  // URL 由 task.id 决定
  | { type: 'gate'; metric: string; threshold: number }  // 预留

export interface TaskResult {
  status: 'success' | 'error'
  message?: string
  timestamp: number
}

/** 智能免打扰的单条审计记录 */
export interface SilentLogEntry {
  timestamp: number
  reason: string
  source?: string
}

export interface Task {
  id: string
  name: string
  enabled: boolean

  /** 任务所属角色（创建时记录，决定执行时生成的对话归属哪个角色视图） */
  role?: string

  /** 作用域 — 二选一 */
  workspaceId?: string
  agentId?: string

  trigger: TaskTrigger
  prompt: string
  conversationMode: 'persistent' | 'per-run'
  boundConversationId?: string

  /** 智能免打扰：Agent 决定是否要通知你（undefined/true = 启用，false = 关闭） */
  smartSilence?: boolean
  silentLog?: SilentLogEntry[]

  lastRun?: number
  nextRun?: number
  lastResult?: TaskResult

  createdAt: number
  updatedAt: number
}
