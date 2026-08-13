/**
 * 会话产物 tab 记忆：用户手动关闭的 tab 切回会话后不再弹回（visibilityMemory 的 tab 层对称机制）。
 * 语义：会话内任何 tab 变动写透进 artifactTabsMemory（重灌窗口不写、streaming 临时 tab 不入记忆）；
 * 切回会话时 restoreArtifactTabsForConversation 按记忆精确恢复——用户开集∩重灌产物 + 记忆没
 * 处置过的新产物（known 语义，区分"关掉的"与"上次还不存在的"）；无记忆走全量打开旧默认；
 * 非产物 tab（file/preview）跨会话保留不受影响。
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { useWorkspaceStore, SUMMARY_TAB_ID } from '../../src/renderer/src/stores/workspaceStore'

const CONV = 'conv-tab-memory'

function resetStore(): void {
  useWorkspaceStore.setState({
    open: false,
    tabs: [],
    activeTabId: SUMMARY_TAB_ID,
    rehydrating: false,
    visibilityMemory: {},
    artifactTabsMemory: {},
    currentConversationId: null
  })
}

/** 模拟"进入会话并重灌"：重灌窗口内恢复 tab 集合，窗口外由调用方断言 */
function enterConversation(convId: string, rehydrated: { id: string; title: string; titleKey?: string; titleParams?: Record<string, string | number> }[]): void {
  const ws = useWorkspaceStore.getState()
  ws.setRehydrating(true)
  // 对齐 chatStore.resetWorkspaceForNewConversation：清掉上个会话的 artifact tab
  for (const t of useWorkspaceStore.getState().tabs.filter(t => t.kind === 'artifact')) ws.closeTab(t.id)
  ws.restoreArtifactTabsForConversation(convId, rehydrated)
  ws.setRehydrating(false)
  ws.restoreOpenForConversation(convId, rehydrated.length > 0)
}

function artifactTabIds(): (string | undefined)[] {
  return useWorkspaceStore.getState().tabs.filter(t => t.kind === 'artifact').map(t => t.artifactId)
}

beforeEach(resetStore)

describe('restoreArtifactTabsForConversation：恢复语义', () => {
  it('无记忆（本次启动首次进入）→ 全量打开重灌产物，并写基线', () => {
    enterConversation(CONV, [{ id: 'a1', title: 'A1' }, { id: 'a2', title: 'A2' }])
    expect(artifactTabIds()).toEqual(['a1', 'a2'])
    expect(useWorkspaceStore.getState().artifactTabsMemory[CONV].open).toHaveLength(2)
  })

  it('用户关掉一个 tab → 记忆更新 → 再次进入不再弹回', () => {
    enterConversation(CONV, [{ id: 'a1', title: 'A1' }, { id: 'a2', title: 'A2' }])
    const ws = useWorkspaceStore.getState()
    const t1 = ws.tabs.find(t => t.artifactId === 'a1')!
    ws.closeTab(t1.id)
    expect(useWorkspaceStore.getState().artifactTabsMemory[CONV].open.map(e => e.artifactId)).toEqual(['a2'])
    // 切走再切回
    enterConversation('other-conv', [])
    enterConversation(CONV, [{ id: 'a1', title: 'A1' }, { id: 'a2', title: 'A2' }])
    expect(artifactTabIds()).toEqual(['a2'])
  })

  it('全关记忆（空数组）→ 一个产物 tab 都不开，落在摘要', () => {
    enterConversation(CONV, [{ id: 'a1', title: 'A1' }])
    const ws = useWorkspaceStore.getState()
    ws.closeTab(ws.tabs.find(t => t.artifactId === 'a1')!.id)
    enterConversation(CONV, [{ id: 'a1', title: 'A1' }])
    expect(artifactTabIds()).toEqual([])
    expect(useWorkspaceStore.getState().activeTabId).toBe(SUMMARY_TAB_ID)
  })

  it('记忆里已删产物剔除、标题以重灌现值为准', () => {
    useWorkspaceStore.setState({
      artifactTabsMemory: { [CONV]: {
        open: [
          { artifactId: 'gone', title: '已删产物' },
          { artifactId: 'a1', title: '旧标题' }
        ],
        known: ['gone', 'a1']
      } }
    })
    enterConversation(CONV, [{ id: 'a1', title: '新标题' }])
    const tabs = useWorkspaceStore.getState().tabs.filter(t => t.kind === 'artifact')
    expect(tabs.map(t => t.artifactId)).toEqual(['a1'])
    expect(tabs[0].title).toBe('新标题')
  })

  it('关闭过的保持关闭，上次访问后新出现的产物照常打开（known 语义）', () => {
    enterConversation(CONV, [{ id: 'a1', title: 'A1' }])
    const ws = useWorkspaceStore.getState()
    ws.closeTab(ws.tabs.find(t => t.artifactId === 'a1')!.id) // 用户关掉 a1
    // 切走期间会话新增了 a2（如后台流式产出）；切回：a1 不弹回，a2 自动打开
    enterConversation('other-conv', [])
    enterConversation(CONV, [{ id: 'a1', title: 'A1' }, { id: 'a2', title: 'A2' }])
    expect(artifactTabIds()).toEqual(['a2'])
    const mem = useWorkspaceStore.getState().artifactTabsMemory[CONV]
    expect(mem.known).toContain('a1')
    expect(mem.known).toContain('a2')
  })

  it('记忆保留用户 reorder 的顺序', () => {
    enterConversation(CONV, [{ id: 'a1', title: 'A1' }, { id: 'a2', title: 'A2' }])
    useWorkspaceStore.getState().reorderTabs(0, 1)
    enterConversation(CONV, [{ id: 'a1', title: 'A1' }, { id: 'a2', title: 'A2' }])
    expect(artifactTabIds()).toEqual(['a2', 'a1'])
  })

  it('未命名产物的语言描述符在切换会话后仍保留', () => {
    const fallback = { id: 'untitled', title: '', titleKey: 'shell.workspace.fallback.untitledArtifact' }
    enterConversation(CONV, [fallback])
    expect(useWorkspaceStore.getState().tabs[0]).toMatchObject({
      title: '',
      titleKey: 'shell.workspace.fallback.untitledArtifact'
    })

    enterConversation('other-conv', [])
    enterConversation(CONV, [fallback])
    expect(useWorkspaceStore.getState().tabs[0]).toMatchObject({
      title: '',
      titleKey: 'shell.workspace.fallback.untitledArtifact'
    })
    expect(useWorkspaceStore.getState().artifactTabsMemory[CONV].open[0]).toMatchObject({
      titleKey: 'shell.workspace.fallback.untitledArtifact'
    })
  })

  it('非产物 tab（file）不受恢复影响、也不入产物记忆', () => {
    useWorkspaceStore.setState({ currentConversationId: CONV })
    useWorkspaceStore.getState().openTab({ kind: 'file', title: 'notes.md', filePath: '/tmp/notes.md' })
    enterConversation(CONV, [{ id: 'a1', title: 'A1' }])
    const tabs = useWorkspaceStore.getState().tabs
    expect(tabs.filter(t => t.kind === 'file')).toHaveLength(1)
    expect(useWorkspaceStore.getState().artifactTabsMemory[CONV].open.map(e => e.artifactId)).toEqual(['a1'])
  })
})

describe('写透守卫', () => {
  it('会话内新产物（Agent 打开）实时入记忆', () => {
    enterConversation(CONV, [])
    useWorkspaceStore.getState().openTab({ kind: 'artifact', title: '新产物', artifactId: 'live-1' })
    expect(useWorkspaceStore.getState().artifactTabsMemory[CONV].open.map(e => e.artifactId)).toEqual(['live-1'])
  })

  it('streaming 临时 tab 不入记忆', () => {
    enterConversation(CONV, [])
    useWorkspaceStore.getState().openTab({ kind: 'artifact', title: '生成中...', artifactId: 'streaming' })
    expect(useWorkspaceStore.getState().artifactTabsMemory[CONV].open).toEqual([])
  })

  it('重灌窗口内的开/关不写记忆（不污染目标会话基线前的状态）', () => {
    enterConversation(CONV, [{ id: 'a1', title: 'A1' }])
    const before = useWorkspaceStore.getState().artifactTabsMemory[CONV]
    useWorkspaceStore.getState().setRehydrating(true)
    useWorkspaceStore.getState().openTab({ kind: 'artifact', title: '临时', artifactId: 'transient' })
    expect(useWorkspaceStore.getState().artifactTabsMemory[CONV]).toEqual(before)
    useWorkspaceStore.getState().setRehydrating(false)
  })
})
