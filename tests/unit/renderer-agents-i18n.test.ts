import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createRendererI18n } from '../../src/renderer/src/i18n'

const AGENTS_PANEL_PATH = 'src/renderer/src/components/AgentsPanel.tsx'
const AGENT_EDITOR_PATH = 'src/renderer/src/components/AgentTemplateEditor.tsx'

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

    expect(english.t('agents.title')).toBe('My Agents')
    expect(english.t('agents.sections.generated')).toBe('Generated from conversations')
    expect(english.t('agents.metrics.memories', { count: 1 })).toBe('1 memory')
    expect(english.t('agents.metrics.memories', { count: 3 })).toBe('3 memories')
    expect(english.t('agents.metrics.tasks', { count: 1 })).toBe('1 automation')
    expect(english.t('agents.metrics.tasks', { count: 3 })).toBe('3 automations')
    expect(english.t('agents.editor.placeholders.workingDirectory')).toContain('global working folder')
    expect(english.t('agents.actions.editNamed', { name: '用户 Agent 🌟' })).toBe(
      'Edit Agent “用户 Agent 🌟”'
    )
    expect(chinese.t('agents.title')).toBe('我的 Agents')
    expect(chinese.t('agents.metrics.memories', { count: 3 })).toBe('3 条记忆')
    expect(chinese.t('agents.editor.actions.chooseWorkingDirectory')).toBe('选择工作目录')
  })

  it('removes hard-coded product Chinese from both migrated components', () => {
    const source = stripComments([AGENTS_PANEL_PATH, AGENT_EDITOR_PATH].map(read).join('\n'))
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
    const editor = read(AGENT_EDITOR_PATH)

    expect(panel).toContain('{template.icon}')
    expect(panel).toContain('{template.name}')
    expect(panel).toContain('{template.description}')
    expect(panel).toContain('title={template.workingDir}')
    expect(panel).toContain('{w.name}')
    expect(panel).toContain('{w.description}')
    expect(panel).toContain('newConversationFromAgent(roleName, agentId, agentName)')
    expect(panel).toContain('newConversationFromWorkspace(roleName, w.id, w.name)')
    expect(editor).toContain("useState(initial?.name || '')")
    expect(editor).toContain("useState(initial?.description || '')")
    expect(editor).toContain("useState(initial?.systemPrompt || '')")
    expect(editor).toContain("useState(initial?.workingDir || '')")
    expect(editor).toContain('name: name.trim()')
    expect(editor).toContain('description: description.trim()')
    expect(editor).toContain('systemPrompt,')
    expect(editor).toContain('workingDir: workingDir || undefined')

    expect(panel).not.toMatch(/translate\(\s*(?:template|w)\.(?:icon|description|workingDir)\b/)
    expect(editor).not.toMatch(/\bt\(\s*(?:name|description|icon|systemPrompt|workingDir)\b/)
  })

  it('formats saved dates from the live locale instead of freezing Chinese output', () => {
    const panel = read(AGENTS_PANEL_PATH)

    expect(panel).toContain('const locale = i18n.resolvedLanguage || i18n.language')
    expect(panel).toContain('formatLocaleDate(w.createdAt, locale)')
    expect(panel).not.toContain("toLocaleDateString('zh-CN')")
  })

  it('localizes icon-button labels and leaves room for translated or long user text', () => {
    const panel = read(AGENTS_PANEL_PATH)
    const editor = read(AGENT_EDITOR_PATH)
    const source = `${panel}\n${editor}`

    expect(panel).toContain("aria-label={translate('agents.actions.editNamed', { name: template.name })}")
    expect(panel).toContain("aria-label={translate('agents.actions.deleteNamed', { name: w.name })}")
    expect(editor).toContain("aria-label={t('agents.editor.actions.close')}")
    expect(editor).toContain("aria-label={t('agents.editor.actions.chooseWorkingDirectory')}")
    expect(editor).toContain('htmlFor="agent-template-system-prompt"')
    expect(editor).toContain('required')
    expect(source).toContain('flex-wrap')
    expect(source).toContain('break-words')
    expect(source).toContain('min-w-0')
  })
})
