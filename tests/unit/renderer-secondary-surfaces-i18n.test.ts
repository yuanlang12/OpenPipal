import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Task } from '../../src/renderer/src/types'
import { createRendererI18n } from '../../src/renderer/src/i18n'
import { isExactWorkdaySet, taskTriggerLabel } from '../../src/renderer/src/components/TasksPanel'
import { getBuiltinTaskTemplates } from '../../src/renderer/src/components/TaskTemplates'

const read = (path: string): string => readFileSync(resolve(path), 'utf8')

const MIGRATED_FILES = [
  'src/renderer/src/components/TasksPanel.tsx',
  'src/renderer/src/components/OutputCenterPanel.tsx',
  'src/renderer/src/components/AgentWorkspaceInspector.tsx',
  'src/renderer/src/components/TaskEditor.tsx',
  'src/renderer/src/components/TaskTemplates.tsx',
]

function fixedTask(days: string[]): Task {
  return {
    id: 'task-1',
    name: '用户任务名',
    enabled: true,
    trigger: { type: 'schedule', schedule: { type: 'fixed', time: '09:30', days } },
    prompt: '用户 prompt',
    conversationMode: 'per-run',
    createdAt: 1,
    updatedAt: 1,
  }
}

describe('secondary renderer surfaces i18n', () => {
  it('serves matching English and Chinese resources', async () => {
    const english = await createRendererI18n('en')
    const chinese = await createRendererI18n('zh-CN')

    expect(english.t('tasks.actions.create')).toBe('New task')
    expect(english.t('tasks.editor.namePlaceholder')).toBe('Task title')
    expect(english.t('tasks.templates.title')).toBe('Task templates')
    expect(english.t('outputCenter.searchPlaceholder')).toBe('Search all works…')
    expect(english.t('agentWorkspace.actions.revealInFinder')).toBe('Show in Finder')
    expect(chinese.t('tasks.actions.create')).toBe('新建任务')
    expect(chinese.t('tasks.editor.namePlaceholder')).toBe('任务标题')
    expect(chinese.t('tasks.templates.title')).toBe('任务模板')
    expect(chinese.t('outputCenter.searchPlaceholder')).toBe('搜索所有作品…')
    expect(chinese.t('agentWorkspace.actions.revealInFinder')).toBe('在 Finder 中打开')
  })

  it('builds all eight product templates from the active locale without changing their identities', async () => {
    const i18n = await createRendererI18n('en')
    const english = getBuiltinTaskTemplates(i18n.getFixedT('en'))
    const chinese = getBuiltinTaskTemplates(i18n.getFixedT('zh-CN'))

    expect(english).toHaveLength(8)
    expect(chinese).toHaveLength(8)
    expect(new Set(english.map(template => template.id)).size).toBe(8)
    expect(chinese.map(template => template.id)).toEqual(english.map(template => template.id))
    expect(chinese.map(template => template.icon)).toEqual(english.map(template => template.icon))

    for (let index = 0; index < english.length; index += 1) {
      const englishTemplate = english[index]
      const chineseTemplate = chinese[index]
      expect(englishTemplate.name.trim()).not.toBe('')
      expect(englishTemplate.description.trim()).not.toBe('')
      expect(englishTemplate.prompt.trim()).not.toBe('')
      expect(englishTemplate.name).not.toMatch(/[\u3400-\u9fff]/)
      expect(englishTemplate.description).not.toMatch(/[\u3400-\u9fff]/)
      expect(englishTemplate.prompt).not.toMatch(/[\u3400-\u9fff]/)
      expect(chineseTemplate.name).not.toBe(englishTemplate.name)
      expect(chineseTemplate.description).not.toBe(englishTemplate.description)
      expect(chineseTemplate.prompt).not.toBe(englishTemplate.prompt)
    }

    expect(english.find(template => template.id === 'miniGameBuilder')?.prompt).toContain('outputs/')
    expect(chinese.find(template => template.id === 'miniGameBuilder')?.prompt).toContain('outputs/')
  })

  it('recognizes only the exact Monday-to-Friday set and leaves day payloads unchanged', async () => {
    expect(isExactWorkdaySet(['mon', 'tue', 'wed', 'thu', 'fri'])).toBe(true)
    expect(isExactWorkdaySet(['mon', 'tue', 'wed', 'thu', 'sat'])).toBe(false)
    expect(isExactWorkdaySet(['mon', 'tue', 'wed', 'thu', 'fri', 'fri'])).toBe(true)
    expect(isExactWorkdaySet(['mon', 'tue', 'wed', 'thu', 'thu'])).toBe(false)

    const i18n = await createRendererI18n('en')
    const days = ['sat', 'mon']
    const original = [...days]
    expect(taskTriggerLabel(fixedTask(days), i18n.getFixedT('en'), 'en')).toBe('Sat/Mon at 09:30')
    expect(days).toEqual(original)
    expect(taskTriggerLabel(fixedTask(['mon', 'tue', 'wed', 'thu', 'fri']), i18n.getFixedT('en'), 'en'))
      .toBe('Weekdays at 09:30')
  })

  it('does not crash when an older task contains malformed weekday values', async () => {
    const i18n = await createRendererI18n('en')
    const malformed = fixedTask([])
    ;(malformed.trigger as any).schedule.days = ['mon', null, 7, 'fri']

    expect(() => taskTriggerLabel(malformed, i18n.getFixedT('en'), 'en')).not.toThrow()
    expect(taskTriggerLabel(malformed, i18n.getFixedT('en'), 'en')).toBe('Mon/Fri at 09:30')
    expect(isExactWorkdaySet(['mon', null, 7, 'tue', 'wed', 'thu', 'fri'])).toBe(true)
  })

  it('keeps dynamic names, prompts, errors, paths, and content outside translation calls', () => {
    const tasks = read(MIGRATED_FILES[0])
    const output = read(MIGRATED_FILES[1])
    const workspace = read(MIGRATED_FILES[2])
    const editor = read(MIGRATED_FILES[3])
    const templates = read(MIGRATED_FILES[4])

    expect(tasks).toContain('{t.name}')
    expect(tasks).toContain('{entry.reason}')
    expect(tasks).toContain('[{entry.source}]')
    expect(output).toContain('entry.title')
    expect(output).toContain('entry.conversationTitle')
    expect(output).toContain('entry.workspaceName')
    expect(workspace).toContain('**${task.name}**')
    expect(workspace).toContain('${task.prompt}')
    expect(workspace).toContain('<Markdown content={selectedNode.content} />')
    expect(workspace).toContain('path: `tasks/${task.id}`')
    expect(editor).toContain("useState(task?.name || '')")
    expect(editor).toContain("useState(task?.prompt || '')")
    expect(editor).toContain('value={cron}')
    expect(editor).toContain('value={webhookSecret}')
    expect(editor).toContain('value={webhookUrl}')
    expect(editor).toContain('{w.name}')
    expect(editor).toContain('{a.name}')
    expect(templates).toContain('getBuiltinTaskTemplates(t)')
    expect(templates).toContain('onPick(tpl)')

    const source = [tasks, output, workspace, editor].join('\n')
    expect(source).not.toMatch(/(?:translate|\bt)\(\s*(?:t\.name|entry\.reason|entry\.source|entry\.title|entry\.conversationTitle|entry\.workspaceName|task\.name|task\.prompt|selectedNode\.content)/)
    expect(editor).not.toMatch(/\bt\(\s*(?:name|prompt|cron|webhookSecret|webhookUrl|w\.name|a\.name)\b/)
  })

  it('uses fluid layouts for translated copy and dynamic errors', () => {
    const source = MIGRATED_FILES.map(read).join('\n')
    expect(source).toContain('flex-wrap')
    expect(source).toContain('break-words')
    expect(source).toContain('break-all')
    expect(source).not.toMatch(/w-\[(?:80|96|100|120|160|180|200)px\][^\n]*(?:translate\(|\bt\()/)
  })
})
