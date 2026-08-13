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
  | { type: 'goal_update'; goal: ConversationGoal }
  | { type: 'context_usage'; promptTokens: number; contextWindow: number; budget: number; compacted: boolean }
