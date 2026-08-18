import type { ModelConfig } from '../config-manager'
import type { ConversationGoal } from '../goal-checker'
import type { PermissionHandler } from '../pi-security'
import type { AgentEvent } from './events'

export type AgentRuntimeKind = 'legacy' | 'pi-core'
export type ChatSource = 'desktop' | 'extension' | 'acp' | 'scheduler'
export type { AgentEvent } from './events'

export interface RuntimeUserInput {
  text: string
  images?: string[]
}

/**
 * OpenPipal-facing subset of a running Agent.
 *
 * Callers intentionally do not receive the concrete Pi Agent instance. This keeps
 * desktop/HTTP scheduling code stable while the implementation moves from the
 * legacy low-level Agent wrapper to pi-mono's current core/Harness APIs.
 */
export interface RunningAgentHandle {
  steer: (input: RuntimeUserInput) => void | Promise<void>
  followUp: (input: RuntimeUserInput) => void | Promise<void>
}

/** Product-owned inputs that are applied on top of the generic Agent runtime. */
export interface AgentOverrides {
  systemPrompt: string
  /**
   * Conversation-scoped role snapshot for this execution.
   *
   * The process-global role remains a UI default/compatibility surface, but it
   * must not be consulted after an execution has started because another
   * conversation may switch it concurrently.
   */
  roleName?: string
  tools?: string[]
  workingDir?: string
  conversationId?: string
  /** Workspace Agent ID — enables workspace-scoped skills and resources. */
  workspaceId?: string
  /** Conversation-scoped structured context injected by OpenPipal. */
  roleBrief?: Record<string, Record<string, any>>
  initialAssets?: Array<{
    category: string
    fileName: string
    path: string
    sourceType: string
    sizeBytes?: number
  }>
  projectName?: string
  thinkingEnabled?: boolean
  thinkingLevel?: 'low' | 'medium' | 'high'
  modelPresetId?: string
  goal?: ConversationGoal
}

/** Stable message contract shared by desktop, HTTP/ACP, scheduler, and Runtime. */
export interface ChatMessage {
  id?: string
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string
  /**
   * 消息分类标记（task-trigger 隐式触发 / runtime-context 隐藏快照）。
   * runtime-context：本轮 prompt 附带的易变上下文原文，UI 不渲染，
   * 转换层原样回放——落盘副本与实发字节一致是前缀缓存命中的前提。
   */
  messageKind?: string
  screenshot?: string
  screenshotRef?: string
  images?: string[]
  imagePaths?: string[]
  fileAttachments?: { fileName: string; path?: string; sizeBytes: number }[]
  toolName?: string
  toolCallId?: string
  toolArgs?: string
}

/**
 * The only Agent execution surface application entry points should depend on.
 * The legacy adapter and the future pi-core adapter must implement this contract
 * before either can be selected. Pi's CLI Agent is intentionally outside this
 * boundary.
 */
export interface OpenPipalAgentRuntime {
  readonly kind: AgentRuntimeKind
  agentChat(
    history: ChatMessage[],
    signal?: AbortSignal,
    source?: ChatSource,
    overrides?: AgentOverrides,
    onAgentReady?: (handle: RunningAgentHandle) => void
  ): AsyncGenerator<AgentEvent, void, undefined>
  setPermissionHandler(handler: PermissionHandler): void
  testThinkingSupport(config: ModelConfig): Promise<{ detected: boolean; error?: string }>
}
