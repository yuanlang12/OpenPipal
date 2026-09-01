import type { ConversationGoal } from '../goal-checker'

/** Product-owned event protocol consumed by desktop IPC, HTTP/ACP, and scheduler. */
export type AgentEvent =
  | { type: 'text'; content: string }
  | { type: 'text_flush' }
  | { type: 'thinking'; content: string }
  | { type: 'thinking_end' }
  | { type: 'tool_progress'; name: string; chars: number; toolCallId?: string; path?: string }
  | { type: 'tool_start'; name: string; toolCallId?: string }
  | {
    type: 'tool_end'
    name: string
    toolCallId?: string
    screenshot?: string
    searchResults?: string
    mcpResult?: string
    /** UI card arguments may be derived; preserve the model's original arguments separately. */
    modelToolArgs?: string
    mcpArgs?: string
    visualizer?: {
      id: string
      type: 'html' | 'svg' | 'chart'
      title: string
      content: string
      height?: number
    }
  }
  | {
    type: 'artifact'
    artifact: { id: string; type: string; title: string; content: string; language?: string }
    toolCallId?: string
  }
  | { type: 'artifact_delta'; id: string; title?: string; artifactType?: string; delta: string; offset: number }
  | { type: 'visualizer'; visualizer: { id: string; messageId: string; type: 'html' | 'svg' | 'chart'; title: string; content: string; height?: number } }
  | { type: 'visualizer_delta'; id: string; title?: string; delta: string; offset: number; height?: number }
  | { type: 'mcp_app_inline'; messageId: string; payload: {
      serverName: string
      serverBinding: string
      toolName: string
      conversationId?: string
      resourceUri: string
      html: string
      args: Record<string, any>
      contentBlocks: any[]
      structuredContent: any
      permissions: string[]
      csp: any
    }}
  | { type: 'ask_user'; question: string; options: { label: string; value: string }[]; fields?: { label: string; placeholder?: string; type?: string; options?: string[]; required?: boolean }[] }
  | { type: 'questions_v2'; title: string; questions: any[] }
  | { type: 'questions_v2_delta'; id: string; title?: string; questions: any[] }
  | { type: 'permission_request'; requestId: string; tool: string; args: Record<string, any>; risk: string; reason: string }
  | { type: 'error'; content: string }
  /**
   * 上游断流后正在重连。渲染层收到它要做两件事：提示"正在重连 (n/m)"，
   * 以及丢弃本次尝试已经流出的半截思考/正文——重连是整轮重发，不是断点续传，
   * 不丢就会把两次尝试的内容拼在一起。
   */
  | { type: 'stream_retry'; attempt: number; maxRetries: number }
  | { type: 'goal_update'; goal: ConversationGoal }
  /**
   * 本轮 prompt 附带的 runtime-context 快照（时间/前台应用/产物清单）原文。
   * 渲染层把它作为 messageKind='runtime-context' 的隐藏消息存进会话：
   * 下一轮回放时字节与实发一致，前缀缓存才能连着整轮工具流量一起命中。
   * 消息位置紧跟本轮用户消息；regenerate 重跑时由渲染层替换旧快照。
   */
  | { type: 'runtime_context'; text: string }
  | {
      type: 'context_usage'
      promptTokens: number
      contextWindow: number
      budget: number
      compacted: boolean
      /** 本次调用实报用量（input+cacheRead+cacheWrite = promptTokens），渲染层据此累计命中率 */
      usage?: { input: number; cacheRead: number; cacheWrite: number }
      /** 载荷分区估算（字符口径）：system+skills+tools 是组装期一次估算，messages=promptTokens-其余 */
      segments?: {
        systemPrompt: number
        skills: number
        toolsBuiltin: number
        toolsMcp: number
        messages: number
      }
    }
