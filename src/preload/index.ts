import type { UpdateCheckResult } from '../shared/update-contract'
import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type { LocalePreference, LocaleState } from '../shared/i18n/contract'
import { parseAcpStatus, type AcpStatus } from '../shared/acp-status-contract'
import {
  parseAppFollowingUpdateResult,
  parseAppListUpdateResult,
  parseAppSettingsState,
  type AppFollowingUpdateResult,
  type AppSettingsState
} from '../shared/app-following-contract'

interface TranscriptPersistenceRequest {
  conversationId: string
  executionId: string
}

let transcriptPersistenceListenerCount = 0

// 设计系统画廊 manifest 形状（本地声明，与 main 侧 role-manager 契约对齐，不跨 bundle import）
interface DsCardMeta { rel: string; name: string; subtitle?: string; group: string; w: number; h: number }
interface DsKitMeta { rel: string; label: string }
interface DsFileNode { name: string; rel: string; kind: 'dir' | 'file'; size?: number; mtime?: number; children?: DsFileNode[] }
interface DesignSystemManifest {
  name: string
  title: string
  description?: string
  path: string
  groups: { group: string; cards: DsCardMeta[] }[]
  kits: DsKitMeta[]
  readme?: string
  files: DsFileNode[]
}

const api = {
  sendChat: (messages: Array<{ role: string; content: string; screenshot?: string; imagePaths?: string[]; toolName?: string; toolCallId?: string; toolArgs?: string }>, agentId?: string, conversationConfig?: any, conversationId?: string, workspaceId?: string): void => {
    ipcRenderer.send('chat:send', messages, agentId, conversationConfig, conversationId, workspaceId)
  },
  abortChat: (conversationId?: string): void => {
    ipcRenderer.send('chat:abort', conversationId)
  },
  // 消息插队（mid-loop injection）
  // 立即软打断：当前 step 跑完，下一轮 LLM call 前注入消息
  steerChat: (conversationId: string, text: string, images?: string[]): Promise<{ ok: boolean }> => {
    return ipcRenderer.invoke('chat:steer', conversationId, text, images)
  },
  // 跟单：等 agent 自然停止前注入消息
  queueChat: (conversationId: string, text: string, images?: string[]): Promise<{ ok: boolean }> => {
    return ipcRenderer.invoke('chat:queue', conversationId, text, images)
  },
  onStreamChunk: (callback: (conversationId: string, chunk: string) => void): (() => void) => {
    const handler = (_e: Electron.IpcRendererEvent, cid: string, chunk: string): void => callback(cid, chunk)
    ipcRenderer.on('chat:stream-chunk', handler)
    return () => ipcRenderer.removeListener('chat:stream-chunk', handler)
  },
  onStreamEnd: (callback: (conversationId: string, error?: string) => void): (() => void) => {
    const handler = (_e: Electron.IpcRendererEvent, cid: string, error?: string): void => callback(cid, error)
    ipcRenderer.on('chat:stream-end', handler)
    return () => ipcRenderer.removeListener('chat:stream-end', handler)
  },
  /**
   * Main-process lease barrier: run the renderer-owned transcript flush, then
   * acknowledge the exact execution. Optional at the Window API boundary so
   * browser/older renderer shims keep working unchanged.
   */
  onTranscriptPersistenceRequest: (
    callback: (conversationId: string, executionId: string) => Promise<void>
  ): (() => void) => {
    const handler = (_e: Electron.IpcRendererEvent, request: TranscriptPersistenceRequest): void => {
      if (!request || typeof request.conversationId !== 'string' || typeof request.executionId !== 'string') return
      Promise.resolve(callback(request.conversationId, request.executionId)).then(
        () => ipcRenderer.send('chat:transcript-persistence-ack', { ...request, ok: true }),
        (error: unknown) => ipcRenderer.send('chat:transcript-persistence-ack', {
          ...request,
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        })
      )
    }
    ipcRenderer.on('chat:transcript-persistence-request', handler)
    transcriptPersistenceListenerCount += 1
    if (transcriptPersistenceListenerCount === 1) ipcRenderer.send('chat:transcript-persistence-ready')
    let disposed = false
    return () => {
      if (disposed) return
      disposed = true
      ipcRenderer.removeListener('chat:transcript-persistence-request', handler)
      transcriptPersistenceListenerCount = Math.max(0, transcriptPersistenceListenerCount - 1)
      if (transcriptPersistenceListenerCount === 0) ipcRenderer.send('chat:transcript-persistence-unready')
    }
  },
  onAskUser: (
    callback: (conversationId: string, question: string, options: { label: string; value: string }[], fields?: any[]) => void
  ): (() => void) => {
    const handler = (
      _e: Electron.IpcRendererEvent, cid: string,
      question: string, options: { label: string; value: string }[], fields?: any[]
    ): void => callback(cid, question, options, fields)
    ipcRenderer.on('chat:ask-user', handler)
    return () => ipcRenderer.removeListener('chat:ask-user', handler)
  },
  onQuestionsV2: (
    callback: (conversationId: string, title: string, questions: any[]) => void
  ): (() => void) => {
    const handler = (
      _e: Electron.IpcRendererEvent, cid: string,
      title: string, questions: any[]
    ): void => callback(cid, title, questions)
    ipcRenderer.on('chat:questions-v2', handler)
    return () => ipcRenderer.removeListener('chat:questions-v2', handler)
  },
  onQuestionsV2Delta: (
    callback: (conversationId: string, data: { id: string; title?: string; questions: any[] }) => void
  ): (() => void) => {
    const handler = (
      _e: Electron.IpcRendererEvent, cid: string,
      data: { id: string; title?: string; questions: any[] }
    ): void => callback(cid, data)
    ipcRenderer.on('chat:questions-v2-delta', handler)
    return () => ipcRenderer.removeListener('chat:questions-v2-delta', handler)
  },
  onThinking: (callback: (conversationId: string, content: string) => void): (() => void) => {
    const handler = (_e: Electron.IpcRendererEvent, cid: string, content: string): void => callback(cid, content)
    ipcRenderer.on('chat:thinking', handler)
    return () => ipcRenderer.removeListener('chat:thinking', handler)
  },
  onThinkingEnd: (callback: (conversationId: string) => void): (() => void) => {
    const handler = (_e: Electron.IpcRendererEvent, cid: string): void => callback(cid)
    ipcRenderer.on('chat:thinking-end', handler)
    return () => ipcRenderer.removeListener('chat:thinking-end', handler)
  },
  onStreamRetry: (callback: (conversationId: string, attempt: number, maxRetries: number) => void): (() => void) => {
    const handler = (_e: Electron.IpcRendererEvent, cid: string, attempt: number, maxRetries: number): void => callback(cid, attempt, maxRetries)
    ipcRenderer.on('chat:stream-retry', handler)
    return () => ipcRenderer.removeListener('chat:stream-retry', handler)
  },
  onToolProgress: (callback: (conversationId: string, name: string, chars: number, path?: string) => void): (() => void) => {
    const handler = (_e: Electron.IpcRendererEvent, cid: string, name: string, chars: number, path?: string): void => callback(cid, name, chars, path)
    ipcRenderer.on('chat:tool-progress', handler)
    return () => ipcRenderer.removeListener('chat:tool-progress', handler)
  },
  onTextFlush: (callback: (conversationId: string) => void): (() => void) => {
    const handler = (_e: Electron.IpcRendererEvent, cid: string): void => callback(cid)
    ipcRenderer.on('chat:text-flush', handler)
    return () => ipcRenderer.removeListener('chat:text-flush', handler)
  },
  onToolStart: (callback: (conversationId: string, name: string, toolCallId?: string) => void): (() => void) => {
    const handler = (_e: Electron.IpcRendererEvent, cid: string, name: string, toolCallId?: string): void => callback(cid, name, toolCallId)
    ipcRenderer.on('chat:tool-start', handler)
    return () => ipcRenderer.removeListener('chat:tool-start', handler)
  },
  // 上下文用量圆环/信息卡：每次 LLM 调用后发一次，promptTokens=input+cacheRead+cacheWrite；
  // usage/segments 供卡片累计命中率与分区占比（可选，旧主进程不发送）
  onContextUsage: (
    callback: (conversationId: string, data: {
      promptTokens: number; contextWindow: number; budget: number; compacted: boolean
      usage?: { input: number; cacheRead: number; cacheWrite: number }
      segments?: { systemPrompt: number; skills: number; toolsBuiltin: number; toolsMcp: number; messages: number }
    }) => void
  ): (() => void) => {
    const handler = (_e: Electron.IpcRendererEvent, cid: string, data: any): void => callback(cid, data)
    ipcRenderer.on('context-usage', handler)
    return () => ipcRenderer.removeListener('context-usage', handler)
  },
  // runtime-context 快照原文：渲染层据此落盘隐藏消息，保证下轮回放与实发字节一致
  onRuntimeContext: (callback: (conversationId: string, text: string) => void): (() => void) => {
    const handler = (_e: Electron.IpcRendererEvent, cid: string, text: string): void => callback(cid, text)
    ipcRenderer.on('runtime-context', handler)
    return () => ipcRenderer.removeListener('runtime-context', handler)
  },
  // 今日按模型用量/成本（卡片展开时拉一次；聚合在读侧，见 usage-log.ts）
  getTodayUsage: (): Promise<Array<{ model: string; prompt: number; output: number; cacheRead: number; calls: number; cost: number }>> =>
    ipcRenderer.invoke('usage:get-today'),
  onToolEnd: (
    callback: (
      conversationId: string, name: string,
      screenshot?: string, searchResults?: string, mcpResult?: string, mcpArgs?: string,
      visualizer?: { id: string; type: 'html' | 'svg' | 'chart'; title: string; content: string; height?: number },
      toolCallId?: string,
      modelToolArgs?: string
    ) => void
  ): (() => void) => {
    const handler = (
      _e: Electron.IpcRendererEvent, cid: string,
      name: string, screenshot?: string, searchResults?: string, mcpResult?: string, mcpArgs?: string,
      visualizer?: { id: string; type: 'html' | 'svg' | 'chart'; title: string; content: string; height?: number },
      toolCallId?: string, modelToolArgs?: string
    ): void => callback(cid, name, screenshot, searchResults, mcpResult, mcpArgs, visualizer, toolCallId, modelToolArgs)
    ipcRenderer.on('chat:tool-end', handler)
    return () => ipcRenderer.removeListener('chat:tool-end', handler)
  },
  onTargetStatus: (
    callback: (status: { connected: boolean; appName?: string; windowTitle?: string; isFullscreen?: boolean }) => void
  ): (() => void) => {
    const handler = (
      _e: Electron.IpcRendererEvent,
      status: { connected: boolean; appName?: string; windowTitle?: string; isFullscreen?: boolean }
    ): void => callback(status)
    ipcRenderer.on('target:status', handler)
    return () => ipcRenderer.removeListener('target:status', handler)
  },
  pasteToTarget: (text: string): Promise<{ success: boolean; error?: string }> => {
    return ipcRenderer.invoke('paste-to-target', text)
  },
  // 本地 STT — whisper.cpp
  checkForUpdate: (): Promise<UpdateCheckResult> => ipcRenderer.invoke('app:check-update'),
  checkSTT: (): Promise<{ ready: boolean; reason?: string; reasonKey?: string; reasonParams?: Record<string, string | number> }> =>
    ipcRenderer.invoke('stt:check'),
  transcribeAudio: (wavBytes: ArrayBuffer): Promise<{ text?: string; error?: string; errorKey?: string; errorParams?: Record<string, string | number> }> =>
    ipcRenderer.invoke('stt:transcribe', wavBytes),
  onAppChanged: (
    callback: (appName: string, displayName: string) => void
  ): (() => void) => {
    const handler = (
      _e: Electron.IpcRendererEvent,
      appName: string,
      displayName: string
    ): void => callback(appName, displayName)
    ipcRenderer.on('target:app-changed', handler)
    return () => ipcRenderer.removeListener('target:app-changed', handler)
  },
  // 角色管理
  getRoleInitState: (): Promise<{ hasRole: boolean; role: any }> => {
    return ipcRenderer.invoke('role:get-init-state')
  },
  getAllRoles: (): Promise<any[]> => {
    return ipcRenderer.invoke('role:get-all')
  },
  getCurrentRole: (): Promise<any> => {
    return ipcRenderer.invoke('role:get-current')
  },
  switchRole: (roleName: string): Promise<any> => {
    return ipcRenderer.invoke('role:switch', roleName)
  },
  // 窗口按钮（Windows 自绘 — / ×；× 收进托盘）与不透明窗底色对齐
  minimizeWindow: (): Promise<void> => ipcRenderer.invoke('window:minimize'),
  hideWindow: (): Promise<void> => ipcRenderer.invoke('window:hide'),
  setWindowBackground: (variant: 'light' | 'dark'): Promise<{ ok: true; applied: boolean }> =>
    ipcRenderer.invoke('window:set-background', variant),
  // 设置
  getAppSettings: async (): Promise<AppSettingsState> => {
    return parseAppSettingsState(await ipcRenderer.invoke('settings:get-apps'))
  },
  setAppFollowingEnabled: async (enabled: boolean): Promise<AppFollowingUpdateResult> => {
    return parseAppFollowingUpdateResult(
      await ipcRenderer.invoke('settings:set-app-following-enabled', enabled),
      enabled
    )
  },
  setDisabledApps: async (apps: string[]): Promise<{ ok: true }> => {
    return parseAppListUpdateResult(await ipcRenderer.invoke('settings:set-disabled-apps', apps))
  },
  getAcpStatus: async (): Promise<AcpStatus> => {
    return parseAcpStatus(await ipcRenderer.invoke('acp:get-status'))
  },
  onAcpStatusChanged: (callback: () => void): (() => void) => {
    const handler = (): void => callback()
    ipcRenderer.on('acp:status-changed', handler)
    return () => ipcRenderer.removeListener('acp:status-changed', handler)
  },
  // 对话管理
  listConversations: (): Promise<any[]> => ipcRenderer.invoke('conv:list'),
  createConversation: (role: string, title?: string, agentId?: string, workspaceId?: string): Promise<any> => ipcRenderer.invoke('conv:create', role, title, agentId, workspaceId),
  getConversation: (id: string): Promise<any> => ipcRenderer.invoke('conv:get', id),
  getConversationMessages: (id: string): Promise<any[]> => ipcRenderer.invoke('conv:get-messages', id),
  appendMessages: (id: string, messages: any[]): Promise<any> => ipcRenderer.invoke('conv:append-messages', id, messages),
  saveConvAttachment: (cid: string, messageId: string, kind: 'screenshot' | 'mcpapp', content: string): Promise<string | null> =>
    ipcRenderer.invoke('conv:save-attachment', cid, messageId, kind, content),
  loadConvAttachment: (cid: string, ref: string): Promise<string | null> =>
    ipcRenderer.invoke('conv:load-attachment', cid, ref),
  replaceMessages: (id: string, messages: any[]): Promise<any> => ipcRenderer.invoke('conv:replace-messages', id, messages),
  deleteConversation: (id: string): Promise<any> => ipcRenderer.invoke('conv:delete', id),
  updateConversationTitle: (id: string, title: string): Promise<any> => ipcRenderer.invoke('conv:update-title', id, title),
  updateConversationRole: (id: string, role: string): Promise<boolean> => ipcRenderer.invoke('conv:update-role', id, role),
  updateConversationConfig: (id: string, config: any): Promise<any> => ipcRenderer.invoke('conv:update-config', id, config),
  // 模型配置
  getModelConfig: (): Promise<any> => ipcRenderer.invoke('config:get-model'),
  getModelConfigFull: (): Promise<any> => ipcRenderer.invoke('config:get-model-full'),
  saveModelConfig: (config: any): Promise<any> => ipcRenderer.invoke('config:save-model', config),
  testConnection: (config: any): Promise<any> => ipcRenderer.invoke('config:test-connection', config),
  detectContextWindow: (config: any): Promise<{ window: number; source: string } | null> =>
    ipcRenderer.invoke('config:detect-context-window', config),
  listRemoteModels: (config: any): Promise<any> => ipcRenderer.invoke('config:list-remote-models', config),
  testThinkingSupport: (config: any): Promise<{ detected: boolean; error?: string }> => ipcRenderer.invoke('config:test-thinking', config),
  getProviders: (): Promise<any> => ipcRenderer.invoke('config:get-providers'),
  hasApiKey: (): Promise<{ hasKey: boolean }> => ipcRenderer.invoke('config:has-key'),
  getAvailableModels: (): Promise<Array<{ id: string; name: string; model: string; active: boolean; supportsThinking: boolean; supportsEffortDial: boolean; thinkingAlwaysOn: boolean; thinkingLevels: Array<'low' | 'medium' | 'high' | 'max'> }>> => ipcRenderer.invoke('config:available-models'),
  /** 主进程读剪贴板图片（NSPasteboard 原生 flavor，覆盖 TIFF-only 等 DOM 剪贴板看不见的来源）；无图返回 null */
  readClipboardImage: (): Promise<string | null> => ipcRenderer.invoke('clipboard:read-image'),
  /** 随消息图片落盘到本会话 artifacts/uploads/（官方形状），返回相对路径列表 */
  persistChatImages: (conversationId: string, images: string[]): Promise<string[]> =>
    ipcRenderer.invoke('chat:persist-images', conversationId, images),
  /** 读会话 uploads 单资源（srcdoc 预览内联 data URI 用） */
  readUploadAsset: (conversationId: string, name: string): Promise<{ base64: string; mime: string } | null> =>
    ipcRenderer.invoke('artifact:read-upload', conversationId, name),
  /** 产物 sidecar（*.state.json）写入——iframe 内 window.openpipal.writeFile 的宿主端 */
  writeArtifactSidecar: (conversationId: string, name: string, content: string): Promise<boolean> =>
    ipcRenderer.invoke('artifact:write-sidecar', conversationId, name, content),
  /** 产物 sidecar 读取（预览水合 fetch 垫片的数据源） */
  readArtifactSidecar: (conversationId: string, name: string): Promise<string | null> =>
    ipcRenderer.invoke('artifact:read-sidecar', conversationId, name),
  /** Electron 32+ 移除了 File.path——拖放/粘贴的文件取真实路径必须走 webUtils（仅 preload 可用） */
  getPathForFile: (file: File): string => webUtils.getPathForFile(file),
  saveModelPreset: (name: string, config: any): Promise<any> => ipcRenderer.invoke('config:save-preset', name, config),
  switchModelPreset: (id: string): Promise<boolean> => ipcRenderer.invoke('config:switch-preset', id),
  deleteModelPreset: (id: string): Promise<any> => ipcRenderer.invoke('config:delete-preset', id),
  listModelProviders: (): Promise<any[]> => ipcRenderer.invoke('config:list-model-providers'),
  updateModelProvider: (id: string, patch: any): Promise<{ ok: boolean }> => ipcRenderer.invoke('config:update-model-provider', id, patch),
  getModelProviderFull: (id: string): Promise<any> => ipcRenderer.invoke('config:get-model-provider', id),
  getModelPresetFull: (id: string): Promise<any> => ipcRenderer.invoke('config:get-preset', id),
  updateModelPreset: (id: string, name: string, config: any): Promise<any> => ipcRenderer.invoke('config:update-preset', id, name, config),
  isCustomConfig: (): Promise<{ isCustom: boolean }> => ipcRenderer.invoke('config:is-custom'),
  clearModelConfig: (): Promise<any> => ipcRenderer.invoke('config:clear-model'),
  // 搜索服务（web_search）—— 出口是展示口径：apiKey 恒掩码，builtin 标记内置回退
  getSearchConfig: (): Promise<{ provider: 'tavily'; apiKey: string; builtin: boolean; configured: boolean }> =>
    ipcRenderer.invoke('config:get-search'),
  saveSearchConfig: (config: { provider: 'tavily'; apiKey: string }): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('config:save-search', config),
  clearSearchConfig: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('config:clear-search'),
  testSearchConnection: (apiKey?: string): Promise<{ ok: boolean; errorKey?: string; errorParams?: Record<string, string> }> =>
    ipcRenderer.invoke('config:test-search', apiKey),
  // 冷启动引导
  getOnboardingStatus: (): Promise<{ completed: boolean }> => ipcRenderer.invoke('onboarding:status'),
  completeOnboarding: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('onboarding:complete'),
  openScreenRecordingPrefs: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('system:open-screen-recording-prefs'),
  // 界面语言（Main 统一解析 system 偏好并持久化）
  getLocaleState: (): Promise<LocaleState> => ipcRenderer.invoke('locale:get-state'),
  setLocalePreference: (preference: LocalePreference): Promise<LocaleState> =>
    ipcRenderer.invoke('locale:set-preference', preference),
  onLocaleChanged: (callback: (state: LocaleState) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, state: LocaleState): void => callback(state)
    ipcRenderer.on('locale:changed', handler)
    return () => ipcRenderer.removeListener('locale:changed', handler)
  },
  // Realtime Voice
  getRealtimeConfig: (): Promise<{
    provider: string
    url: string
    model: string
    deployment: string
    apiVersion: string
    voice: string
    hasKey: boolean
  }> => ipcRenderer.invoke('realtime:config'),
  getVoiceConfig: (): Promise<{
    provider: string
    baseUrl: string
    apiKey: string
    model: string
    deployment?: string
    apiVersion?: string
    voice?: string
  }> => ipcRenderer.invoke('voice:get-config'),
  saveVoiceConfig: (config: any): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('voice:save-config', config),
  testVoiceConnection: (config: any): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('voice:test-connection', config),
  // 音色试听:用临时配置 + voice 让模型读一句样例,音频通过 onVoicePreviewAudio 流式回来
  previewVoice: (config: any, voice: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('voice:preview', config, voice),
  stopVoicePreview: (): void => { ipcRenderer.send('voice:preview-stop') },
  // 语音音频留存(回听)
  saveVoiceAudio: (conversationId: string, itemId: string, role: string, base64Pcm: string): Promise<{ path?: string; error?: string }> =>
    ipcRenderer.invoke('voice:save-audio', conversationId, itemId, role, base64Pcm),
  readVoiceAudio: (path: string): Promise<{ base64?: string; error?: string }> =>
    ipcRenderer.invoke('voice:read-audio', path),
  // 语音会话结束时触发记忆提取(对齐文字模式)
  extractConversationMemory: (history: Array<{ role: string; content: string }>, conversationId: string): Promise<void> =>
    ipcRenderer.invoke('memory:extract-conversation', history, conversationId),
  onVoicePreviewAudio: (callback: (pcm16Base64: string) => void): (() => void) => {
    const handler = (_e: Electron.IpcRendererEvent, b64: string): void => callback(b64)
    ipcRenderer.on('voice:preview-audio', handler)
    return () => ipcRenderer.removeListener('voice:preview-audio', handler)
  },
  startRealtime: (ctx?: { conversationId?: string; agentId?: string; workspaceId?: string; conversationConfig?: any }): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('realtime:start', ctx),
  stopRealtime: (): void => { ipcRenderer.send('realtime:stop') },
  sendRealtimeEvent: (event: any): void => { ipcRenderer.send('realtime:send-event', event) },
  onRealtimeEvent: (callback: (event: any) => void): (() => void) => {
    const handler = (_e: Electron.IpcRendererEvent, event: any): void => callback(event)
    ipcRenderer.on('realtime:event', handler)
    return () => ipcRenderer.removeListener('realtime:event', handler)
  },
  onRealtimeState: (callback: (state: string) => void): (() => void) => {
    const handler = (_e: Electron.IpcRendererEvent, state: string): void => callback(state)
    ipcRenderer.on('realtime:state', handler)
    return () => ipcRenderer.removeListener('realtime:state', handler)
  },
  // 导出对话
  saveMarkdownDialog: (defaultName: string): Promise<string | null> => ipcRenderer.invoke('dialog:save-markdown', defaultName),
  writeTextFile: (filePath: string, content: string): Promise<any> => ipcRenderer.invoke('file:write-text', filePath, content),
  // 工作目录
  selectDirectory: (): Promise<string | null> => ipcRenderer.invoke('dialog:select-directory'),
  getWorkingDir: (): Promise<string> => ipcRenderer.invoke('config:get-working-dir'),
  setWorkingDir: (dir: string): Promise<{ ok: boolean; code?: string; error?: string; resolved?: string }> =>
    ipcRenderer.invoke('config:set-working-dir', dir),
  validateWorkingDir: (dir: string): Promise<{ ok: boolean; code?: string; reason?: string; resolved?: string }> =>
    ipcRenderer.invoke('config:validate-working-dir', dir),
  describeProjectContext: (
    dir: string
  ): Promise<{
    repoRoot: string | null
    files: Array<{ path: string; truncated: boolean }>
    droppedForBudget: string[]
  }> => ipcRenderer.invoke('config:describe-project-context', dir),
  // 权限审批（预留给 UI 弹窗组件使用）
  onPermissionRequest: (
    callback: (request: { requestId: string; tool: string; args: any; risk: string; reason: string }) => void
  ): (() => void) => {
    const handler = (_e: Electron.IpcRendererEvent, request: any): void => callback(request)
    ipcRenderer.on('agent:permission-request', handler)
    return () => ipcRenderer.removeListener('agent:permission-request', handler)
  },
  respondPermission: (requestId: string, approved: boolean): void => {
    ipcRenderer.send('agent:permission-response', { requestId, approved })
  },
  // 内联权限请求（会话流模式）
  onPermissionRequestInline: (
    callback: (request: { requestId: string; tool: string; args: any; risk: string; reason: string; conversationId?: string; executionId?: string }) => void
  ): (() => void) => {
    const handler = (_e: Electron.IpcRendererEvent, request: any): void => callback(request)
    ipcRenderer.on('permission:inline-request', handler)
    return () => ipcRenderer.removeListener('permission:inline-request', handler)
  },
  respondPermissionInline: (requestId: string, approved: boolean, sessionApprove?: boolean, executionId?: string, conversationId?: string): void => {
    ipcRenderer.send('permission:inline-response', { requestId, approved, sessionApprove, executionId, conversationId })
  },
  // 不传 conversationId = 全清（退出/重置类场景）；传了只清该会话，不误伤并发的其它会话
  clearSessionApprovals: (conversationId?: string): void => {
    ipcRenderer.send('permission:clear-session', conversationId)
  },
  onDreamStatus: (callback: (data: { status: string; detail?: string }) => void): (() => void) => {
    const handler = (_e: Electron.IpcRendererEvent, data: any): void => callback(data)
    ipcRenderer.on('dream:status', handler)
    return () => ipcRenderer.removeListener('dream:status', handler)
  },
  onArtifact: (callback: (conversationId: string, artifact: { id: string; type: string; title: string; content: string; language?: string }, toolCallId?: string) => void): (() => void) => {
    const handler = (_e: Electron.IpcRendererEvent, cid: string, artifact: any, toolCallId?: string): void => callback(cid, artifact, toolCallId)
    ipcRenderer.on('chat:artifact', handler)
    return () => ipcRenderer.removeListener('chat:artifact', handler)
  },
  onArtifactDelta: (callback: (conversationId: string, data: { id: string; title?: string; artifactType?: string; delta: string; offset: number }) => void): (() => void) => {
    const handler = (_e: Electron.IpcRendererEvent, cid: string, data: any): void => callback(cid, data)
    ipcRenderer.on('chat:artifact-delta', handler)
    return () => ipcRenderer.removeListener('chat:artifact-delta', handler)
  },
  onVisualizer: (callback: (conversationId: string, visualizer: { id: string; messageId: string; type: 'html' | 'svg' | 'chart'; title: string; content: string; height?: number }) => void): (() => void) => {
    const handler = (_e: Electron.IpcRendererEvent, cid: string, visualizer: any): void => callback(cid, visualizer)
    ipcRenderer.on('chat:visualizer', handler)
    return () => ipcRenderer.removeListener('chat:visualizer', handler)
  },
  onMcpAppInline: (callback: (conversationId: string, data: { messageId: string; payload: any }) => void): (() => void) => {
    const handler = (_e: Electron.IpcRendererEvent, cid: string, data: any): void => callback(cid, data)
    ipcRenderer.on('chat:mcp-app-inline', handler)
    return () => ipcRenderer.removeListener('chat:mcp-app-inline', handler)
  },
  // Goal slash 命令(用户输入侧的专用入口)
  setGoal: (conversationId: string, text: string): void => {
    ipcRenderer.send('chat:set-goal', conversationId, text)
  },
  clearGoal: (conversationId: string): void => {
    ipcRenderer.send('chat:clear-goal', conversationId)
  },
  showGoal: (conversationId: string): void => {
    ipcRenderer.send('chat:show-goal', conversationId)
  },
  // 通用 artifact 状态广播 — goal/未来其他非流式 artifact 状态更新都走这条
  // payload.removed=true 时表示移除该 artifact
  onArtifactUpdate: (
    callback: (cid: string, artifact: { id: string; type: string; title: string; content: string; removed?: boolean }) => void
  ): (() => void) => {
    const handler = (_e: Electron.IpcRendererEvent, cid: string, artifact: any): void => callback(cid, artifact)
    ipcRenderer.on('chat:artifact-update', handler)
    return () => ipcRenderer.removeListener('chat:artifact-update', handler)
  },
  onVisualizerDelta: (callback: (conversationId: string, data: { id: string; title?: string; delta: string; offset: number; height?: number }) => void): (() => void) => {
    const handler = (_e: Electron.IpcRendererEvent, cid: string, data: any): void => callback(cid, data)
    ipcRenderer.on('chat:visualizer-delta', handler)
    return () => ipcRenderer.removeListener('chat:visualizer-delta', handler)
  },
  // 对话标题更新通知
  onTitleUpdated: (callback: (id: string, title: string) => void): (() => void) => {
    const handler = (_e: Electron.IpcRendererEvent, id: string, title: string): void => callback(id, title)
    ipcRenderer.on('conv:title-updated', handler)
    return () => ipcRenderer.removeListener('conv:title-updated', handler)
  },
  // MCP 服务器管理
  listMcpServers: (): Promise<any[]> => ipcRenderer.invoke('mcp:list-servers'),
  // 窗口解锁后 MCP 连接在后台并行进行，每个 server 连接完成(成败都算)推一次最新列表
  onMcpServersUpdated: (callback: (status: any[]) => void): (() => void) => {
    const handler = (_e: Electron.IpcRendererEvent, status: any[]): void => callback(status)
    ipcRenderer.on('mcp:servers-updated', handler)
    return () => ipcRenderer.removeListener('mcp:servers-updated', handler)
  },
  addMcpServer: (name: string, config: any): Promise<any> => ipcRenderer.invoke('mcp:add-server', name, config),
  removeMcpServer: (name: string): Promise<any> => ipcRenderer.invoke('mcp:remove-server', name),
  testMcpServer: (config: any): Promise<any> => ipcRenderer.invoke('mcp:test-server', config),
  // OAuth: 用户主动触发授权(打开浏览器)/ 撤销
  authorizeMcpServer: (name: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('mcp:authorize', name),
  revokeMcpServerAuth: (name: string): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('mcp:revoke-auth', name),
  // MCP Apps: iframe 反向调用(仅限来源 server 的工具,主进程再做安全分类)
  callMcpFromApp: (serverName: string, serverBinding: string, toolName: string, args: any, conversationId?: string): Promise<any> =>
    ipcRenderer.invoke('mcp:call-from-app', serverName, serverBinding, toolName, args, conversationId),
  // MCP App 权限管理(microphone / camera / clipboard 等)
  getMcpAppPerms: (serverName: string, serverBinding: string, conversationId?: string): Promise<string[]> =>
    ipcRenderer.invoke('mcp-app:get-perms', serverName, serverBinding, conversationId),
  approveMcpAppPerms: (serverName: string, serverBinding: string, requested: string[], conversationId?: string): Promise<string[]> =>
    ipcRenderer.invoke('mcp-app:approve-perms', serverName, serverBinding, requested, conversationId),
  // CLI 工具管理
  listCliTools: (): Promise<any[]> => ipcRenderer.invoke('cli:list'),
  addCliTool: (tool: any): Promise<any> => ipcRenderer.invoke('cli:add', tool),
  removeCliTool: (command: string): Promise<any> => ipcRenderer.invoke('cli:remove', command),
  validateCliTool: (command: string): Promise<boolean> => ipcRenderer.invoke('cli:validate', command),
  refreshCliTools: (): Promise<any[]> => ipcRenderer.invoke('cli:refresh'),
  // Skills 管理
  // workspaceId 传入时只列该独立智能体自有目录的技能（隔离，不含全局）；不传 = 全局清单（原行为）
  listSkills: (workspaceId?: string): Promise<any[]> => ipcRenderer.invoke('skills:list', workspaceId),
  setSkillDisabled: (name: string, disabled: boolean): Promise<any> => ipcRenderer.invoke('skills:set-disabled', name, disabled),
  getSkillDetails: (name: string): Promise<any> => ipcRenderer.invoke('skills:get-details', name),
  // Skills 导入：扫描候选（本地文件夹 / GitHub 仓库）→ 用户勾选确认后写入
  importScanSkills: (source: { type: 'folder'; path: string } | { type: 'github'; url: string }): Promise<any> =>
    ipcRenderer.invoke('skills:import-scan', source),
  importApplySkills: (payload: { scanId: string; names: string[]; overwrite: boolean }): Promise<any> =>
    ipcRenderer.invoke('skills:import-apply', payload),
  deleteSkill: (name: string): Promise<any> => ipcRenderer.invoke('skills:delete', name),
  // Agent Plugins 插件管理（标准包:plugin.json + skills/ + mcp.json）
  listPlugins: (): Promise<any[]> => ipcRenderer.invoke('plugins:list'),
  installPlugin: (source: { type: 'folder'; path: string } | { type: 'github'; url: string }, opts?: { overwrite?: boolean }): Promise<any> =>
    ipcRenderer.invoke('plugins:install', source, opts),
  uninstallPlugin: (name: string): Promise<any> => ipcRenderer.invoke('plugins:uninstall', name),
  setPluginDisabled: (name: string, disabled: boolean): Promise<any> => ipcRenderer.invoke('plugins:set-disabled', name, disabled),
  // Agent 模板
  listAgentTemplates: (): Promise<any[]> => ipcRenderer.invoke('agent:list'),
  getAgentTemplate: (id: string): Promise<any> => ipcRenderer.invoke('agent:get', id),
  createAgentTemplate: (data: any): Promise<any> => ipcRenderer.invoke('agent:create', data),
  updateAgentTemplate: (id: string, data: any): Promise<any> => ipcRenderer.invoke('agent:update', id, data),
  deleteAgentTemplate: (id: string): Promise<any> => ipcRenderer.invoke('agent:delete', id),
  // Agent Workspace
  listAgentWorkspaces: (): Promise<any[]> => ipcRenderer.invoke('workspace:list'),
  getAgentWorkspace: (id: string): Promise<any> => ipcRenderer.invoke('workspace:get', id),
  createAgentFromConversation: (conversationId: string): Promise<any> => ipcRenderer.invoke('workspace:create-from-conversation', conversationId),
  deleteAgentWorkspace: (id: string): Promise<any> => ipcRenderer.invoke('workspace:delete', id),
  /** 列产物目录（workspaceId 空=全局 outputs/，有值=该 agent outputs/） */
  listAgentOutputs: (workspaceId?: string): Promise<Array<{ name: string; path: string; size: number; mtime: number; ext: string }>> =>
    ipcRenderer.invoke('workspace:list-outputs', workspaceId),
  /** 全局作品索引（全局 + 各 Agent 的 outputs）；不会用于会话内摘要。 */
  listOutputHistory: (): Promise<Array<{ name: string; path: string; size: number; updatedAt: number; ext: string; scope: 'global' | 'agent'; workspaceId?: string; workspaceName?: string }>> =>
    ipcRenderer.invoke('workspace:list-output-history'),
  /** 获取 Agent / 全局产物目录的完整 tree（多层，workspaceId 空时 = 全局 outputs/） */
  getAgentTree: (workspaceId?: string): Promise<any> =>
    ipcRenderer.invoke('workspace:get-agent-tree', workspaceId),
  /** 启动/停止工作区目录 fs.watch 推送（dirKey 形如 'outputs:<workspaceId>' / 'tree:<workspaceId>'，workspaceId 空串=全局） */
  watchWorkspaceStart: (dirKey: string): Promise<{ ok: boolean }> => ipcRenderer.invoke('workspace:watch-start', dirKey),
  watchWorkspaceStop: (dirKey: string): Promise<{ ok: boolean }> => ipcRenderer.invoke('workspace:watch-stop', dirKey),
  /** dirKey 对应目录发生变化时推送（callback 收到的是变化的 dirKey，调用方自行比对是否是自己订阅的那个） */
  onWorkspaceChanged: (callback: (dir: string) => void): (() => void) => {
    const handler = (_e: Electron.IpcRendererEvent, data: { dir: string }): void => callback(data.dir)
    ipcRenderer.on('workspace:changed', handler)
    return () => ipcRenderer.removeListener('workspace:changed', handler)
  },
  /** 读文件用于 workspace 预览（文本或 base64） */
  readFileForPreview: (filePath: string, mode: 'text' | 'base64' = 'text'): Promise<{ ok: boolean; data?: string; size?: number; mtime?: number; error?: string }> =>
    ipcRenderer.invoke('file:read-for-preview', filePath, mode),
  // revealFile / openFile 已在下方通用文件操作段落定义（不要重复）
  // 统一任务 CRUD（全局 + workspace 任务共用）
  listTasks: (filter?: { workspaceId?: string; enabledOnly?: boolean }): Promise<any[]> => ipcRenderer.invoke('task:list', filter),
  getTask: (id: string): Promise<any> => ipcRenderer.invoke('task:get', id),
  createTask: (data: any): Promise<any> => ipcRenderer.invoke('task:create', data),
  updateTask: (id: string, updates: any): Promise<any> => ipcRenderer.invoke('task:update', id, updates),
  deleteTask: (id: string): Promise<any> => ipcRenderer.invoke('task:delete', id),
  toggleTask: (id: string, enabled: boolean): Promise<any> => ipcRenderer.invoke('task:toggle', id, enabled),
  triggerTaskNow: (id: string): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke('task:trigger-now', id),
  onTaskExecuted: (callback: (taskId: string, result: any, silent?: boolean) => void): (() => void) => {
    const handler = (_e: Electron.IpcRendererEvent, taskId: string, result: any, silent?: boolean): void => callback(taskId, result, silent)
    ipcRenderer.on('task:executed', handler)
    return () => ipcRenderer.removeListener('task:executed', handler)
  },
  // 文件操作
  openFile: (filePath: string): Promise<string> => ipcRenderer.invoke('file:open', filePath),
  revealFile: (filePath: string): Promise<void> => ipcRenderer.invoke('file:reveal', filePath),
  // 记忆管理
  listGlobalMemories: (): Promise<any[]> => ipcRenderer.invoke('memory:list-global'),
  readMemory: (filePath: string): Promise<any> => ipcRenderer.invoke('memory:read', filePath),
  deleteMemory: (filePath: string): Promise<boolean> => ipcRenderer.invoke('memory:delete', filePath),
  forceDream: (): Promise<{ actionsApplied: number; summary: string }> => ipcRenderer.invoke('memory:force-dream'),
  getMemoryConfig: (): Promise<{ autoMemoryEnabled: boolean; globalDir: string }> => ipcRenderer.invoke('memory:get-config'),
  setMemoryConfig: (enabled: boolean): Promise<any> => ipcRenderer.invoke('memory:set-config', enabled),
  listArchivedMemories: (): Promise<any[]> => ipcRenderer.invoke('memory:list-archived'),
  restoreMemory: (filePath: string): Promise<boolean> => ipcRenderer.invoke('memory:restore', filePath),

  // 记忆更新通知（支持 extracted 和 dreamed 两种类型）
  onMemoryUpdated: (callback: (event: {
    type: 'extracted' | 'dreamed'
    memories?: Array<{ name: string; type: string; scope: string }>
    actionsApplied?: number
    summary?: string
  }) => void): (() => void) => {
    const handler = (_e: Electron.IpcRendererEvent, event: any): void => callback(event)
    ipcRenderer.on('memory:updated', handler)
    return () => ipcRenderer.removeListener('memory:updated', handler)
  },
  // 文件上传
  openFileDialog: (accept?: 'image' | 'document' | 'any' | 'folder'): Promise<string[] | null> => ipcRenderer.invoke('dialog:open-file', accept),
  parseFile: (filePath: string): Promise<{ fileName: string; fileType: string; textContent: string; sizeBytes: number }> =>
    ipcRenderer.invoke('file:parse', filePath),
  uploadFile: (sourcePath: string): Promise<{ fileName: string; path: string; sizeBytes: number }> =>
    ipcRenderer.invoke('file:upload', sourcePath),
  // 角色资产库子文件夹里的长期档案；教学风格优先以「风格.md」为入口，SKILL.md 仅兼容旧档案
  listRoleSystems: (): Promise<Array<{ name: string; path: string; description?: string; entryFile: string }>> =>
    ipcRenderer.invoke('assets:list-role-systems'),
  // 档案预览的目录树（限定角色资产库内，递归）
  listRoleSystemTree: (dirPath: string): Promise<Array<{ name: string; kind: 'dir' | 'file'; sizeBytes?: number; children?: any[] }>> =>
    ipcRenderer.invoke('assets:list-role-system-tree', dirPath),
  // Artifact 内 LLM 调用桥（window.openpipal.complete 会用到）
  completeInArtifact: (prompt: string, systemPrompt?: string): Promise<{ ok: boolean; content?: string; error?: string }> =>
    ipcRenderer.invoke('openpipal:complete', prompt, systemPrompt),
  // 角色前置页 manifest（文件式，不存在返回 null）
  getRolePreflow: (roleName: string): Promise<any | null> =>
    ipcRenderer.invoke('chat:get-role-preflow', roleName),
  /**
   * 捏头像：scope='role' → system-agents/<role>/mark.json（内置六角色）
   *        scope='agent' → agents/<uuid>/mark.json（用户自建 Agent）
   * 都是文件式 opt-in，删掉文件就回落默认。
   */
  getMark: (scope: 'role' | 'agent', id: string): Promise<{ accessory?: string; hue?: string } | null> =>
    ipcRenderer.invoke('mark:get', scope, id),
  saveMark: (scope: 'role' | 'agent', id: string, config: { accessory: string; hue: string }): Promise<boolean> =>
    ipcRenderer.invoke('mark:save', scope, id, config),
  // 同传目标语言(interpreter 角色;源自动识别)
  getInterpretLangs: (): Promise<{ targetLanguages: string[]; current: string }> =>
    ipcRenderer.invoke('voice:get-interpret-langs'),
  setInterpretTarget: (target: string): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('voice:set-interpret-target', target),
  // 同传逐字稿归档(挂断时落 outputs/{date}_同传.md)
  archiveTranscript: (title: string, content: string): Promise<{ ok: boolean; path?: string }> =>
    ipcRenderer.invoke('voice:archive-transcript', title, content),
  // 资产库 — 通用，任意角色都可以用
  uploadAssetToCategory: (sourcePath: string, category: string): Promise<{ category: string; fileName: string; path: string; sourceType: string; sizeBytes?: number }> =>
    ipcRenderer.invoke('assets:upload-to-category', sourcePath, category),
  // 画布圈画评论：截取本窗口页面指定区域（含 iframe 内容与笔迹）
  captureRegion: (rect: { x: number; y: number; width: number; height: number }): Promise<{ base64: string } | null> =>
    ipcRenderer.invoke('window:capture-region', rect),
  listAssetsTree: (): Promise<Record<string, Array<{ fileName: string; path: string; sizeBytes: number }>>> =>
    ipcRenderer.invoke('assets:list-tree'),
  // 设计系统一等产物库（~/.openpipal/design-systems/，含 SKILL.md 的文件夹 = 一套系统）
  listDesignSystems: (): Promise<Array<{ name: string; path: string }>> =>
    ipcRenderer.invoke('assets:list-design-systems'),
  // 单套设计系统画廊 manifest（卡片按组 + kits + README）；name 非法/不存在 → null
  getDesignSystemManifest: (name: string): Promise<DesignSystemManifest | null> =>
    ipcRenderer.invoke('assets:design-system-manifest', name),
  // 仅返回受控文本或图片 data URL；路径约束和大小上限由 main 侧执行。
  readDesignSystemResource: (name: string, rel: string): Promise<
    | { ok: true; kind: 'text' | 'data-url'; data: string; contentType: string; size: number }
    | { ok: false; code: string; error: string }
  > => ipcRenderer.invoke('assets:read-design-system-resource', name, rel),
  getDesignSystemResourceCapability: (name: string): Promise<string | null> =>
    ipcRenderer.invoke('assets:design-system-capability', name),
  // 已编译新格式 manifest（官方 _ds_manifest.json，12 键）；未编译/legacy/非法 name → null
  getCompiledDsManifest: (name: string): Promise<{ namespace?: string; components?: Array<{ name: string; sourcePath: string }> } | null> =>
    ipcRenderer.invoke('assets:compiled-ds-manifest', name),
  // 设计系统画廊逐卡评审记录（赞/踩+评语，_review.json）；name 非法/不存在 → null / false
  getDsReview: (name: string): Promise<{ updatedAt: number; cards: Record<string, { verdict: 'up' | 'down'; comment?: string; at: number }> } | null> =>
    ipcRenderer.invoke('assets:ds-review-get', name),
  saveDsReview: (name: string, review: { updatedAt: number; cards: Record<string, { verdict: 'up' | 'down'; comment?: string; at: number }> }): Promise<boolean> =>
    ipcRenderer.invoke('assets:ds-review-save', name, review),
  // 历史产物枚举（preflow 首屏产物列表；只含元数据 + 可选缩略图）
  listArtifactHistory: (role?: string, limit?: number): Promise<Array<{ id: string; type: string; title: string; conversationId: string; conversationTitle: string; updatedAt: number; thumbnail?: string }>> =>
    ipcRenderer.invoke('artifact:list-history', role, limit),
  deleteAsset: (path: string): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('assets:delete', path),
  // Sources（Cave 模式资料区）—— 每个 source 一个子目录 + meta.json
  listSources: (): Promise<any[]> =>
    ipcRenderer.invoke('sources:list'),
  getSource: (id: string): Promise<any | null> =>
    ipcRenderer.invoke('sources:get', id),
  addSource: (params: { title: string; type: string; filePath?: string; content?: string; sourceUrl?: string }): Promise<any> =>
    ipcRenderer.invoke('sources:add', params),
  removeSource: (id: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('sources:remove', id),
  updateSourceStatus: (id: string, status: string, patch?: any): Promise<any | null> =>
    ipcRenderer.invoke('sources:update-status', id, status, patch),
  // Artifact 持久化
  saveArtifact: (conversationId: string, artifact: { id: string; type: string; title: string; content: string; language?: string }): Promise<{ ok: boolean; ref?: any; error?: string }> =>
    ipcRenderer.invoke('artifact:save', conversationId, artifact),
  loadArtifact: (ref: { id: string; type: string; title: string; path: string; language?: string }, conversationId?: string): Promise<{ ok: boolean; artifact?: any; error?: string }> =>
    ipcRenderer.invoke('artifact:load', ref, conversationId),
  loadCompiledArtifact: (conversationId: string, artifactId: string): Promise<string | null> =>
    ipcRenderer.invoke('artifact:load-compiled', conversationId, artifactId),
  exportDcArtifacts: (projectName: string, artifacts: { title: string; content: string; artifactId?: string }[]): Promise<{ ok: boolean; dir?: string; files?: string[]; error?: string }> =>
    ipcRenderer.invoke('artifact:export-dc', projectName, artifacts),
  exportArtifactPdf: (title: string, content: string): Promise<{ ok: boolean; path?: string; error?: string }> =>
    ipcRenderer.invoke('artifact:export-pdf', title, content),
  exportZip: (sourceDir: string, outName: string): Promise<{ ok: boolean; path?: string; error?: string }> =>
    ipcRenderer.invoke('artifact:export-zip', sourceDir, outName),
  // 导出弹窗：目录记忆/选择 + 按格式导出（成功后主进程自动在访达中显示文件）
  getExportDir: (): Promise<{ dir: string }> => ipcRenderer.invoke('artifact:get-export-dir'),
  chooseExportDir: (): Promise<{ dir: string }> => ipcRenderer.invoke('artifact:choose-export-dir'),
  exportArtifact: (req: {
    format: 'project-zip' | 'standalone-html' | 'pdf' | 'source' | 'ds-zip' | 'mp4' | 'pptx' | 'handoff'
    title?: string
    content?: string
    id?: string
    filename?: string
    projectName?: string
    artifacts?: { title: string; content: string; artifactId?: string }[]
    dsName?: string
    durationSec?: number
    fps?: number
  }): Promise<{ ok: boolean; path?: string; error?: string }> =>
    ipcRenderer.invoke('artifact:export', req),
  // MP4 导出进度（逐帧渲染，每 10 帧推一次）
  onExportProgress: (callback: (data: { done: number; total: number }) => void): (() => void) => {
    const handler = (_e: Electron.IpcRendererEvent, data: { done: number; total: number }): void => callback(data)
    ipcRenderer.on('export-progress', handler)
    return () => ipcRenderer.removeListener('export-progress', handler)
  }
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  ;(window as any).electron = electronAPI
  ;(window as any).api = api
}
