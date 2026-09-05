/**
 * Windows 截图按 HWND 在 desktopCapturer 的窗口源里找目标：id 精确匹配优先，标题只是退路。
 */
import { describe, expect, it } from 'vitest'
import { pickWindowSource } from '../../src/main/screenshot'

const sources = [
  { id: 'window:1001:0', name: '报告.docx - Word' },
  { id: 'window:2002:0', name: 'OpenPipal' },
  { id: 'window:3003:0', name: '报告.docx - Word' }
]

describe('pickWindowSource', () => {
  it('按 HWND 精确命中，哪怕标题重复', () => {
    expect(pickWindowSource(sources, { handle: '3003', title: '报告.docx - Word' })?.id).toBe('window:3003:0')
  })

  it('HWND 对不上时按标题退一步', () => {
    expect(pickWindowSource(sources, { handle: '9', title: 'OpenPipal' })?.id).toBe('window:2002:0')
  })

  it('两样都对不上就是没有（窗口已经关了）', () => {
    expect(pickWindowSource(sources, { handle: '9', title: 'gone' })).toBeNull()
    expect(pickWindowSource(sources, { handle: '9', title: '' })).toBeNull()
  })
})
