import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('locale desktop bridge contract', () => {
  const main = readFileSync(resolve('src/main/ipc-handlers.ts'), 'utf8')
  const preload = readFileSync(resolve('src/preload/index.ts'), 'utf8')
  const declarations = readFileSync(resolve('src/preload/index.d.ts'), 'utf8')

  it('uses matching request and change-event channels across Main and preload', () => {
    expect(main).toContain("ipcMain.handle('locale:get-state'")
    expect(main).toContain("ipcMain.handle('locale:set-preference'")
    expect(preload).toContain("ipcRenderer.invoke('locale:get-state')")
    expect(preload).toContain("ipcRenderer.invoke('locale:set-preference', preference)")
    expect(preload).toContain("ipcRenderer.on('locale:changed', handler)")
  })

  it('exposes typed APIs and a removable change listener', () => {
    expect(declarations).toContain('getLocaleState: () => Promise<LocaleState>')
    expect(declarations).toContain('setLocalePreference: (preference: LocalePreference) => Promise<LocaleState>')
    expect(declarations).toContain('onLocaleChanged: (callback: (state: LocaleState) => void) => () => void')
    expect(preload).toContain("removeListener('locale:changed', handler)")
  })
})
