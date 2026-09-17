/**
 * 规则文件可用的类型。与 src/main/hooks/hook-types.ts 同源（单测钉住不漂移）。
 * 只能 `import type`——这个模块没有运行时值。
 */
declare module 'openpipal/hooks' {
  export type HookEventName = 'tool_call' | 'tool_result' | 'before_agent_start' | 'agent_end'

  export type HookTextContent = { type: 'text'; text: string }
  export type HookImageContent = { type: 'image'; data: string; mimeType: string }
  export type HookContent = HookTextContent | HookImageContent

  /** 借助手的工具跑出来的结果 */
  export interface HookToolResult {
    content: HookContent[]
    details?: unknown
    isError: boolean
  }

  /**
   * 这条规则自己的小仓库：跨轮、跨会话、重启后还在（每条规则一个 JSON 文件）。
   * 值必须能转成 JSON（函数、undefined 会丢）；单条规则总量 ≤ 256KB，超了 set 抛错。
   */
  export interface HookStore {
    /** 取一个值；没存过返回 undefined。拿到的是副本，改它不影响仓库 */
    get<T = unknown>(key: string): Promise<T | undefined>
    /** 存一个值，写进磁盘才返回；传 undefined 等于删 */
    set(key: string, value: unknown): Promise<void>
    delete(key: string): Promise<void>
  }

  export interface HookContext {
    conversationId?: string
    workingDir: string
    /** 内置角色名（general / coding / design …）；独立智能体跑在哪个底层角色上就是哪个 */
    roleName?: string
    /** 当前对话属于哪个独立智能体（我的 Pal）；全局助手与内置角色没有。放在智能体自己目录里的规则不用判它（位置即范围）；只有插件里的全局规则想区别对待某个智能体时才用 */
    workspaceId?: string
    /** 统一的 Agent 身份：内置名（general / design / coding …）或 Pal 的 id。只对某个 Agent 生效的全局规则判它（`if (ctx.agentId !== 'coding') return`） */
    agentId?: string
    source: 'desktop' | 'extension' | 'acp' | 'scheduler'
    /** 这次调用的信号：用户点停止、或这个处理函数超时，都会 abort */
    signal: AbortSignal
    /**
     * 这条规则自己的小仓库：记"累计跑了几轮""上一轮改过哪些文件""上次提醒是什么时候"这类
     * 跨轮状态用它，别写文件（要过审核）也别靠变量（重启就没了）。
     */
    store: HookStore
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
    /** 只能加不能减：必须含 event.systemPrompt 原文（通常 event.systemPrompt + 你的内容）；不含的由宿主按追加处理 */
    systemPrompt?: string
  }

  /** 这一轮调过的一个工具（模型发起的；规则自己借的不算） */
  export interface HookToolCallRecord {
    toolName: string
    /** 真正执行的参数（规则改过就是改过之后的） */
    input: Record<string, unknown>
    isError: boolean
  }

  /**
   * 每轮收工：助手这一轮说完了（或被停止、出错）之后跑。不能改回复——回复已经给用户看了；
   * 用来记账、收尾（跑个脚本、往 ctx.store 里记这轮做了什么，下一轮 before_agent_start 再用）。
   * 用户点了停止也会跑。
   */
  export interface AgentEndHookEvent {
    type: 'agent_end'
    /** 用户这一轮说的话 */
    prompt: string
    /** 助手这一轮最后的回复正文（纯文本）；被停止 / 出错时可能为空 */
    reply: string
    /** 正常说完 / 被停止（用户点停、超时看门狗）/ 模型或服务出错 */
    outcome: 'completed' | 'aborted' | 'error'
    /** 这一轮按顺序调过的工具 */
    toolCalls: HookToolCallRecord[]
  }

  /** agent_end 没有返回值：这一轮已经结束，没有什么可改的 */
  export type AgentEndHookResult = void

  export interface HookEventMap {
    tool_call: { event: ToolCallHookEvent; result: ToolCallHookResult }
    tool_result: { event: ToolResultHookEvent; result: ToolResultHookResult }
    before_agent_start: { event: BeforeAgentStartHookEvent; result: BeforeAgentStartHookResult }
    agent_end: { event: AgentEndHookEvent; result: AgentEndHookResult }
  }

  export type HookHandler<E extends HookEventName = HookEventName> = (
    event: HookEventMap[E]['event'],
    ctx: HookContext
  ) => HookEventMap[E]['result'] | void | undefined | Promise<HookEventMap[E]['result'] | void | undefined>

  export interface HookAPI {
    on<E extends HookEventName>(event: E, handler: HookHandler<E>): void
  }
}
