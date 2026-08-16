import type { UpdateCheckResult } from '../shared/update-contract'
import { ElectronAPI } from '@electron-toolkit/preload'
import type { LocalePreference, LocaleState } from '../shared/i18n/contract'
import type { AppFollowingUpdateResult, AppSettingsState } from '../shared/app-following-contract'

interface TargetAppStatus {
  connected: boolean
  appName?: string
  windowTitle?: string
}

/** MCP server 配置 DTO — 二选一:stdio(command)或 remote(url),remote 可加 oauth */
interface McpServerConfigDTO {
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
  oauth?: boolean
}

interface ChatMessage {
  role: string
  content: string
  screenshot?: string
}

interface ThinkingBudgets {
  low: number
  medium: number
  high: number
}

/** 搜索服务（web_search）配置 —— v1 服务商固定 tavily；提交空 apiKey = 保留已保存的值 */
interface SearchConfigShape {
  provider: 'tavily'
  apiKey: string
}

interface SearchConfigDisplayShape extends SearchConfigShape {
  /** 生效凭证来自内置（.env）回退 */
  builtin: boolean
  /** 生效配置里有 key（用户自配或内置任一） */
  configured: boolean
}

interface ModelConfigShape {
  provider: string
  baseUrl: string
  apiKey: string
  model: string
  supportsThinking?: boolean
  supportsImages?: boolean
  contextWindow?: number
  apiFormat?: 'openai' | 'anthropic' | 'openai-responses'
  thinkingFormat?: 'auto' | 'openai' | 'qwen' | 'deepseek' | 'zai'
  thinkingBudgets?: ThinkingBudgets | null
  systemPromptAdapter?: string
}

interface ModelProviderShape {
  id: string
  name: string
  provider: string
  baseUrl: string
  apiKey?: string
  apiKeyMasked?: string
  apiFormat?: 'openai' | 'anthropic' | 'openai-responses'
  thinkingFormat?: 'openai' | 'qwen' | 'deepseek' | 'zai'
  thinkingBudgets?: ThinkingBudgets | null
  modelCount?: number
  builtin?: boolean
}

interface LayoutManifest {
  preferredLayout: 'study' | 'normal'
  triggerOn: 'always' | 'hasSources'
  transitionMs?: number
  chatSidebarWidth?: number
}

interface RoleInfo {
  name: string
  displayName: string
  icon: string
  systemPrompt: string
  tools: string[]
  layoutManifest?: LayoutManifest
  avatarDataUrl?: string
}

interface OpenPipalAPI {
  sendChat: (messages: ChatMessage[], agentId?: string, conversationConfig?: { workingDir?: string }) => void
  abortChat: (conversationId?: string) => void
  steerChat: (conversationId: string, text: string, images?: string[]) => Promise<{ ok: boolean }>
  queueChat: (conversationId: string, text: string, images?: string[]) => Promise<{ ok: boolean }>
  onStreamChunk: (callback: (conversationId: string, chunk: string) => void) => () => void
  onStreamEnd: (callback: (conversationId: string, error?: string) => void) => () => void
  /** Desktop-only transcript/lease barrier; absent from browser and older renderer shims. */
  onTranscriptPersistenceRequest?: (
    callback: (conversationId: string, executionId: string) => Promise<void>
  ) => () => void
  onTextFlush: (callback: (conversationId: string) => void) => () => void
  onToolStart: (callback: (conversationId: string, name: string, toolCallId?: string) => void) => () => void
  onToolEnd: (
    callback: (
      conversationId: string, name: string,
      screenshot?: string, searchResults?: string, mcpResult?: string, mcpArgs?: string,
      visualizer?: { id: string; type: 'html' | 'svg' | 'chart'; title: string; content: string; height?: number },
      toolCallId?: string,
      modelToolArgs?: string
    ) => void
  ) => () => void
  onAskUser: (callback: (conversationId: string, question: string, options: { label: string; value: string }[]) => void) => () => void
  pasteToTarget: (text: string) => Promise<{ success: boolean; error?: string }>
  /** 截取本窗口页面指定区域（画布圈画评论截图）；失败/浏览器模式返回 null */
  captureRegion: (rect: { x: number; y: number; width: number; height: number }) => Promise<{ base64: string } | null>
  /** 设计系统预览资源；只返回受控文本或图片 data URL，不接受本机绝对路径。 */
  readDesignSystemResource: (name: string, rel: string) => Promise<
    | { ok: true; kind: 'text' | 'data-url'; data: string; contentType: string; size: number }
    | { ok: false; code: string; error: string }
  >
  /** 进程期只读 iframe capability；仅用于拼接 design-system 静态预览 URL。 */
  getDesignSystemResourceCapability: (name: string) => Promise<string | null>
  // 版本检查 — 只问一次 GitHub Releases
  checkForUpdate: () => Promise<UpdateCheckResult>
  saveVoiceAudio: (conversationId: string, itemId: string, role: string, base64Pcm: string) => Promise<{ path?: string; error?: string }>
  extractConversationMemory: (history: Array<{ role: string; content: string }>, conversationId: string) => Promise<void>
  // 本地 STT — whisper.cpp
  checkSTT: () => Promise<{ ready: boolean; reason?: string; reasonKey?: string; reasonParams?: Record<string, string | number> }>
  transcribeAudio: (wavBytes: ArrayBuffer) => Promise<{ text?: string; error?: string; errorKey?: string; errorParams?: Record<string, string | number> }>
  onTargetStatus: (callback: (status: TargetAppStatus) => void) => () => void
  onAppChanged: (callback: (appName: string, displayName: string) => void) => () => void
  // 角色管理
  getRoleInitState: () => Promise<{ hasRole: boolean; role: RoleInfo }>
  getAllRoles: () => Promise<RoleInfo[]>
  getCurrentRole: () => Promise<RoleInfo>
  switchRole: (roleName: string) => Promise<RoleInfo | null>
  // 设置
  getAppSettings: () => Promise<AppSettingsState>
  setAppFollowingEnabled: (enabled: boolean) => Promise<AppFollowingUpdateResult>
  setDisabledApps: (apps: string[]) => Promise<{ ok: true }>
  getLocaleState: () => Promise<LocaleState>
  setLocalePreference: (preference: LocalePreference) => Promise<LocaleState>
  onLocaleChanged: (callback: (state: LocaleState) => void) => () => void
  // 对话管理
  listConversations: () => Promise<any[]>
  createConversation: (role: string, title?: string, agentId?: string) => Promise<any>
  getConversation: (id: string) => Promise<any>
  getConversationMessages: (id: string) => Promise<any[]>
  appendMessages: (id: string, messages: any[]) => Promise<any>
  replaceMessages: (id: string, messages: any[]) => Promise<any>
  /** 大附件卸载（截图/mcpApp payload）→ 返回 attachments/ 下的 ref 文件名；失败返回 null（保持内联） */
  saveConvAttachment?: (cid: string, messageId: string, kind: 'screenshot' | 'mcpapp', content: string) => Promise<string | null>
  loadConvAttachment?: (cid: string, ref: string) => Promise<string | null>
  /** 将用户粘贴的图片落入当前会话的 uploads/，返回相对路径。 */
  persistChatImages?: (conversationId: string, images: string[]) => Promise<string[]>
  /** 读取当前会话 uploads/ 中的一张图片，供来源预览按需展示。 */
  readUploadAsset?: (conversationId: string, name: string) => Promise<{ base64: string; mime: string } | null>
  deleteConversation: (id: string) => Promise<any>
  updateConversationTitle: (id: string, title: string) => Promise<any>
  updateConversationRole: (id: string, role: string) => Promise<boolean>
  updateConversationConfig: (id: string, config: { workingDir?: string; thinkingEnabled?: boolean; [k: string]: any }) => Promise<any>
  // 模型配置
  getModelConfig: () => Promise<ModelConfigShape & { builtin?: boolean }>
  getModelConfigFull: () => Promise<ModelConfigShape & { builtin?: boolean; supportsEffortDial?: boolean }>
  saveModelConfig: (config: Partial<ModelConfigShape>) => Promise<any>
  testConnection: (config: Partial<ModelConfigShape>) => Promise<{ ok: boolean; error?: string; errorKey?: string; errorParams?: Record<string, string>; model?: string; correctedBaseUrl?: string }>
  testThinkingSupport: (config: Partial<ModelConfigShape>) => Promise<{ detected: boolean; error?: string }>
  listRemoteModels: (config: Partial<ModelConfigShape>) => Promise<{
    ok: boolean
    models: Array<{ id: string; name?: string; reasoning?: boolean; image?: boolean; contextWindow?: number; known?: boolean }>
    errorKey?: string
  }>
  getProviders: () => Promise<Record<string, { name: string; baseUrl: string; models: Array<{ id: string; name?: string; reasoning?: boolean; image?: boolean; contextWindow?: number }> }>>
  hasApiKey: () => Promise<{ hasKey: boolean }>
  getAvailableModels: () => Promise<Array<{
    id: string
    name: string
    model: string
    active: boolean
    supportsThinking: boolean
    supportsEffortDial: boolean
    providerId?: string
    providerName?: string
    builtin?: boolean
  }>>
  saveModelPreset: (name: string, config: ModelConfigShape) => Promise<any>
  switchModelPreset: (id: string) => Promise<boolean>
  deleteModelPreset: (id: string) => Promise<any>
  listModelProviders: () => Promise<ModelProviderShape[]>
  updateModelProvider: (id: string, patch: Omit<Partial<ModelProviderShape>, 'thinkingFormat' | 'thinkingBudgets'> & {
    thinkingFormat?: ModelProviderShape['thinkingFormat'] | 'auto'
    thinkingBudgets?: ThinkingBudgets | null | 'auto'
  }) => Promise<{ ok: boolean }>
  getModelProviderFull: (id: string) => Promise<ModelProviderShape | null>
  getModelPresetFull: (id: string) => Promise<{
    id: string
    name: string
    config: ModelConfigShape
    rawConfig: ModelConfigShape
    providerId?: string
    builtin?: boolean
  } | null>
  updateModelPreset: (id: string, name: string, config: ModelConfigShape) => Promise<any>
  isCustomConfig: () => Promise<{ isCustom: boolean }>
  // 同传目标语言(interpreter 角色;源自动识别)
  getInterpretLangs: () => Promise<{ targetLanguages: string[]; current: string }>
  setInterpretTarget: (target: string) => Promise<{ ok: boolean }>
  archiveTranscript: (title: string, content: string) => Promise<{ ok: boolean; path?: string }>
  clearModelConfig: () => Promise<any>
  // 搜索服务（web_search）—— 展示口径：apiKey 恒掩码；builtin=内置回退；configured=生效配置有 key
  getSearchConfig: () => Promise<SearchConfigDisplayShape>
  saveSearchConfig: (config: SearchConfigShape) => Promise<{ ok: boolean }>
  clearSearchConfig: () => Promise<{ ok: boolean }>
  testSearchConnection: (apiKey?: string) => Promise<{ ok: boolean; errorKey?: string; errorParams?: Record<string, string> }>
  // Realtime Voice
  getRealtimeConfig: () => Promise<{
    provider: string
    url: string
    model: string
    deployment: string
    apiVersion: string
    voice: string
    hasKey: boolean
  }>
  getVoiceConfig: () => Promise<{
    provider: string
    baseUrl: string
    apiKey: string
    model: string
    deployment?: string
    apiVersion?: string
    voice?: string
  }>
  saveVoiceConfig: (config: {
    provider: string
    baseUrl: string
    apiKey: string
    model: string
    deployment?: string
    apiVersion?: string
    voice?: string
  }) => Promise<{ ok: boolean }>
  testVoiceConnection: (config: {
    provider: string
    baseUrl: string
    apiKey: string
    model: string
    deployment?: string
    apiVersion?: string
    voice?: string
  }) => Promise<{ ok: boolean; error?: string }>
  startRealtime: (ctx?: { conversationId?: string; agentId?: string; workspaceId?: string; conversationConfig?: any }) => Promise<{ success: boolean; error?: string }>
  stopRealtime: () => void
  sendRealtimeEvent: (event: any) => void
  onRealtimeEvent: (callback: (event: any) => void) => () => void
  onRealtimeState: (callback: (state: string) => void) => () => void
  // 导出对话
  saveMarkdownDialog: (defaultName: string) => Promise<string | null>
  writeTextFile: (filePath: string, content: string) => Promise<any>
  // 工作目录
  selectDirectory: () => Promise<string | null>
  getWorkingDir: () => Promise<string>
  setWorkingDir: (dir: string) => Promise<void>
  // 权限审批
  onPermissionRequest: (callback: (request: { requestId: string; tool: string; args: any; risk: string; reason: string }) => void) => () => void
  respondPermission: (requestId: string, approved: boolean) => void
  // 内联权限请求（会话流模式）
  onPermissionRequestInline?: (callback: (request: { requestId: string; tool: string; args: any; risk: string; reason: string; conversationId?: string; executionId?: string }) => void) => () => void
  respondPermissionInline?: (requestId: string, approved: boolean, sessionApprove?: boolean, executionId?: string, conversationId?: string) => void
  onArtifact?: (callback: (conversationId: string, artifact: { id: string; type: string; title: string; content: string; language?: string }, toolCallId?: string) => void) => () => void
  /** MCP App inline 渲染:挂到当前 mcp_execute 工具消息上 */
  onMcpAppInline?: (callback: (conversationId: string, data: { messageId: string; payload: any }) => void) => () => void
  // Goal slash 命令
  setGoal?: (conversationId: string, text: string) => void
  clearGoal?: (conversationId: string) => void
  showGoal?: (conversationId: string) => void
  /** 通用 artifact 状态广播(upsert / removed=true 时移除) */
  onArtifactUpdate?: (callback: (conversationId: string, artifact: { id: string; type: string; title: string; content: string; removed?: boolean }) => void) => () => void
  /** 上下文用量圆环：每次 LLM 调用后发一次 */
  onContextUsage?: (callback: (conversationId: string, data: { promptTokens: number; contextWindow: number; budget: number; compacted: boolean }) => void) => () => void
  // 对话标题更新通知
  onTitleUpdated?: (callback: (id: string, title: string) => void) => () => void
  // Agent 模板
  listAgentTemplates?: () => Promise<any[]>
  getAgentTemplate?: (id: string) => Promise<any>
  createAgentTemplate?: (data: any) => Promise<any>
  updateAgentTemplate?: (id: string, data: any) => Promise<any>
  deleteAgentTemplate?: (id: string) => Promise<any>
  // Agent Workspace
  listAgentWorkspaces?: () => Promise<any[]>
  getAgentWorkspace?: (id: string) => Promise<any>
  createAgentFromConversation?: (conversationId: string) => Promise<any>
  deleteAgentWorkspace?: (id: string) => Promise<any>
  /** 全局作品文件索引；只在用户打开作品时调用。 */
  listOutputHistory?: () => Promise<Array<{
    name: string
    path: string
    size: number
    updatedAt: number
    ext: string
    scope: 'global' | 'agent'
    workspaceId?: string
    workspaceName?: string
  }>>
  /** 启动/停止工作区目录 fs.watch 推送（dirKey 形如 'outputs:<workspaceId>' / 'tree:<workspaceId>'，workspaceId 空串=全局） */
  watchWorkspaceStart?: (dirKey: string) => Promise<{ ok: boolean }>
  watchWorkspaceStop?: (dirKey: string) => Promise<{ ok: boolean }>
  /** dirKey 对应目录发生变化时推送（callback 收到的是变化的 dirKey） */
  onWorkspaceChanged?: (callback: (dir: string) => void) => () => void
  // 统一任务 CRUD（全局 + workspace 任务共用）
  listTasks?: (filter?: { workspaceId?: string; enabledOnly?: boolean }) => Promise<any[]>
  getTask?: (id: string) => Promise<any>
  createTask?: (data: any) => Promise<any>
  updateTask?: (id: string, updates: any) => Promise<any>
  deleteTask?: (id: string) => Promise<any>
  toggleTask?: (id: string, enabled: boolean) => Promise<any>
  triggerTaskNow?: (id: string) => Promise<{ ok: boolean; error?: string }>
  onTaskExecuted?: (callback: (taskId: string, result: any, silent?: boolean) => void) => () => void
  // 记忆更新通知
  onMemoryUpdated?: (callback: (event: {
    type: 'extracted' | 'dreamed'
    memories?: Array<{ name: string; type: string; scope: string }>
    actionsApplied?: number
    summary?: string
  }) => void) => () => void
  // 会话级权限
  /** 不传 = 全清；传 conversationId 只清该会话（多会话并发下别误伤后台会话） */
  clearSessionApprovals?: (conversationId?: string) => void
  // MCP 服务器管理 — config 二选一:stdio(command/args/env)或 remote(url/headers)
  listMcpServers: () => Promise<Array<{ name: string; config: McpServerConfigDTO; connected: boolean; toolCount: number; builtIn: boolean; error?: string }>>
  /** 窗口解锁后 MCP 连接在后台并行进行，每个 server 连接完成(成败都算)推一次最新列表(同 listMcpServers 的返回形状) */
  onMcpServersUpdated: (callback: (status: Array<{ name: string; config: McpServerConfigDTO; connected: boolean; toolCount: number; builtIn: boolean; error?: string }>) => void) => () => void
  addMcpServer: (name: string, config: McpServerConfigDTO) => Promise<any>
  removeMcpServer: (name: string) => Promise<any>
  testMcpServer: (config: McpServerConfigDTO) => Promise<{ ok: boolean; toolCount?: number; error?: string }>
  /** 触发 OAuth 授权流(打开外部浏览器,等用户在 web 端完成,回调到 localhost:3033 后自动完成连接) */
  authorizeMcpServer: (name: string) => Promise<{ ok: boolean; error?: string }>
  /** 撤销该 server 的 OAuth 授权(删 token + 断开) */
  revokeMcpServerAuth: (name: string) => Promise<{ ok: boolean }>
  /** MCP Apps: iframe 内的 App 通过此方法反向调用同一 server 的工具 */
  callMcpFromApp: (serverName: string, serverBinding: string, toolName: string, args: Record<string, unknown>, conversationId?: string) => Promise<{
    ok: boolean
    /** 文本拼接(向后兼容) */
    result?: string
    /** ContentBlock 数组 — 推回 iframe 的 result.content */
    content?: any[]
    /** typed 结构化数据 — 推回 iframe 的 result.structuredContent */
    structuredContent?: any
    error?: string
  }>
  /** MCP App 权限:返回某 server 已授予的能力列表(microphone/camera 等) */
  getMcpAppPerms: (serverName: string, serverBinding: string, conversationId?: string) => Promise<string[]>
  /** MCP App 权限:用户在确认 UI 点 "允许" 后,把请求列表持久化授权 */
  approveMcpAppPerms: (serverName: string, serverBinding: string, requested: string[], conversationId?: string) => Promise<string[]>
  // CLI 工具管理
  listCliTools: () => Promise<Array<{ name: string; command: string; description: string; category: string; builtIn: boolean; installed?: boolean; version?: string }>>
  addCliTool: (tool: { name: string; command: string; description: string; category?: string }) => Promise<any>
  removeCliTool: (command: string) => Promise<any>
  validateCliTool: (command: string) => Promise<boolean>
  refreshCliTools: () => Promise<any[]>
  // Skills 管理
  // workspaceId 传入时只列该独立智能体自有目录的技能（隔离，不含全局）；不传 = 全局清单
  listSkills: (workspaceId?: string) => Promise<Array<{ name: string; description: string; category?: string; dir: string; builtIn: boolean; enabled: boolean; mcpServer?: string; pluginName?: string; source: 'builtin' | 'user' | 'plugin' | 'mcp' }>>
  setSkillDisabled: (name: string, disabled: boolean) => Promise<any>
  getSkillDetails: (name: string) => Promise<any>
  /** 技能导入 —— 扫描候选（本地文件夹 / GitHub 仓库），返回 scanId + 候选列表供用户勾选确认 */
  importScanSkills: (source: { type: 'folder'; path: string } | { type: 'github'; url: string }) => Promise<
    | { ok: true; scanId: string; candidates: Array<{ name: string; description: string; conflict: 'none' | 'user' | 'builtin' | 'plugin' | 'mcp' }> }
    | { ok: false; error: string }
  >
  /** 技能导入 —— 用户确认后按 scanId + 勾选名单写入；overwrite 控制是否覆盖同名的已有用户技能 */
  importApplySkills: (payload: { scanId: string; names: string[]; overwrite: boolean }) => Promise<
    | { ok: true; installed: string[]; skipped: string[] }
    | { ok: false; error: string }
  >
  /** 删除用户导入/自建技能（builtin / plugin / mcp 来源不适用） */
  deleteSkill: (name: string) => Promise<{ ok: true } | { ok: false; error: string }>
  // Agent Plugins 插件管理（标准包:plugin.json + skills/ + mcp.json）
  listPlugins: () => Promise<Array<{ name: string; dir: string; version?: string; description?: string; author?: string; enabled: boolean; skillNames: string[]; mcpServerNames: string[]; warnings: string[]; invalid?: string }>>
  /** 一次调用完成 定位→校验→落盘→刷新;同名冲突返回 needsOverwrite,UI 确认后带 overwrite 重调 */
  installPlugin: (source: { type: 'folder'; path: string } | { type: 'github'; url: string }, opts?: { overwrite?: boolean }) => Promise<
    | { ok: true; installed: Array<{ name: string; version?: string; skillCount: number; mcpServerCount: number; warnings: string[] }>; skipped: Array<{ name: string; reason: string }> }
    | { ok: false; error: string; needsOverwrite?: boolean; conflictNames?: string[] }
  >
  uninstallPlugin: (name: string) => Promise<{ ok: boolean; error?: string }>
  setPluginDisabled: (name: string, disabled: boolean) => Promise<any>
  // 文件操作
  openFile: (filePath: string) => Promise<string>
  revealFile: (filePath: string) => Promise<void>
  // 文件上传解析
  openFileDialog: (accept?: 'image' | 'document' | 'any' | 'folder') => Promise<string[] | null>
  parseFile: (filePath: string) => Promise<{ fileName: string; fileType: string; textContent: string; sizeBytes: number }>
  // Sources（Cave 模式资料区）—— ~/.openpipal/workspace/sources/<id>/
  listSources: () => Promise<Source[]>
  getSource: (id: string) => Promise<Source | null>
  addSource: (params: AddSourceParams) => Promise<Source>
  removeSource: (id: string) => Promise<{ ok: boolean; error?: string }>
  updateSourceStatus: (id: string, status: SourceStatus, patch?: SourceStatusPatch) => Promise<Source | null>
}

type SourceType = 'pdf' | 'md' | 'html' | 'txt' | 'image' | 'url' | 'other'
type SourceStatus = 'pending' | 'ingesting' | 'ready' | 'failed'

interface Source {
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
  citationIndex?: number
  errorMessage?: string
}

interface AddSourceParams {
  title: string
  type: SourceType
  filePath?: string
  content?: string
  sourceUrl?: string
}

interface SourceStatusPatch {
  extractedFile?: string
  thumbnailFile?: string
  summary?: string
  errorMessage?: string
}

declare global {
  interface Window {
    electron: ElectronAPI
    api: OpenPipalAPI
  }
}
