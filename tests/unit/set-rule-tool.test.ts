/**
 * set_rule 工具与它的登记 / 链路守卫：
 *   工具本身：只递交、立刻返回、不等后台；description 为空报错。
 *   三处登记（红线）：产品工具定义 / COMMON_TOOLS / classifyToolRisk=safe；子 agent 黑名单里有它。
 *   后台侧：Evolver 有 set-rule 技能（范例能否加载在 hook-creator-skill.test 里与前台范例一起验）；
 *   写手与结论通道由 ipc-handlers 注册，结论走本轮探针同一条 chat:hook-notice。
 */
import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const HOME = mkdtempSync(join(tmpdir(), 'openpipal-set-rule-'))
process.env.HOME = HOME
process.env.OPENPIPAL_ISOLATED_HOME = HOME

const { createSetRuleTool } = await import('../../src/main/hooks/set-rule-tool')
const { classifyToolRisk } = await import('../../src/main/pi-security')
const { COMMON_TOOLS } = await import('../../src/main/role-manager')
const { HOOK_EVENT_NAMES } = await import('../../src/main/hooks/hook-types')

const root = join(__dirname, '../..')
const read = (rel: string): string => readFileSync(join(root, rel), 'utf-8')

describe('set_rule 工具', () => {
  it('只递交、立刻返回：后台永不完成也不阻塞工具结果', async () => {
    const requestRule = vi.fn(() => new Promise<never>(() => {}))
    const tool = createSetRuleTool({ conversationId: 'c1', roleName: 'coding', workspaceId: 'ws-1' }, { requestRule })
    expect(tool.name).toBe('set_rule')
    const result = await Promise.race([
      tool.execute('call-1', { description: '读成绩表前先遮名字', details: 'read 成绩文件时遮姓名' }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('工具在等后台')), 200))
    ]) as { content: Array<{ type: string; text: string }> }
    expect(result.content[0].text).toMatch(/已交给后台/)
    expect(result.content[0].text).toMatch(/继续当前任务/)
    expect(requestRule).toHaveBeenCalledWith({
      description: '读成绩表前先遮名字',
      details: 'read 成绩文件时遮姓名',
      conversationId: 'c1',
      roleName: 'coding',
      workspaceId: 'ws-1'
    })
  })

  it('description 为空直接报错，不递交；details 缺省用 description 顶上', async () => {
    const requestRule = vi.fn(async () => [])
    const tool = createSetRuleTool({}, { requestRule })
    const empty = await tool.execute('c', { description: '  ', details: 'x' }) as { content: Array<{ text: string }> }
    expect(empty.content[0].text).toMatch(/^error/)
    expect(requestRule).not.toHaveBeenCalled()
    await tool.execute('c', { description: '别再跑 rm -rf' })
    expect(requestRule.mock.calls[0][0]).toMatchObject({ description: '别再跑 rm -rf', details: '别再跑 rm -rf' })
  })

  it('三处登记：产品工具定义 / COMMON_TOOLS / classifyToolRisk=safe；子 agent 与定时任务的口径', () => {
    expect(read('src/main/openpipal-product-tools.ts')).toMatch(/createSetRuleTool\(\{ conversationId: overrides\?\.conversationId, roleName, workspaceId: overrides\?\.workspaceId \}\)/)
    expect(COMMON_TOOLS).toContain('set_rule')
    expect(classifyToolRisk('set_rule', { description: 'x', details: 'y' }).level).toBe('safe')
    expect(read('src/main/subagent-runner.ts')).toMatch(/'set_rule'/)
    // 定时任务里定规则没有 UI 可提醒，但规则照样落到插件页——不拦
    expect(read('src/main/agent-runtime/source-tool-policy.ts')).not.toMatch(/'set_rule'/)
  })

  it('前台技能只讲怎么递交：不再教模型自己写文件，判断何时该定规则归工具说明', () => {
    const skill = read('resources/skills/hook-creator/SKILL.md')
    expect(skill).toMatch(/`set_rule` 怎么填/)
    expect(skill).not.toMatch(/用 write 工具写/)
    expect(skill).not.toMatch(/references\//)
  })

  it('后台侧：Evolver 的 set-rule 技能讲全三个事件；evolverSetRule 吃 RuleWriterInput、把类型声明附进消息', () => {
    const skill = read('resources/system-agents/evolver/skills/set-rule/SKILL.md')
    expect(skill).toMatch(/^name: set-rule$/m)
    for (const name of HOOK_EVENT_NAMES) expect(skill).toContain(`\`${name}\``)
    expect(read('resources/system-agents/evolver/agent.md')).toMatch(/set-rule/)
    const evolver = read('src/main/evolver-agent.ts')
    expect(evolver).toMatch(/export async function evolverSetRule\(input: RuleWriterInput\)/)
    // workspaceId 必须传：租户边界把 agents/ 下的一切当别人的，缺了它写手在独立智能体目录里一个文件也写不出来（评审实测）
    expect(evolver).toMatch(/runEvolver\('set-rule', userMessage, input\.rulesDir, \[\], \{ assignedRoot: input\.rulesDir, workspaceId: input\.workspaceId, conversationId: input\.conversationId \}\)/)
    // 失败结论里的模型名按显示口径：内置凭证遮成"内置模型"（红线：内置模型名不出主进程）
    expect(evolver).toMatch(/isBuiltinModelCredential\(mc\) \? '内置模型' : model\.id/)
    // 后台四种活（save-agent / dream / extract / set-rule）同一条路：按来源会话钉住的预设路由，不回落到全局默认；失败结论带模型 id
    expect(evolver).toMatch(/getConversationPinnedPreset\(scope\.conversationId\)/)
    expect(evolver).toMatch(/resolveConversationModelConfig\(pinnedPreset\)/)
    for (const skill of ['save-agent', 'dream', 'extract-memory']) expect(evolver).toMatch(new RegExp(`runEvolver\\('${skill}'[\\s\\S]*?conversationId,\\n\\s*\\}\\)`))
    expect(evolver).not.toMatch(/getPiModel\(\)/)
    expect(evolver).toMatch(/error: `\$\{modelLabel\}：\$\{error\}`/)
    expect(evolver).toMatch(/hook-creator', 'references', 'hook-types\.d\.ts'/)
    // 独立智能体里提的规则写进它自己的目录：位置即范围，写手不再加 workspaceId 判断、不加名字后缀
    expect(evolver).toMatch(/Requested inside standalone Agent[\s\S]*?apply only to this Agent\. Do not add workspaceId guards/)
    expect(skill).toMatch(/放在某个独立智能体自己目录里的只对它生效/)
  })

  it('独立智能体也看得见 hook-creator：技能自己声明 agent-scope: all，HookContext 两边都带 workspaceId', () => {
    expect(read('resources/skills/hook-creator/SKILL.md')).toMatch(/^\s+agent-scope: all$/m)
    expect(read('src/main/hooks/hook-types.ts')).toMatch(/workspaceId\?: string/)
    expect(read('resources/skills/hook-creator/references/hook-types.d.ts')).toMatch(/workspaceId\?: string/)
    expect(read('src/main/agent-runtime/pi-core-runtime.ts')).toMatch(/resolveHookChain\(\{[\s\S]*?workspaceId: workspace\.workspaceId/)
  })

  it('结论通道：ipc 注册写手与 sink，结论逐条走 chat:hook-notice（与本轮探针同一条路，cid 可空）', () => {
    const ipc = read('src/main/ipc-handlers.ts')
    expect(ipc).toMatch(/setRuleWriter\(\(input\) => import\('\.\/evolver-agent'\)\.then\(\(m\) => m\.evolverSetRule\(input\)\)\)/)
    expect(ipc).toMatch(/setRuleNoticeSink\(\(request, notices\)[\s\S]*?for \(const notice of notices\) win\.webContents\.send\('chat:hook-notice', request\.conversationId \?\? null, notice\)/)
    expect(read('src/preload/index.ts')).toMatch(/onHookNotice: \(callback: \(conversationId: string \| null, notice: any\)/)
    expect(read('src/preload/index.d.ts')).toMatch(/onHookNotice\?: \(callback: \(conversationId: string \| null, notice: HookNotice\)/)
  })
})
