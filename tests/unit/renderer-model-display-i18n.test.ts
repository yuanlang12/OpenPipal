import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createRendererI18n } from '../../src/renderer/src/i18n'
import { displayModelEntryName, displayModelGroupLabel } from '../../src/renderer/src/utils/modelDisplay'

const read = (path: string): string => readFileSync(resolve(path), 'utf8')

// Matches the blocklist idiom in tests/unit/renderer-settings-i18n.test.ts: strip comments first
// so unrelated prose (e.g. "内置服务商协议是固定的") doesn't false-positive the literal check.
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

describe('model display i18n (builtin redaction placeholders)', () => {
  it('never returns the wire sentinel for a builtin entry; passes non-builtin through unchanged', async () => {
    const i18n = await createRendererI18n('en')

    // 红线：builtin 条目绝不能回显 name/model 原始值——哪怕原值不是中文哨兵，也必须走占位符
    expect(displayModelEntryName({ name: '内置模型', builtin: true }, i18n.t)).toBe('Built-in model')
    expect(displayModelEntryName({ name: 'gpt-4o', builtin: true }, i18n.t)).toBe('Built-in model')
    expect(displayModelEntryName({ name: 'gpt-4o', builtin: false }, i18n.t)).toBe('gpt-4o')
    expect(displayModelEntryName({ name: 'gpt-4o' }, i18n.t)).toBe('gpt-4o')
  })

  it('accepts an alternate translation key for preset/provider namespaces', async () => {
    const i18n = await createRendererI18n('en')

    expect(displayModelEntryName({ name: 'x', builtin: true }, i18n.t, 'settings.model.preset.builtinModel')).toBe('Built-in model')
    expect(displayModelEntryName({ name: 'x', builtin: true }, i18n.t, 'settings.model.provider.builtinService')).toBe('Built-in service')
  })

  it('localizes both builtin-model and builtin-service placeholders per locale', async () => {
    const english = await createRendererI18n('en')
    const chinese = await createRendererI18n('zh-CN')

    expect(english.t('chat.modelControl.builtinModel')).toBe('Built-in model')
    expect(english.t('chat.modelControl.builtinService')).toBe('Built-in service')
    expect(chinese.t('chat.modelControl.builtinModel')).toBe('内置模型')
    expect(chinese.t('chat.modelControl.builtinService')).toBe('内置服务')

    expect(english.t('settings.model.preset.builtinModel')).toBe('Built-in model')
    expect(english.t('settings.model.provider.builtinService')).toBe('Built-in service')
    expect(chinese.t('settings.model.preset.builtinModel')).toBe('内置模型')
    expect(chinese.t('settings.model.provider.builtinService')).toBe('内置服务')
  })

  it('renders a builtin group as the localized service label and keeps the ungrouped fallback for an empty group', async () => {
    const i18n = await createRendererI18n('en')

    expect(displayModelGroupLabel('内置服务', true, i18n.t)).toBe('Built-in service')
    expect(displayModelGroupLabel('My Gateway', false, i18n.t)).toBe('My Gateway')
    expect(displayModelGroupLabel('', undefined, i18n.t)).toBe('Ungrouped')
  })

  it('routes builtin rendering in ModelControl.tsx and ModelSettings.tsx through the util/t() keys, never the raw Chinese literals', () => {
    const modelControl = read('src/renderer/src/components/shared/ModelControl.tsx')
    const modelSettings = read('src/renderer/src/components/ModelSettings.tsx')

    expect(modelControl).toContain("import { displayModelEntryName, displayModelGroupLabel } from '../../utils/modelDisplay'")
    expect(modelControl).toContain('displayModelEntryName(m, t)')
    expect(modelControl).toContain('displayModelGroupLabel(group, groupIsBuiltin, t)')

    expect(modelSettings).toContain("import { displayModelEntryName } from '../utils/modelDisplay'")
    expect(modelSettings).toContain("displayModelEntryName(p, t, 'settings.model.preset.builtinModel')")
    expect(modelSettings).toContain("displayModelEntryName({ name: p.model, builtin: p.builtin }, t, 'settings.model.preset.builtinModel')")
    expect(modelSettings).toContain("displayModelEntryName(prov, t, 'settings.model.provider.builtinService')")

    // Blocklist idiom (see tests/unit/renderer-settings-i18n.test.ts): the redaction placeholder
    // text itself must never appear as a raw literal in the components that render it (comments
    // stripped first so unrelated prose containing the same characters doesn't false-positive).
    const modelControlCode = stripComments(modelControl)
    const modelSettingsCode = stripComments(modelSettings)
    expect(modelControlCode).not.toContain('内置服务')
    expect(modelControlCode).not.toContain('内置模型')
    expect(modelSettingsCode).not.toContain('内置服务')
    expect(modelSettingsCode).not.toContain('内置模型')
  })
})
