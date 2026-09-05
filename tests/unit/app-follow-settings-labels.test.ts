/**
 * detectedApps 的显示名（Windows 第 4 段）：键是 exe 名（WINWORD），名字取自版本信息（Microsoft Word）。
 * 只有键与名字不同才落一条；macOS 上进程名就是名字，这张表始终是空的、保存的 config 形状与历史相同。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  config: {} as Record<string, unknown>,
  saveConfig: vi.fn()
}))

vi.mock('../../src/main/config-manager', () => ({
  loadConfig: () => state.config,
  saveConfig: state.saveConfig
}))

import {
  addDetectedApp,
  getDetectedAppLabels,
  getDetectedApps,
  resetAppFollowSettingsCacheForTests
} from '../../src/main/app-follow-settings'

beforeEach(() => {
  state.config = {}
  state.saveConfig.mockClear()
  resetAppFollowSettingsCacheForTests()
})

describe('detected app labels', () => {
  it('macOS 形态：名字就是键，不写 detectedAppLabels，config 形状与历史相同', () => {
    addDetectedApp('Notion')
    expect(state.saveConfig).toHaveBeenCalledWith({ detectedApps: ['Notion'] })
    expect(getDetectedAppLabels()).toEqual({})
    addDetectedApp('Notion', 'Notion')
    expect(state.saveConfig).toHaveBeenCalledTimes(1)
  })

  it('Windows 形态：键与名字不同 → 一并落盘，设置页拿到的是名字', () => {
    addDetectedApp('WINWORD', 'Microsoft Word')
    expect(state.saveConfig).toHaveBeenCalledWith({
      detectedApps: ['WINWORD'],
      detectedAppLabels: { WINWORD: 'Microsoft Word' }
    })
    expect(getDetectedApps()).toEqual(['WINWORD'])
    expect(getDetectedAppLabels()).toEqual({ WINWORD: 'Microsoft Word' })
  })

  it('已知的键再来一次同名不重复写；名字变了（应用更新 / 换系统语言）才更新', () => {
    addDetectedApp('WINWORD', 'Microsoft Word')
    addDetectedApp('WINWORD', 'Microsoft Word')
    expect(state.saveConfig).toHaveBeenCalledTimes(1)
    addDetectedApp('WINWORD', 'Microsoft Word 365')
    expect(state.saveConfig).toHaveBeenCalledTimes(2)
    expect(getDetectedAppLabels()).toEqual({ WINWORD: 'Microsoft Word 365' })
  })

  it('从磁盘读回来的表照用，返回的是副本', () => {
    state.config = { detectedApps: ['Code'], detectedAppLabels: { Code: 'Visual Studio Code' } }
    const labels = getDetectedAppLabels()
    expect(labels).toEqual({ Code: 'Visual Studio Code' })
    labels.Code = 'tampered'
    expect(getDetectedAppLabels()).toEqual({ Code: 'Visual Studio Code' })
  })

  it('空白名字当没给', () => {
    addDetectedApp('Code', '   ')
    expect(state.saveConfig).toHaveBeenCalledWith({ detectedApps: ['Code'] })
  })
})
