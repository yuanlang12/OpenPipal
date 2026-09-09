/**
 * 后台写规则的编排（hooks/rule-writer）：
 *   写手（Evolver，这里注入假的）写出文件 → 探针给结论 → 加载失败带原因重试一次 → 结论走 notify；
 *   local-rules 的 plugin.json 缺了自动补；写手没产出 / 抛错 / 重试没再动文件各有明确结论；
 *   队列串行，一条失败不影响下一条。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const HOME = mkdtempSync(join(tmpdir(), 'openpipal-rule-writer-'))
process.env.OPENPIPAL_ISOLATED_HOME = HOME

const { requestRule, ensureLocalRulesPlugin, isRuleWriteActive, listPendingRuleDescriptions, LOCAL_RULES_PLUGIN } = await import('../../src/main/hooks/rule-writer')
const { resetHookCache } = await import('../../src/main/hooks/hook-registry')

const PLUGINS = join(HOME, '.openpipal', 'plugins')
const GOOD = `export const description = '读成绩表前先遮名字'
export default function (hook) { hook.on('tool_result', () => undefined) }`
const BROKEN = `export const description = '坏的'
export default function (hook) { hook.on('nope', () => {}) }`

const request = {
  description: '读成绩表前先遮名字',
  details: 'read 成绩相关文件时把姓名换成学生N',
  conversationId: 'conv-1',
  roleName: 'general'
}

/** 依次按 contents 写 hooks/mask.ts（null = 这次什么都不写） */
function writerWriting(contents: Array<string | null>) {
  let call = 0
  return vi.fn(async ({ rulesDir }: { rulesDir: string }) => {
    const content = contents[Math.min(call++, contents.length - 1)]
    if (content !== null) writeFileSync(join(rulesDir, 'mask.ts'), content, 'utf-8')
    return { success: true }
  })
}

beforeAll(() => mkdirSync(PLUGINS, { recursive: true }))
afterAll(() => rmSync(HOME, { recursive: true, force: true }))
beforeEach(() => {
  rmSync(PLUGINS, { recursive: true, force: true })
  mkdirSync(PLUGINS, { recursive: true })
  delete process.env.OPENPIPAL_DISABLE_HOOKS
  resetHookCache()
})

describe('rule-writer', () => {
  it('补齐 local-rules 的 plugin.json，写手写出好文件 → ok 结论 → notify', async () => {
    const writer = writerWriting([GOOD])
    const notify = vi.fn()
    const notices = await requestRule(request, { writer, notify })
    expect(JSON.parse(readFileSync(join(PLUGINS, LOCAL_RULES_PLUGIN, 'plugin.json'), 'utf-8')).name).toBe(LOCAL_RULES_PLUGIN)
    expect(writer).toHaveBeenCalledTimes(1)
    expect(writer.mock.calls[0][0]).toMatchObject({ rulesDir: join(PLUGINS, LOCAL_RULES_PLUGIN, 'hooks'), description: request.description, details: request.details, previousError: undefined })
    expect(notices).toHaveLength(1)
    expect(notices[0]).toMatchObject({ status: 'ok', hookId: `${LOCAL_RULES_PLUGIN}/mask`, source: { kind: 'plugin', id: LOCAL_RULES_PLUGIN, name: LOCAL_RULES_PLUGIN }, description: '读成绩表前先遮名字' })
    expect(notify).toHaveBeenCalledWith(request, notices)
  })

  it('写坏了：带着加载错误让写手再写一次，第二次写好就是 ok', async () => {
    const writer = writerWriting([BROKEN, GOOD])
    const notices = await requestRule(request, { writer, notify: () => {} })
    expect(writer).toHaveBeenCalledTimes(2)
    const retry = writer.mock.calls[1][0] as { previousError?: string }
    expect(retry.previousError).toMatch(/mask\.ts: /)
    expect(retry.previousError).toMatch(/nope/)
    expect(notices.map((n) => n.status)).toEqual(['ok'])
  })

  it('重试没再动文件：以上一轮的失败结论为准，不说"没写出文件"', async () => {
    const writer = writerWriting([BROKEN, null])
    const notices = await requestRule(request, { writer, notify: () => {} })
    expect(writer).toHaveBeenCalledTimes(2)
    expect(notices).toHaveLength(1)
    expect(notices[0].status).toBe('error')
    expect(notices[0].error).toMatch(/nope/)
  })

  it('写手说成功却什么都没写 / 写手抛错：各自一条失败结论，文件字段为空', async () => {
    const nothing = await requestRule(request, { writer: writerWriting([null]), notify: () => {} })
    expect(nothing[0]).toMatchObject({ status: 'error', file: '', error: '后台没有写出规则文件' })

    const thrown = await requestRule(request, { writer: async () => { throw new Error('模型挂了') }, notify: () => {} })
    expect(thrown[0]).toMatchObject({ status: 'error', error: '后台没写成：模型挂了' })
  })

  it('没注册写手（ipc-handlers 还没跑）：明确的失败结论，不抛', async () => {
    const notices = await requestRule(request, { notify: () => {} })
    expect(notices[0]).toMatchObject({ status: 'error', error: '后台写手未就绪' })
  })

  it('OPENPIPAL_DISABLE_HOOKS=1：不劳烦写手，直接告诉用户规则功能被关了', async () => {
    process.env.OPENPIPAL_DISABLE_HOOKS = '1'
    const writer = writerWriting([GOOD])
    const notices = await requestRule(request, { writer, notify: () => {} })
    expect(writer).not.toHaveBeenCalled()
    expect(notices[0].error).toMatch(/OPENPIPAL_DISABLE_HOOKS/)
  })

  it('队列串行：第二条等第一条写完才开始；第一条 notify 抛错不连累第二条', async () => {
    const order: string[] = []
    let releaseFirst!: () => void
    const first = requestRule({ ...request, description: '第一条' }, {
      writer: async ({ rulesDir }) => {
        order.push('first-start')
        await new Promise<void>((resolve) => { releaseFirst = resolve })
        writeFileSync(join(rulesDir, 'first.ts'), GOOD, 'utf-8')
        order.push('first-end')
        return { success: true }
      },
      notify: () => { throw new Error('渲染层没了') }
    })
    const second = requestRule({ ...request, description: '第二条' }, {
      writer: async ({ rulesDir }) => {
        order.push('second-start')
        writeFileSync(join(rulesDir, 'second.ts'), GOOD, 'utf-8')
        return { success: true }
      },
      notify: () => {}
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(order).toEqual(['first-start'])
    releaseFirst()
    const [n1, n2] = await Promise.all([first, second])
    expect(order).toEqual(['first-start', 'first-end', 'second-start'])
    expect(n1.map((n) => n.status)).toEqual(['ok'])
    expect(n2.map((n) => n.status)).toEqual(['ok'])
    expect(existsSync(join(PLUGINS, LOCAL_RULES_PLUGIN, 'hooks', 'second.ts'))).toBe(true)
  })

  it('写的期间 isRuleWriteActive 为真、描述在「后台正在写」清单里；写完两者都清', async () => {
    let seenDuring: boolean | undefined
    let pendingDuring: string[] = []
    expect(isRuleWriteActive()).toBe(false)
    expect(listPendingRuleDescriptions(request.conversationId)).toEqual([])
    await requestRule(request, {
      writer: async ({ rulesDir }) => {
        seenDuring = isRuleWriteActive()
        pendingDuring = listPendingRuleDescriptions(request.conversationId)
        // 别的会话看不到这条：清单进的是提规则那个会话的系统提示
        expect(listPendingRuleDescriptions('another-conv')).toEqual([])
        expect(listPendingRuleDescriptions(undefined)).toEqual([])
        writeFileSync(join(rulesDir, 'mask.ts'), GOOD, 'utf-8')
        return { success: true }
      },
      notify: () => {}
    })
    expect(seenDuring).toBe(true)
    expect(pendingDuring).toEqual([request.description])
    expect(isRuleWriteActive()).toBe(false)
    expect(listPendingRuleDescriptions(request.conversationId)).toEqual([])
  })

  it('ensureLocalRulesPlugin 不覆盖已有的 plugin.json', () => {
    const dir = join(PLUGINS, LOCAL_RULES_PLUGIN)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'plugin.json'), JSON.stringify({ name: LOCAL_RULES_PLUGIN, description: '用户自己写的' }), 'utf-8')
    ensureLocalRulesPlugin()
    expect(JSON.parse(readFileSync(join(dir, 'plugin.json'), 'utf-8')).description).toBe('用户自己写的')
    expect(existsSync(join(dir, 'hooks'))).toBe(true)
  })
})

describe('rule-writer：独立智能体', () => {
  it('在独立 Agent 里提的规则写进它自己的目录（hooks/ 由代码建好），结论来源是那个 Agent', async () => {
    const agentDir = join(HOME, '.openpipal', 'agents', 'ws-a')
    mkdirSync(agentDir, { recursive: true })
    writeFileSync(join(agentDir, 'meta.json'), JSON.stringify({ id: 'ws-a', name: '物理教案专家', icon: '🤖', description: '', createdAt: 1, updatedAt: 1 }), 'utf-8')
    const writer = vi.fn(async ({ rulesDir }: { rulesDir: string }) => {
      // 写手只拿到 hooks/ 本身：独立智能体目录里还有 agent.md / memory / skills，一条规则不该有改人设的权限
      expect(rulesDir).toBe(join(agentDir, 'hooks'))
      expect(existsSync(rulesDir)).toBe(true)
      writeFileSync(join(rulesDir, 'mask.ts'), GOOD, 'utf-8')
      return { success: true }
    })
    const notices = await requestRule({ ...request, workspaceId: 'ws-a' }, { writer, notify: () => {} })
    expect(writer).toHaveBeenCalledTimes(1)
    expect(notices).toHaveLength(1)
    expect(notices[0]).toMatchObject({ status: 'ok', hookId: 'agent:ws-a/mask', source: { kind: 'agent', id: 'ws-a', name: '物理教案专家' } })
    // 全局 local-rules 里不会多出文件
    expect(existsSync(join(PLUGINS, LOCAL_RULES_PLUGIN, 'hooks', 'mask.ts'))).toBe(false)
  })
})
