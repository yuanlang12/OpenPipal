import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { createRendererI18n } from '../../src/renderer/src/i18n'

const read = (path: string): string => readFileSync(resolve(path), 'utf8')

const FILES = {
  goal: 'src/renderer/src/components/artifacts/GoalTab.tsx',
  mcp: 'src/renderer/src/components/artifacts/McpAppPreview.tsx',
  orb: 'src/renderer/src/components/artifacts/CanvasOrb.tsx',
} as const

async function loadCanvasCommands() {
  vi.stubGlobal('localStorage', {
    getItem: () => null,
    setItem: () => undefined,
    removeItem: () => undefined,
  })
  return (await import('../../src/renderer/src/components/artifacts/CanvasOrb')).getCanvasOrbCommands
}

afterAll(() => vi.unstubAllGlobals())

describe('active artifact runtime i18n', () => {
  it('serves matching Chinese and English chrome and explicit Canvas command payloads', async () => {
    const getCanvasOrbCommands = await loadCanvasCommands()
    const english = await createRendererI18n('en')
    const chinese = await createRendererI18n('zh-CN')

    expect(english.t('artifacts.goal.status.active')).toBe('In progress')
    expect(chinese.t('artifacts.goal.status.active')).toBe('追逐中')
    expect(english.t('artifacts.mcpApp.capabilities.clipboard-read.label')).toBe('Read clipboard')
    expect(chinese.t('artifacts.mcpApp.capabilities.clipboard-read.label')).toBe('读剪贴板')
    expect(english.t('artifacts.mcpApp.permissionCount', { count: 2 })).toBe('2 permissions')
    expect(chinese.t('artifacts.mcpApp.permissionCount', { count: 2 })).toBe('2 项权限')
    expect(getCanvasOrbCommands(english.t).map(command => [command.id, command.label, command.message])).toEqual([
      ['look', 'Take a look', 'Take a look'],
      ['idea', 'Give me an idea', 'Give me an idea'],
      ['check', 'Am I doing this right?', 'Am I doing this right?'],
    ])
    expect(getCanvasOrbCommands(chinese.t).map(command => [command.id, command.label, command.message])).toEqual([
      ['look', '让我看看', '让我看看'],
      ['idea', '给我一点想法', '给我一点想法'],
      ['check', '我做得对吗', '看下我做得对吗'],
    ])
  })

  it('switches future Canvas commands immediately without mutating a sent message', async () => {
    const getCanvasOrbCommands = await loadCanvasCommands()
    const i18n = await createRendererI18n('en')
    const sentMessage = getCanvasOrbCommands(i18n.t)[2].message

    await i18n.changeLanguage('zh-CN')
    const nextMessage = getCanvasOrbCommands(i18n.t)[2].message

    expect(sentMessage).toBe('Am I doing this right?')
    expect(nextMessage).toBe('看下我做得对吗')
    expect(sentMessage).not.toBe(nextMessage)
  })

  it('keeps goal content, MCP protocol data, iframe HTML, and capability IDs raw', () => {
    const goal = read(FILES.goal)
    const mcp = read(FILES.mcp)
    const orb = read(FILES.orb)

    expect(goal).toContain('{goal.text}')
    expect(goal).toContain("goal.lastCheck.reason || t('artifacts.goal.noReason')")
    expect(goal).not.toMatch(/t\(\s*goal\.(?:text|lastCheck\.reason)/)

    expect(mcp).toContain('injectBootstrap(payload.html, payload)')
    expect(mcp).toContain('approveMcpAppPerms(payload.serverName, payload.serverBinding, requestedKnown, payload.conversationId)')
    expect(mcp).toContain("'clipboard-read', 'clipboard-write'")
    expect(mcp).toContain("const allowAttr = grantedCaps.length > 0 ? grantedCaps.join('; ') : undefined")
    expect(mcp).toContain('title={`mcp-app-${payload.toolName}`}')
    expect(mcp).not.toMatch(/t\(\s*payload\.(?:html|serverName|toolName|args|result)/)

    expect(orb).toContain('handleChip(command.message)')
    expect(orb).toContain('void sendMessage(\n      message,')

  })

  it('includes narrow-layout and accessibility safeguards for 400px artifact panels', () => {
    const goal = read(FILES.goal)
    const mcp = read(FILES.mcp)
    const orb = read(FILES.orb)

    expect(goal).toContain('role="progressbar"')
    expect(goal).toContain('aria-valuenow={progressPct}')
    expect(goal).toContain('aria-label={t(\'artifacts.goal.clearTitle\')}')

    expect(mcp).toContain('w-full min-w-0 max-w-md')
    expect(mcp).toContain('flex flex-col gap-2 pt-1 sm:flex-row')
    expect(mcp).toContain('break-all')
    expect(mcp).toContain('aria-label={isFullscreen')

    expect(orb).toContain('pointer-events-none absolute inset-x-5')
    expect(orb).toContain('pointer-events-auto flex max-w-full')
    expect(orb).toContain('flex-wrap justify-end')
    expect(orb).toContain('aria-expanded={expanded}')
    expect(orb).toContain('aria-controls="canvas-orb-commands"')

  })
})
