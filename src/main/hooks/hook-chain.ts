/**
 * 按加载顺序串行跑一组 hook 的某个事件。
 *
 * 语义（对齐 pi）：
 *   tool_call          每个 handler 可原地改 event.input；第一个 block 的赢，后面不再跑
 *   tool_result        每个 handler 看到的是前面改过之后的结果；返回部分补丁按字段整体替换
 *   before_agent_start 系统提示逐个串起来，最后一个的结果就是发给模型的；只能加不能减——
 *                      返回值不含原提示的按追加处理（这点不同于 pi 的整份替换）
 *   agent_end          每轮收工后逐个跑，没有返回值；本轮被停止了也跑（用的不是本轮的生命周期信号）
 *
 * 可靠性（宿主兜底，永久机制）：单个 handler 抛错或超时 → 记一条 HookRunError、跳过它、
 * 继续跑下一个（fail-open）。一条写坏的规则不应该让助手整个瘫掉；真正的安全闸门在
 * hook 外面（pi-security），这里放行不等于放过。
 *
 * 两条不可妥协的边界：
 *   - handler 拿到的 input 是**草稿副本**，只有正常返回才整体提交回真正的参数对象；
 *     超时/抛错的 handler 改了一半、或超时之后才动手，都不会碰到安全员将要审的那份参数。
 *   - 每次调用拿到的 ctx.signal 是本次调用专属的：超时或本轮被停都会 abort，
 *     被放弃的处理函数再去 callTool 也会立刻被拒。callTool 等待期间（多半是在等用户点授权卡）
 *     超时计时暂停；并发多个 callTool 按在途计数暂停/恢复，不会互相踩计时器。
 *   - 同步死循环挡不住（主线程），pi 也挡不住；只能靠加载失败反馈与逃生舱口。
 *
 * ctx.store 由这里按规则文件绑定（hook-store.ts）：每条规则一个仓库，几条会话共用同一份。
 */
import type {
  AgentEndHookEvent,
  BeforeAgentStartHookEvent,
  HookContext,
  HookEventName,
  HookRunError,
  HookStore,
  HookToolResult,
  LoadedHook,
  ToolCallHookEvent,
  ToolCallHookResult,
  ToolResultHookEvent,
  ToolResultHookResult
} from './hook-types'
import { openHookStore } from './hook-store'

export const DEFAULT_HOOK_TIMEOUT_MS = 10_000

/** 宿主提供的"用助手的工具"实现；chain 把它绑到每次调用的信号上再交给规则 */
export type HookToolCaller = (
  toolName: string,
  input: Record<string, unknown>,
  signal: AbortSignal
) => Promise<HookToolResult>

export interface HookChain {
  hooks: LoadedHook[]
  /** 基础上下文；signal 是本轮的生命周期信号，每次调用会派生出自己的；store 按规则文件绑定 */
  ctx: Omit<HookContext, 'callTool' | 'store'>
  callTool?: HookToolCaller
  timeoutMs?: number
  onError?: (error: HookRunError) => void
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const stores = new WeakMap<LoadedHook, HookStore>()

function storeFor(hook: LoadedHook): HookStore {
  let store = stores.get(hook)
  if (!store) {
    store = openHookStore(hook.file)
    stores.set(hook, store)
  }
  return store
}

async function runHandler<T>(
  chain: HookChain,
  hook: LoadedHook,
  event: HookEventName,
  invoke: (ctx: HookContext) => T | Promise<T>
): Promise<T | undefined> {
  const timeoutMs = chain.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS
  if (chain.ctx.signal.aborted) return undefined

  const controller = new AbortController()
  let settle: (error: Error) => void = () => {}
  const failure = new Promise<never>((_, reject) => { settle = reject })
  const abortForLifecycle = (): void => {
    controller.abort()
    settle(new Error('本轮已停止'))
  }
  chain.ctx.signal.addEventListener('abort', abortForLifecycle, { once: true })

  // 超时计时器：只在"处理函数自己在算"的时候走；等工具期间暂停。arm 幂等，按在途工具数恢复
  let timer: ReturnType<typeof setTimeout> | undefined
  let inflightTools = 0
  const arm = (): void => {
    if (timer || controller.signal.aborted) return
    timer = setTimeout(() => {
      controller.abort()
      settle(new Error(`超过 ${timeoutMs}ms 没返回，已跳过`))
    }, timeoutMs)
  }
  const disarm = (): void => {
    if (timer) clearTimeout(timer)
    timer = undefined
  }

  const ctx: HookContext = {
    ...chain.ctx,
    signal: controller.signal,
    store: storeFor(hook),
    ...(chain.callTool
      ? {
          callTool: async (toolName: string, input: Record<string, unknown>) => {
            inflightTools += 1
            disarm()
            try {
              return await chain.callTool!(toolName, input, controller.signal)
            } finally {
              inflightTools -= 1
              if (inflightTools === 0) arm()
            }
          }
        }
      : {})
  }

  try {
    arm()
    return await Promise.race([Promise.resolve().then(() => invoke(ctx)), failure])
  } catch (error) {
    const report: HookRunError = { hookId: hook.id, event, error: errorText(error) }
    console.warn(`[Hooks] ${hook.id} 的 ${event} 处理失败，已跳过：${report.error}`)
    chain.onError?.(report)
    return undefined
  } finally {
    disarm()
    chain.ctx.signal.removeEventListener('abort', abortForLifecycle)
  }
}

export function hasHandlers(chain: HookChain | undefined, event: HookEventName): boolean {
  return !!chain && chain.hooks.some((hook) => hook.handlers[event].length > 0)
}

function cloneArgs(input: Record<string, unknown>): Record<string, unknown> {
  try {
    return structuredClone(input)
  } catch {
    return JSON.parse(JSON.stringify(input)) as Record<string, unknown>
  }
}

/** 把草稿整体提交回原对象——必须保持同一个对象身份，Agent 循环执行工具用的就是它 */
function commitArgs(target: Record<string, unknown>, draft: Record<string, unknown>): void {
  for (const key of Object.keys(target)) delete target[key]
  Object.assign(target, draft)
}

export async function runToolCallHooks(
  chain: HookChain,
  event: ToolCallHookEvent
): Promise<ToolCallHookResult | undefined> {
  for (const hook of chain.hooks) {
    for (const handler of hook.handlers.tool_call) {
      // handler 返回 undefined 表示"跑完了、没意见"，被跳过（超时/抛错）时 runHandler 也返回 undefined——
      // 包一层区分开：只有真正跑完的草稿才提交
      const draft = cloneArgs(event.input)
      const outcome = await runHandler(chain, hook, 'tool_call', async (ctx) => {
        const result = await handler({ ...event, input: draft }, ctx)
        return { result }
      })
      if (!outcome) continue   // 超时或抛错：草稿整份作废，真正的参数一个字节没动
      const result = outcome.result
      if (result && result.block) {
        // 拦下的调用不提交草稿：审计里记的要是模型原本发的参数，不是规则顺手改过的
        const reason = typeof result.reason === 'string' && result.reason.trim()
          ? result.reason.trim()
          : '这次不允许用这个工具'
        return { block: true, reason: `被规则「${hook.description}」拦下：${reason}` }
      }
      commitArgs(event.input, draft)
    }
  }
  return undefined
}

function isContentArray(value: unknown): value is ToolResultHookEvent['content'] {
  return Array.isArray(value) && value.every((block) => block && typeof block === 'object' && typeof (block as { type?: unknown }).type === 'string')
}

export async function runToolResultHooks(
  chain: HookChain,
  event: ToolResultHookEvent
): Promise<ToolResultHookResult | undefined> {
  const patch: ToolResultHookResult = {}
  let touched = false
  for (const hook of chain.hooks) {
    for (const handler of hook.handlers.tool_result) {
      const result = await runHandler(chain, hook, 'tool_result', (ctx) => handler(event, ctx))
      if (!result || typeof result !== 'object') continue
      if (result.content !== undefined) {
        if (!isContentArray(result.content)) {
          chain.onError?.({ hookId: hook.id, event: 'tool_result', error: 'content 必须是 [{ type: "text", text }] 这样的数组，已忽略这次修改' })
          continue
        }
        event.content = result.content
        patch.content = result.content
        touched = true
      }
      if (result.details !== undefined) {
        event.details = result.details
        patch.details = result.details
        touched = true
      }
      if (typeof result.isError === 'boolean') {
        event.isError = result.isError
        patch.isError = result.isError
        touched = true
      }
    }
  }
  return touched ? patch : undefined
}

export async function runBeforeAgentStartHooks(
  chain: HookChain,
  event: BeforeAgentStartHookEvent
): Promise<string> {
  for (const hook of chain.hooks) {
    for (const handler of hook.handlers.before_agent_start) {
      const before = event.systemPrompt
      const result = await runHandler(chain, hook, 'before_agent_start', (ctx) => handler({ ...event }, ctx))
      if (!result || typeof result.systemPrompt !== 'string') continue
      if (result.systemPrompt.includes(before)) {
        event.systemPrompt = result.systemPrompt
        continue
      }
      // 规则只能往系统提示里加、不能减：返回值里找不到原提示，多半是漏拼了 event.systemPrompt。
      // 真机实撞（2026-09-08~17）：一条这样的规则让所有会话只剩它那 378 个字，角色提示与技能索引全丢
      event.systemPrompt = before ? `${before}\n\n${result.systemPrompt}` : result.systemPrompt
      const report: HookRunError = { hookId: hook.id, event: 'before_agent_start', error: '返回的 systemPrompt 里没有原来的系统提示，已按追加处理（应返回 event.systemPrompt + 你的内容）' }
      console.warn(`[Hooks] ${hook.id} 的 before_agent_start：${report.error}`)
      chain.onError?.(report)
    }
  }
  return event.systemPrompt
}

/**
 * 每轮收工。本轮的生命周期信号这时多半已经 abort（用户点停、或消费方关了流），
 * 但收尾正是这时候要做的事，所以换一个只受超时约束的信号；callTool 仍走同一份授权。
 */
export async function runAgentEndHooks(
  chain: HookChain,
  event: AgentEndHookEvent
): Promise<void> {
  const settled: HookChain = { ...chain, ctx: { ...chain.ctx, signal: new AbortController().signal } }
  for (const hook of chain.hooks) {
    for (const handler of hook.handlers.agent_end) {
      await runHandler(settled, hook, 'agent_end', (ctx) => handler(event, ctx))
    }
  }
}
