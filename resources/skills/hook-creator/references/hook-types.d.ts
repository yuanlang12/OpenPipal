/**
 * 规则文件可用的类型。与 src/main/hooks/hook-types.ts 同源（单测钉住不漂移）。
 * 只能 `import type`——这个模块没有运行时值。
 */
declare module 'openpipal/hooks' {
  export type HookEventName = 'tool_call' | 'tool_result' | 'before_agent_start'

  export type HookTextContent = { type: 'text'; text: string }
  export type HookImageContent = { type: 'image'; data: string; mimeType: string }
  export type HookContent = HookTextContent | HookImageContent

  /** 借助手的工具跑出来的结果 */
  export interface HookToolResult {
    content: HookContent[]
    details?: unknown
    isError: boolean
  }

  export interface HookContext {
    conversationId?: string
    workingDir: string
    /** 内置角色名（general / coding / design …）；独立智能体跑在哪个底层角色上就是哪个 */
    roleName?: string
    /** 当前对话属于哪个独立智能体（我的 Pal）；全局助手与内置角色没有。放在智能体自己目录里的规则不用判它（位置即范围）；只有插件里的全局规则想区别对待某个智能体时才用 */
    workspaceId?: string
    source: 'desktop' | 'extension' | 'acp' | 'scheduler'
    /** 这次调用的信号：用户点停止、或这个处理函数超时，都会 abort */
    signal: AbortSignal
    /**
     * 用助手自己的工具（read / write / bash / web_search …）：同一套安全审核、同一个沙箱、
     * 同样会弹授权卡；参数按工具 schema 校验。审核拒绝时抛错，工具本身出错时 isError=true。
     * 规则自己发起的调用不再触发规则。
     */
    callTool?: (toolName: string, input: Record<string, unknown>) => Promise<HookToolResult>
  }

  export interface ToolCallHookEvent {
    type: 'tool_call'
    toolName: string
    toolCallId: string
    /** 工具参数。可原地修改，改了就是真正执行的参数 */
    input: Record<string, unknown>
  }

  export interface ToolCallHookResult {
    /** true = 这次不许用这个工具；reason 会作为工具错误回给模型 */
    block?: boolean
    reason?: string
  }

  export interface ToolResultHookEvent {
    type: 'tool_result'
    toolName: string
    toolCallId: string
    input: Record<string, unknown>
    /** 当前结果（前面的规则改过就是改过之后的） */
    content: HookContent[]
    details: unknown
    isError: boolean
  }

  /** 部分补丁：给了哪个字段就整体替换哪个字段 */
  export interface ToolResultHookResult {
    content?: HookContent[]
    details?: unknown
    isError?: boolean
  }

  export interface BeforeAgentStartHookEvent {
    type: 'before_agent_start'
    /** 用户这一轮说的话 */
    prompt: string
    /** 当前系统提示。追加内容请保持每轮稳定 */
    systemPrompt: string
  }

  export interface BeforeAgentStartHookResult {
    systemPrompt?: string
  }

  export interface HookEventMap {
    tool_call: { event: ToolCallHookEvent; result: ToolCallHookResult }
    tool_result: { event: ToolResultHookEvent; result: ToolResultHookResult }
    before_agent_start: { event: BeforeAgentStartHookEvent; result: BeforeAgentStartHookResult }
  }

  export type HookHandler<E extends HookEventName = HookEventName> = (
    event: HookEventMap[E]['event'],
    ctx: HookContext
  ) => HookEventMap[E]['result'] | void | undefined | Promise<HookEventMap[E]['result'] | void | undefined>

  export interface HookAPI {
    on<E extends HookEventName>(event: E, handler: HookHandler<E>): void
  }
}
