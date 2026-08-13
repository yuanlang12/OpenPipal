import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createRendererI18n } from '../../src/renderer/src/i18n'
import {
  BUILT_IN_CLI_TRANSLATION_KEYS,
  resolveCliToolDisplay,
} from '../../src/renderer/src/i18n/cliToolDisplay'

const read = (path: string): string => readFileSync(resolve(path), 'utf8')

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

describe('renderer Tools and Skills Hub i18n', () => {
  it('serves English and Chinese product chrome with identical dynamic values', async () => {
    const english = await createRendererI18n('en')
    const chinese = await createRendererI18n('zh-CN')
    const dynamicName = '用户 Skill / أداة 🔧'

    expect(english.t('toolsHub.title')).toBe('Plugins')
    expect(english.t('toolsHub.mcp.needsAuthorization')).toContain('Authorization required')
    expect(english.t('toolsHub.cli.installedCount', { count: 2 })).toBe('2 installed')
    expect(english.t('toolsHub.plugins.overwritePrompt', { names: dynamicName })).toContain(dynamicName)
    expect(english.t('toolsHub.skills.pluginOriginTitle', { name: dynamicName })).toContain(dynamicName)
    expect(english.t('toolsHub.skills.fileCount', { count: 1 })).toBe('1 file')

    expect(chinese.t('toolsHub.title')).toBe('插件')
    expect(chinese.t('toolsHub.skills.importSelected', { count: 2 })).toBe('导入 2 个技能')
    expect(chinese.t('toolsHub.plugins.byAuthor', { author: dynamicName })).toContain(dynamicName)
  })

  it('removes migrated Chinese UI literals from production code', () => {
    const production = stripComments([
      read('src/renderer/src/components/ToolsHub.tsx'),
      read('src/renderer/src/components/SkillsHub.tsx'),
    ].join('\n'))

    expect(production).not.toMatch(/[\u3400-\u9fff\uf900-\ufaff]/u)
  })

  it('keeps protocol fields and external content outside translation calls', () => {
    const tools = read('src/renderer/src/components/ToolsHub.tsx')
    const skills = read('src/renderer/src/components/SkillsHub.tsx')

    expect(tools).toContain("return { command: 'npx', args: ['-y', formPackage.trim()], env }")
    expect(tools).toContain("return { command: formCommand.trim(), args: formArgs.trim() ? formArgs.trim().split(/\\s+/) : [], env }")
    expect(tools).toContain("s.error || t('toolsHub.mcp.connectionFailed')")
    expect(tools).toContain("installMsg.raw || (installMsg.key ? t(installMsg.key, installMsg.values) : '')")
    expect(tools).toContain("p.warnings.join('; ')")
    expect(tools).toContain('{tool.command}')
    expect(tools).toContain('{tool.display.name}')
    expect(tools).toContain('{tool.display.description}')
    expect(tools).toContain('resolveCliToolDisplay(tool, key => t(key))')

    expect(skills).toContain('{skill.name}')
    expect(skills).toContain('{skill.description}')
    expect(skills).toContain('{c.name}')
    expect(skills).toContain('{c.description}')
    expect(skills).toContain("error.raw || (error.key ? t(error.key, error.values) : '')")
    expect(skills).toContain("<Markdown content={selectedNode.content || ''} />")
    expect(skills).toContain("<code>{selectedNode.content || ''}</code>")
    expect(skills).toContain('{selectedNode.path}')
  })

  it('keeps tabs, switches, dialogs, file selection, and icon actions accessible', () => {
    const tools = read('src/renderer/src/components/ToolsHub.tsx')
    const skills = read('src/renderer/src/components/SkillsHub.tsx')

    expect(tools).toContain('role="tablist"')
    expect(tools).toContain('role="tab"')
    expect(tools).toContain('aria-selected={activeTab === tab.key}')
    expect(tools).toContain('role="switch"')
    expect(tools).toContain('aria-checked={p.enabled}')
    expect(tools).toContain("aria-label={t('toolsHub.mcp.deleteServer'")
    expect(tools).toContain("aria-label={t('toolsHub.cli.deleteTool'")

    expect(skills).toContain('role="dialog"')
    expect(skills).toContain('aria-modal="true"')
    expect(skills).toContain('role="switch"')
    expect(skills).toContain('aria-checked={skill.enabled}')
    expect(skills).toContain("aria-current={selectedFile === f.path ? 'true' : undefined}")
    expect(skills).toContain("aria-label={t('common.actions.close')}")
    expect(skills).toContain('focus-visible:ring-2')
  })

  it('allows long translations and external metadata to shrink or wrap at narrow widths', () => {
    const tools = read('src/renderer/src/components/ToolsHub.tsx')
    const skills = read('src/renderer/src/components/SkillsHub.tsx')

    expect(tools).toContain('px-4 sm:px-8')
    expect(tools).toContain('flex flex-col sm:flex-row')
    expect(tools).toContain('w-full min-w-0 flex-1')
    expect(tools).toContain('flex flex-wrap items-center')
    expect(tools).toContain('min-w-0 break-words')
    expect(tools).toContain('text-[12px] break-all')
    expect(tools).toContain('truncate')
    expect(tools).toContain('min-w-0 max-w-full')

    expect(skills).toContain('flex flex-col sm:flex-row')
    expect(skills).toContain('flex flex-wrap items-center')
    expect(skills).toContain('min-w-0')
    expect(skills).toContain('break-all')
    expect(skills).toContain('break-words')
    expect(skills).toContain('title={selectedNode.path}')
  })

  it('maps only stable built-in commands and updates their copy with the active locale', async () => {
    const i18n = await createRendererI18n('en')
    const builtIn = {
      command: 'lark-cli',
      name: '飞书 CLI（主进程原值）',
      description: '主进程协议描述',
      builtIn: true,
    }

    expect(Object.keys(BUILT_IN_CLI_TRANSLATION_KEYS).sort()).toEqual([
      'aws', 'az', 'bun', 'convert', 'curl', 'dingtalk', 'docker', 'ffmpeg',
      'gcloud', 'gh', 'git', 'jq', 'lark-cli', 'netlify', 'node', 'npm',
      'ollama', 'pip3', 'pnpm', 'python3', 'supabase', 'vercel', 'wrangler',
    ].sort())
    expect(resolveCliToolDisplay(builtIn, key => i18n.t(key))).toEqual({
      name: 'Lark CLI',
      description: 'Manage Lark messages, calendars, and approvals from the command line',
    })

    await i18n.changeLanguage('zh-CN')
    expect(resolveCliToolDisplay(builtIn, key => i18n.t(key))).toEqual({
      name: '飞书 CLI',
      description: '通过命令行管理飞书或 Lark 的消息、日历和审批',
    })
  })

  it('preserves unknown built-ins and 400-character custom metadata verbatim', async () => {
    const i18n = await createRendererI18n('en')
    const longName = `用户自定义 🔧 ${'界'.repeat(400)}`
    const longDescription = `وصف مخصص ${'x'.repeat(400)}`
    const unknownBuiltIn = {
      command: 'future-openpipal-cli',
      name: longName,
      description: longDescription,
      builtIn: true,
    }
    const custom = { ...unknownBuiltIn, command: '/用户/bin/custom', builtIn: false }

    expect(resolveCliToolDisplay(unknownBuiltIn, key => i18n.t(key))).toEqual({
      name: longName,
      description: longDescription,
    })
    expect(resolveCliToolDisplay(custom, key => i18n.t(key))).toEqual({
      name: longName,
      description: longDescription,
    })
  })
})
