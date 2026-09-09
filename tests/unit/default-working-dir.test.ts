/**
 * 默认工作目录（所有者 2026-09-09 提的功能）：
 *   设置页那项「工作目录」以前只管沙箱根与安全层，对话真正在哪干活它说了不算——没单独选目录的对话
 *   一律在 ~/.openpipal/workspace。现在它就是对话的默认：会话选的 > Pal 自己 tools/config.json 的 > 设置里选的 > App 自带 workspace，
 *   运行时、目录条、设置页从同一处取。
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'

const state: { configured?: string; palDir?: string } = {}
vi.mock('../../src/main/config-manager', () => ({
  getConfiguredWorkingDir: () => state.configured,
  isAutoMemoryEnabled: () => false
}))
vi.mock('../../src/main/agent-workspace-store', () => ({
  readToolsConfig: (id: string) => (id === 'pal-with-dir' ? { workingDir: state.palDir } : {}),
  readMeMd: () => ''
}))
vi.mock('../../src/main/data-root', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/data-root')>()),
  getDataRoot: () => '/home/.openpipal',
  dataPath: (...segs: string[]) => ['/home/.openpipal', ...segs].join('/')
}))
vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => process.cwd(), getPath: () => '/home' } }))

const core = await import('../../src/main/agent-runtime/openpipal-prompt-core')
const read = (file: string): string => readFileSync(file, 'utf8')

describe('默认工作目录的优先级', () => {
  it('没选过：App 自带的 workspace', () => {
    state.configured = undefined
    expect(core.resolveDefaultWorkingDir()).toBe('/home/.openpipal/workspace')
    expect(core.resolveOpenPipalWorkingDirectory({ systemPrompt: '' }).workingDir).toBe('/home/.openpipal/workspace')
  })

  it('设置里选了：全局对话用它；Pal 自己设了的仍用自己的；会话单独选的最优先', () => {
    state.configured = '/home/Projects'
    state.palDir = '/home/pal-work'
    expect(core.resolveDefaultWorkingDir()).toBe('/home/Projects')
    expect(core.resolveDefaultWorkingDir('pal-without-dir')).toBe('/home/Projects')
    expect(core.resolveDefaultWorkingDir('pal-with-dir')).toBe('/home/pal-work')
    expect(core.resolveOpenPipalWorkingDirectory({ systemPrompt: '', workspaceId: 'pal-with-dir' }).workingDir).toBe('/home/pal-work')
    expect(core.resolveOpenPipalWorkingDirectory({ systemPrompt: '', workspaceId: 'pal-with-dir', workingDir: '/home/this-chat' }).workingDir).toBe('/home/this-chat')
  })
})

describe('接线', () => {
  it('IPC：get-default-working-dir 给 configured + effective；reset 删配置并同步沙箱根', () => {
    const ipc = read('src/main/ipc-handlers.ts')
    expect(ipc).toMatch(/ipcMain\.handle\('config:get-default-working-dir'[\s\S]*?configured: getConfiguredWorkingDir\(\) \?\? null[\s\S]*?effective: resolveDefaultWorkingDir\(/)
    expect(ipc).toMatch(/ipcMain\.handle\('config:reset-working-dir'[\s\S]*?clearWorkingDir\(\)[\s\S]*?replaceGlobalWorkspaceRoot\(getWorkingDir\(\)\)[\s\S]*?syncSandboxWorkspaceRoots\(\)/)
    const preload = read('src/preload/index.ts')
    expect(preload).toContain("ipcRenderer.invoke('config:get-default-working-dir', workspaceId)")
    expect(preload).toContain("ipcRenderer.invoke('config:reset-working-dir')")
  })

  it('设置页显示实际默认、能恢复默认；目录条没选目录时显示默认并标"默认"', () => {
    const settings = read('src/renderer/src/components/AppSettings.tsx')
    expect(settings).toContain('{workingDir.configured ?? workingDir.effective}')
    expect(settings).toContain("t('settings.apps.workingDirectory.reset')")
    expect(settings).toContain("t('settings.apps.workingDirectory.unsetHint')")
    expect(settings).not.toContain("'~/Documents'")
    const bar = read('src/renderer/src/components/shared/WorkingDirBar.tsx')
    expect(bar).toMatch(/getDefaultWorkingDir\?\.\(activeWorkspaceId \|\| undefined\)/)
    expect(bar).toContain('data-testid="working-dir-default-tag"')
    expect(bar).toContain("t('chat.input.defaultWorkingDirectoryTag')")
  })

  it('中英文案齐全', async () => {
    const { createRendererI18n } = await import('../../src/renderer/src/i18n')
    for (const [lang, title, tag] of [['zh-CN', '默认工作目录', '默认'], ['en', 'Default working folder', 'Default']] as const) {
      const i18n = await createRendererI18n(lang)
      expect(i18n.t('settings.apps.workingDirectory.title')).toBe(title)
      expect(i18n.t('chat.input.defaultWorkingDirectoryTag')).toBe(tag)
      expect(i18n.t('settings.apps.workingDirectory.reset')).not.toMatch(/settings\./)
      expect(i18n.t('settings.apps.workingDirectory.unsetHint')).not.toMatch(/settings\./)
    }
  })
})
