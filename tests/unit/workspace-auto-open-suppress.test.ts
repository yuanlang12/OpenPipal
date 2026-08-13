/**
 * "本轮别再弹"抑制 —— 用户显式关面板后，同会话内后续产物完成不再强行弹开。
 *
 * 评审背景：产物完成自动开面板（bridge → openTab(auto)）此前无条件覆盖用户
 * 刚做的关闭动作。抑制位按会话 id 记忆（进程内存），三种解除路径分别覆盖：
 * 显式打开 / 新一轮用户消息（rearmAutoOpen）/ 换会话（key 不匹配自然失效）。
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { useWorkspaceStore } from '../../src/renderer/src/stores/workspaceStore'
import { resetWorkspaceStore } from './workspace-store-fixture'

describe('workspaceStore — 产物自动弹开的"本轮别再弹"抑制', () => {
  beforeEach(() => resetWorkspaceStore('conv-1'))

  it('用户 setOpen(false) 记下当前会话的抑制位', () => {
    const ws = useWorkspaceStore.getState()
    ws.setOpen(true)
    ws.setOpen(false)
    expect(useWorkspaceStore.getState().autoOpenSuppressedConvId).toBe('conv-1')
  })

  it('抑制生效时 openTab(auto) 只登记 tab 不开面板', () => {
    const ws = useWorkspaceStore.getState()
    ws.setOpen(false) // 用户显式关

    ws.openTab({ kind: 'artifact', title: '新产物', artifactId: 'art-1' }, { auto: true })

    const s = useWorkspaceStore.getState()
    expect(s.tabs.some(t => t.artifactId === 'art-1')).toBe(true) // tab 照常登记
    expect(s.open).toBe(false) // 面板不被弹开
    expect(s.visibilityMemory['conv-1']).toBe(false) // 关闭记忆未被污染
  })

  it('非 auto 的 openTab（用户点开产物）正常开面板并解除抑制', () => {
    const ws = useWorkspaceStore.getState()
    ws.setOpen(false)

    ws.openTab({ kind: 'artifact', title: '手动打开', artifactId: 'art-2' })
    const s = useWorkspaceStore.getState()
    expect(s.open).toBe(true)
    expect(s.autoOpenSuppressedConvId).toBeNull()
  })

  it('rearmAutoOpen（新一轮用户消息）解除抑制，之后 openTab(auto) 恢复弹开', () => {
    const ws = useWorkspaceStore.getState()
    ws.setOpen(false)
    ws.rearmAutoOpen()
    expect(useWorkspaceStore.getState().autoOpenSuppressedConvId).toBeNull()

    ws.openTab({ kind: 'artifact', title: '恢复弹开', artifactId: 'art-r' }, { auto: true })
    expect(useWorkspaceStore.getState().open).toBe(true)
  })

  it('抑制按会话隔离：conv-1 关过不影响 conv-2 的自动弹开', () => {
    const ws = useWorkspaceStore.getState()
    ws.setOpen(false) // conv-1 抑制

    useWorkspaceStore.setState({ currentConversationId: 'conv-2' })
    ws.openTab({ kind: 'artifact', title: 'conv-2 产物', artifactId: 'art-2b' }, { auto: true })
    expect(useWorkspaceStore.getState().open).toBe(true) // conv-2 不受 conv-1 抑制影响
  })

  it('rearmAutoOpen 只清匹配当前会话的抑制（别的会话的抑制保留）', () => {
    const ws = useWorkspaceStore.getState()
    ws.setOpen(false) // conv-1 抑制

    useWorkspaceStore.setState({ currentConversationId: 'conv-2' })
    ws.rearmAutoOpen() // 在 conv-2 里发新消息
    expect(useWorkspaceStore.getState().autoOpenSuppressedConvId).toBe('conv-1') // conv-1 的抑制仍在
  })

  it('显式 setOpen(true)/focusTab 解除抑制', () => {
    const ws = useWorkspaceStore.getState()
    ws.setOpen(false)
    ws.setOpen(true)
    expect(useWorkspaceStore.getState().autoOpenSuppressedConvId).toBeNull()

    ws.setOpen(false)
    ws.focusTab('whatever')
    expect(useWorkspaceStore.getState().autoOpenSuppressedConvId).toBeNull()
  })

  it('重灌窗口内的程序性 focusSummary/focusTab 不清抑制位(切会话往返不豁免"刚关别弹")', () => {
    const ws = useWorkspaceStore.getState()
    ws.setOpen(false) // conv-1 抑制

    // 模拟 switchConversation 的 reset:rehydrating 窗口内程序性 focus(评审实锤的抹除路径)
    ws.setRehydrating(true)
    ws.focusSummary()
    ws.focusTab('tab-x')
    ws.setRehydrating(false)
    expect(useWorkspaceStore.getState().autoOpenSuppressedConvId).toBe('conv-1')

    // 切回后(restore 按记忆收官为关)新产物完成仍不弹
    useWorkspaceStore.setState({ open: false })
    ws.openTab({ kind: 'artifact', title: '仍不弹', artifactId: 'art-s' }, { auto: true })
    expect(useWorkspaceStore.getState().open).toBe(false)
  })
})
