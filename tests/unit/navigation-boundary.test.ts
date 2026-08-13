import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const mocks = vi.hoisted(() => ({
  openTab: vi.fn(),
  openFile: vi.fn()
}))

vi.mock('../../src/renderer/src/stores/workspaceStore', () => ({
  useWorkspaceStore: {
    getState: () => ({ openTab: mocks.openTab })
  }
}))

import { handleLinkClick } from '../../src/renderer/src/utils/openInWorkspace'
import { safeExternalHttpUrl } from '../../src/main/external-navigation-policy'

function clickEvent(): any {
  return {
    metaKey: false,
    ctrlKey: false,
    preventDefault: vi.fn()
  }
}

describe('privileged renderer navigation boundary', () => {
  beforeEach(() => {
    mocks.openTab.mockReset()
    mocks.openFile.mockReset()
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { api: { openFile: mocks.openFile } }
    })
  })

  it('always cancels relative Markdown navigation while preserving external-file fallback', () => {
    const event = clickEvent()
    handleLinkClick(event, '../payload.html')

    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(mocks.openFile).toHaveBeenCalledWith('../payload.html')
  })

  it('cancels active or unknown schemes without passing them to the operating system', () => {
    for (const href of ['javascript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'custom://host']) {
      const event = clickEvent()
      handleLinkClick(event, href)
      expect(event.preventDefault).toHaveBeenCalledOnce()
    }

    expect(mocks.openFile).not.toHaveBeenCalled()
    expect(mocks.openTab).not.toHaveBeenCalled()
  })

  it('externalizes only HTTP(S) URLs at the main-process boundary', () => {
    expect(safeExternalHttpUrl('https://example.com/path')).toBe('https://example.com/path')
    expect(safeExternalHttpUrl('http://localhost:3000/')).toBe('http://localhost:3000/')
    expect(safeExternalHttpUrl('file:///tmp/payload.html')).toBeNull()
    expect(safeExternalHttpUrl('javascript:alert(1)')).toBeNull()
    expect(safeExternalHttpUrl('data:text/html,hi')).toBeNull()
    expect(safeExternalHttpUrl('../payload.html')).toBeNull()
  })

  it('installs a main-frame navigation denial on the preload-enabled window', () => {
    const source = readFileSync(resolve('src/main/index.ts'), 'utf8')
    expect(source).toContain("mainWindow.webContents.on('will-navigate'")
    expect(source).toMatch(/will-navigate[\s\S]{0,500}preventDefault\(\)/)
  })
})
