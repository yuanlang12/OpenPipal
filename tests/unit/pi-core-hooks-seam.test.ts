/**
 * 规则接线的源码级守卫——pi-core-runtime 必须经组合函数接 Agent，不能自己拼 beforeToolCall。
 *
 * 为什么按源码文本钉：组合顺序（规则 → 安全员审最终参数；宿主 terminate 不可覆盖）住在
 * pi-core-tool-adapter 的两个 compose 函数里，runtime 一旦绕开它们手写回调，顺序保证就
 * 静默消失，功能上看不出来。与 agent-runtime-boundary 同款手法。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

const runtime = readFileSync(join(__dirname, '../../src/main/agent-runtime/pi-core-runtime.ts'), 'utf-8')

describe('pi-core-runtime 规则接线', () => {
  it('beforeToolCall / afterToolCall 经组合函数装配', () => {
    expect(runtime).toMatch(/beforeToolCall:\s*composePiCoreBeforeToolCall\(/)
    expect(runtime).toMatch(/afterToolCall:\s*composePiCoreAfterToolCall\(/)
    expect(runtime).not.toMatch(/beforeToolCall:\s*\(event, runSignal\)\s*=>/)
    expect(runtime).not.toMatch(/buildPiCoreAfterToolCallPatch\(/)
  })

  it('规则在工具装配之后装（借的就是这一轮的工具）；before_agent_start 在系统提示定稿之后、预算估算之前跑', () => {
    const render = runtime.indexOf('let systemPrompt = preparedPrompt.render(')
    const tools = runtime.indexOf('const builtTools = buildPiCoreAgentTools(')
    const chain = runtime.indexOf('const { chain: hookChain, report: hookReport, agentScanError: hookScanError } = await resolveHookChain(')
    const hooks = runtime.indexOf('runBeforeAgentStartHooks(hookChain')
    const budget = runtime.indexOf('const segmentEstimate = buildSegmentBaseline(')
    expect(render).toBeGreaterThan(0)
    expect(tools).toBeGreaterThan(render)
    expect(chain).toBeGreaterThan(tools)
    expect(hooks).toBeGreaterThan(chain)
    expect(budget).toBeGreaterThan(hooks)
  })

  it('规则调工具走与助手同一份授权选项（conversationId / permissionHandler / scope / tier）', () => {
    const block = runtime.slice(runtime.indexOf('createHookToolCaller({'), runtime.indexOf('if (hookChain && hasHandlers(hookChain, \'before_agent_start\'))'))
    expect(block).toMatch(/tools: builtTools\.tools/)
    expect(block).toMatch(/onConfirmation: permissionHandler/)
    expect(block).toMatch(/scope: \{ workspaceId: workspace\.workspaceId, workingDir: workspace\.workingDir \}/)
    expect(block).toMatch(/tier: overrides\?\.permissionTier/)
  })

  it('规则加载失败只留日志不影响对话', () => {
    expect(runtime).toMatch(/规则加载异常，本轮不带规则/)
    expect(runtime).toMatch(/没生效：\$\{failure\.error\}/)
  })
})
