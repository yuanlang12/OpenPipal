/**
 * 用户 hook（「规则」）的公开契约。
 *
 * 一个 hook = 插件目录 `plugins/<name>/hooks/<file>.ts` 里的一个模块：
 *
 *   export const description = '读成绩表前先遮名字'   // 大白话，插件页与对话流提醒行显示
 *   export default function (hook: HookAPI) {
 *     hook.on('tool_call', (event, ctx) => { ... })
 *   }
 *
 * 事件名与形状沿用 pi 扩展系统（tool_call 可拦截可改参 / tool_result 可打补丁 /
 * before_agent_start 可改系统提示），这样 pi 社区的写法能直接搬过来。
 * 与 pi 的差别只有一条：hook 永远跑在宿主安全员**里面**——改过的参数仍要过 pi-security，
 * 宿主标记的 terminate 不可被覆盖。组合顺序见 pi-core-tool-adapter.ts。
 */

export type HookEventName = 'tool_call' | 'tool_result' | 'before_agent_start'

export const HOOK_EVENT_NAMES: readonly HookEventName[] = ['tool_call', 'tool_result', 'before_agent_start']

/** 规则借助手的工具跑出来的结果（形状同工具回给模型的） */
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
  /** 这次调用的信号：用户点停止、或这个处理函数超时，都会 abort；异步工作应当尊重它 */
  signal: AbortSignal
  /**
   * 用助手自己的工具（read / write / bash / web_search …）：同一套安全审核、同一个沙箱、
   * 同样会弹授权卡；参数按工具 schema 校验。规则自己发起的调用不再触发规则（不递归）。
   * 等授权卡期间处理函数的超时会暂停。审核拒绝时抛错，工具本身出错时 isError=true。
   */
  callTool?: (toolName: string, input: Record<string, unknown>) => Promise<HookToolResult>
}

export type HookTextContent = { type: 'text'; text: string }
export type HookImageContent = { type: 'image'; data: string; mimeType: string }
export type HookContent = HookTextContent | HookImageContent

export interface ToolCallHookEvent {
  type: 'tool_call'
  toolName: string
  toolCallId: string
  /** 工具参数。**可原地修改**，改了就是真正执行（也是安全员真正审的）的参数 */
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
  /** 当前结果（前面的 hook 改过就是改过之后的） */
  content: HookContent[]
  details: unknown
  isError: boolean
}

/** 部分补丁：给了哪个字段就整体替换哪个字段，没给的保持原样（同 pi 语义） */
export interface ToolResultHookResult {
  content?: HookContent[]
  details?: unknown
  isError?: boolean
}

export interface BeforeAgentStartHookEvent {
  type: 'before_agent_start'
  /** 用户这一轮说的话 */
  prompt: string
  /** 当前系统提示（前面的 hook 改过就是改过之后的）。追加内容请保持每轮稳定，否则前缀缓存会整轮失效 */
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

export type HookFactory = (hook: HookAPI) => void | Promise<void>

/** 一个加载成功的 hook 文件 */
export interface LoadedHook {
  /** `<plugin>/<文件名去后缀>`，全局唯一，UI 与日志都用它 */
  id: string
  pluginName: string
  /** 绝对路径 */
  file: string
  description: string
  handlers: { [E in HookEventName]: HookHandler<E>[] }
}

export interface HookLoadFailure {
  id: string
  pluginName: string
  file: string
  error: string
}

export type HookLoadResult =
  | { ok: true; hook: LoadedHook }
  | { ok: false; failure: HookLoadFailure }

/** 跨进程的提醒/清单形状住在 shared，这里只是转出口，免得 main 内部处处改 import 路径 */
export type { HookNotice, HookEntry } from '../../shared/hook-contract'

/** 运行期某个 handler 出错/超时的记录（fail-open：记下来、继续跑，不拖垮本轮） */
export interface HookRunError {
  hookId: string
  event: HookEventName
  error: string
}
