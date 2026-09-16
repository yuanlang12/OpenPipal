import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createRendererI18n } from '../../src/renderer/src/i18n'

const AGENTS_PANEL_PATH = 'src/renderer/src/components/AgentsPanel.tsx'

const read = (path: string): string => readFileSync(resolve(path), 'utf8')

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

describe('renderer Agents i18n', () => {
  it('serves matching English and Chinese panel, metric, and editor chrome', async () => {
    const english = await createRendererI18n('en')
    const chinese = await createRendererI18n('zh-CN')

    // 产品面向用户的词是 Pal（2026-09-08 所有者定），Agent 只留在协议 / 定位一类的技术口径里
    expect(english.t('agents.title')).toBe('My Pals')
    expect(english.t('agents.actions.create')).toBe('Create')
    expect(english.t('agents.actions.tryIt')).toBe('Try it')
    expect(english.t('agents.metrics.memories', { count: 1 })).toBe('1 memory')
    expect(english.t('agents.metrics.memories', { count: 3 })).toBe('3 memories')
    expect(english.t('agents.metrics.tasks', { count: 1 })).toBe('1 automation')
    expect(english.t('agents.metrics.tasks', { count: 3 })).toBe('3 automations')
    expect(english.t('agents.actions.editNamed', { name: '用户 Agent 🌟' })).toBe(
      'Edit Pal “用户 Agent 🌟”'
    )
    expect(chinese.t('agents.title')).toBe('我的 Pal')
    expect(chinese.t('agents.actions.create')).toBe('创建')
    expect(chinese.t('agents.actions.tryIt')).toBe('试一下')
    expect(chinese.t('agents.metrics.memories', { count: 3 })).toBe('3 条记忆')
  })

  it('removes hard-coded product Chinese from the panel', () => {
    const source = stripComments(read(AGENTS_PANEL_PATH))
    const migratedLiterals = [
      '编辑 Agent',
      '我的 Agents',
      '新建对话',
      '加载中...',
      '还没有保存的 Agent',
      '从对话中生成',
      '手动创建的模板',
      '确认删除',
      '条记忆',
      '个任务',
      '工作目录',
      '系统提示词',
      '定义这个 Agent 的角色',
    ]

    for (const literal of migratedLiterals) expect(source).not.toContain(literal)
  })

  it('keeps Agent content, prompts, paths, icons, and names outside translation lookup', () => {
    const panel = read(AGENTS_PANEL_PATH)

    expect(panel).toContain('name={w.name}')
    expect(panel).toContain('description={w.description}')
    // 模板已并入 Pal：面板里没有模板行、没有模板编辑器；Pal 会话的 role 槽位由 chatStore 固定
    expect(panel).not.toMatch(/template/i)
    expect(panel).toContain("startConversationWith({ id: w.id, kind: 'pal', name: w.name })")
    // 「创建」去通用助手：在那里聊完"保存为 Pal"才是新建的路，不是在当前角色下开空对话
    expect(panel).toContain('const CREATE_ROLE = DEFAULT_AGENT_ID')
    expect(panel).toContain('newConversation(CREATE_ROLE)')

    expect(panel).not.toMatch(/translate\(\s*w\.(?:icon|description|workingDir)\b/)
  })

  it('never freezes Chinese date output（列表版不再显示创建日期，但也不许再出现写死的 zh-CN 格式化）', () => {
    const panel = read(AGENTS_PANEL_PATH)

    expect(panel).not.toContain("toLocaleDateString('zh-CN')")
  })

  it('localizes icon-button labels and leaves room for translated or long user text', () => {
    const panel = read(AGENTS_PANEL_PATH)
    const source = panel

    expect(panel).toContain("aria-label={translate('agents.actions.deleteNamed', { name })}")
    // 团队行把悬停按钮文字换成"开个话题"，缺省仍是本地化的"试一下"
    expect(panel).toContain("tryLabel ?? translate('agents.actions.tryIt')")
    expect(source).toContain('flex-wrap')
    expect(source).toContain('break-words')
    expect(source).toContain('min-w-0')
  })
})
