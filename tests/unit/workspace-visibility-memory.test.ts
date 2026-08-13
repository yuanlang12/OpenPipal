/**
 * 内容区(WorkspacePanel)显隐状态机 —— per-conversation 记忆 单元测试。
 *
 * 覆盖用户反馈的 3 个行为缺陷里,可在 store 层直接验证的部分（view gate 属于纯 JSX
 * 条件渲染，不在此覆盖，见文件末尾注释）：
 *
 * 1. 切设置/切回 chat：workspaceStore.open 状态本身不受影响（gate 只影响渲染，见 App.tsx）
 * 2. 切会话时内容区跟随目标会话的实际状态（有记忆用记忆，无记忆按 hasArtifacts 走默认规则）
 * 3. 用户手动关闭后，记忆写入；下次进入该会话时被尊重，不被"重灌历史产物"覆盖
 *
 * workspaceStore 之上的 chatStore.switchConversation 接线也用最小 mock window.api 覆盖，
 * 直接验证"重灌 + 记忆收官"两步的实际顺序效果（而不是只测 store 原语）。
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { useWorkspaceStore } from '../../src/renderer/src/stores/workspaceStore'
import { useArtifactStore } from '../../src/renderer/src/stores/artifactStore'
import { useChatStore } from '../../src/renderer/src/stores/chatStore'
import { resetWorkspaceStore } from './workspace-store-fixture'

function resetArtifactStore() {
  useArtifactStore.setState({
    artifacts: [],
    activeId: null,
    panelOpen: false,
    streamingArtifact: null
  })
}

describe('workspaceStore — 每会话内容区显隐记忆（store 原语）', () => {
  beforeEach(() => {
    resetWorkspaceStore()
    resetArtifactStore()
  })

  it('restoreOpenForConversation 无记忆时按 hasArtifacts 走默认规则：有产物→开', () => {
    const ws = useWorkspaceStore.getState()
    ws.restoreOpenForConversation('conv-a', true)
    expect(useWorkspaceStore.getState().open).toBe(true)
    expect(useWorkspaceStore.getState().visibilityMemory['conv-a']).toBe(true)
  })

  it('restoreOpenForConversation 无记忆时按 hasArtifacts 走默认规则：无产物→关', () => {
    const ws = useWorkspaceStore.getState()
    ws.restoreOpenForConversation('conv-b', false)
    expect(useWorkspaceStore.getState().open).toBe(false)
    expect(useWorkspaceStore.getState().visibilityMemory['conv-b']).toBe(false)
  })

  it('手动 setOpen(false) 会把当前会话记忆写为 false，即使该会话有产物', () => {
    const ws = useWorkspaceStore.getState()
    ws.restoreOpenForConversation('conv-c', true) // 先进入：有产物→默认开
    expect(useWorkspaceStore.getState().open).toBe(true)

    ws.setOpen(false) // 用户手动关闭
    expect(useWorkspaceStore.getState().open).toBe(false)
    expect(useWorkspaceStore.getState().visibilityMemory['conv-c']).toBe(false)
  })

  it('再次进入同一会话（restoreOpenForConversation）尊重之前手动关闭的记忆，不被 hasArtifacts 覆盖', () => {
    const ws = useWorkspaceStore.getState()
    ws.restoreOpenForConversation('conv-d', true)
    ws.setOpen(false) // 手动关闭并记住

    // 模拟"离开再回来"：先切到别的会话
    ws.restoreOpenForConversation('conv-other', false)
    expect(useWorkspaceStore.getState().open).toBe(false)

    // 再切回 conv-d —— 即使它确实有产物，也应尊重"关闭"记忆，而不是重新默认打开
    ws.restoreOpenForConversation('conv-d', true)
    expect(useWorkspaceStore.getState().open).toBe(false)
  })

  it('togglePanel 打开后也会写入当前会话记忆', () => {
    const ws = useWorkspaceStore.getState()
    ws.restoreOpenForConversation('conv-e', false)
    expect(useWorkspaceStore.getState().open).toBe(false)

    ws.togglePanel()
    expect(useWorkspaceStore.getState().open).toBe(true)
    expect(useWorkspaceStore.getState().visibilityMemory['conv-e']).toBe(true)
  })

  it('rehydrating 窗口内 setOpen 完全忽略（不改 open，不写记忆）——保护重灌路径不覆盖关闭记忆', () => {
    const ws = useWorkspaceStore.getState()
    ws.restoreOpenForConversation('conv-f', true)
    ws.setOpen(false) // 关闭 + 记住 false
    expect(useWorkspaceStore.getState().visibilityMemory['conv-f']).toBe(false)

    // 模拟重灌窗口：期间任何 setOpen(true) 调用都应是 no-op
    ws.setRehydrating(true)
    ws.setOpen(true)
    expect(useWorkspaceStore.getState().open).toBe(false) // 未被强开
    expect(useWorkspaceStore.getState().visibilityMemory['conv-f']).toBe(false) // 记忆未被污染
    ws.setRehydrating(false)

    // 重灌结束后按记忆收官——仍然是关闭
    ws.restoreOpenForConversation('conv-f', true)
    expect(useWorkspaceStore.getState().open).toBe(false)
  })

  it('rehydrating 窗口内 openTab 添加 tab 但不强制展开面板', () => {
    const ws = useWorkspaceStore.getState()
    ws.restoreOpenForConversation('conv-g', false) // 无记忆、无产物 → 默认关闭
    expect(useWorkspaceStore.getState().open).toBe(false)

    ws.setRehydrating(true)
    ws.openTab({ kind: 'artifact', title: 'rehydrated', artifactId: 'art-1' })
    expect(useWorkspaceStore.getState().tabs.some(t => t.artifactId === 'art-1')).toBe(true)
    expect(useWorkspaceStore.getState().open).toBe(false) // 重灌期间不强开
    ws.setRehydrating(false)
  })

  it('非重灌期间 openTab 正常强制展开面板并写入记忆（新产物自动弹出的既有体验保留）', () => {
    const ws = useWorkspaceStore.getState()
    ws.restoreOpenForConversation('conv-h', false)
    expect(useWorkspaceStore.getState().open).toBe(false)

    ws.openTab({ kind: 'artifact', title: 'live', artifactId: 'art-2' })
    expect(useWorkspaceStore.getState().open).toBe(true)
    expect(useWorkspaceStore.getState().visibilityMemory['conv-h']).toBe(true)
  })
})

/**
 * chatStore.switchConversation 接线：验证"重灌窗口 + 收官恢复"两步在真实调用顺序下
 * 确实产出正确的最终 open 值，而不仅仅是 store 原语本身正确。
 *
 * window.api 用最小面 mock —— 只提供 switchConversation 路径会触碰到的方法。
 */
describe('chatStore.switchConversation — 会话切换时内容区跟随目标会话状态', () => {
  const conversations = [
    { id: 'conv-with-art', role: 'learner' },
    { id: 'conv-empty', role: 'learner' }
  ]

  const messagesByConv: Record<string, any[]> = {
    'conv-with-art': [
      { id: 'm1', role: 'assistant', content: '', timestamp: 1, artifactRef: { path: '/fake/art1.json' } }
    ],
    'conv-empty': []
  }

  beforeEach(() => {
    resetWorkspaceStore()
    resetArtifactStore()

    ;(globalThis as any).window = {
      api: {
        listConversations: async () => conversations,
        getConversationMessages: async (id: string) => messagesByConv[id] || [],
        replaceMessages: async () => ({ ok: true }),
        clearSessionApprovals: () => {},
        loadArtifact: async (ref: { path: string }) => ({
          ok: true,
          artifact: {
            id: `art-for-${ref.path}`,
            type: 'html',
            title: '产物',
            content: '<div>hi</div>'
          }
        })
      }
    }

    // chatStore 是跨用例复用的同一个模块实例（无 cache-busting）——手动清掉会影响
    // switchConversation 行为的字段，避免上一个用例的 activeConversationId/messages 串扰
    useChatStore.setState({
      activeConversationId: null,
      messages: [],
      conversations: conversations as any,
      isStreaming: false
    } as any)
  })

  it('切到有产物、无记忆的会话 → 默认展开', async () => {
    await useChatStore.getState().switchConversation('conv-with-art')
    expect(useWorkspaceStore.getState().open).toBe(true)
    expect(useWorkspaceStore.getState().visibilityMemory['conv-with-art']).toBe(true)
  })

  it('切到无产物、无记忆的会话 → 默认收起', async () => {
    await useChatStore.getState().switchConversation('conv-empty')
    expect(useWorkspaceStore.getState().open).toBe(false)
  })

  it('用户手动关闭过的会话，再次切回时即使有产物也保持关闭（重灌不覆盖手动关闭记忆）', async () => {
    await useChatStore.getState().switchConversation('conv-with-art')
    expect(useWorkspaceStore.getState().open).toBe(true)

    // 用户手动关闭
    useWorkspaceStore.getState().setOpen(false)
    expect(useWorkspaceStore.getState().visibilityMemory['conv-with-art']).toBe(false)

    // 切到另一个会话，再切回来
    await useChatStore.getState().switchConversation('conv-empty')
    await useChatStore.getState().switchConversation('conv-with-art')

    // 即使 conv-with-art 确实有 artifactRef 会被重灌回来，面板仍应保持用户关闭的状态
    expect(useWorkspaceStore.getState().open).toBe(false)
    expect(useArtifactStore.getState().artifacts.length).toBeGreaterThan(0) // 产物确实被重灌了，只是面板不因此弹开
  })
})

// 备注：App.tsx:284 的 `activeView === 'chat' &&` 视图 gate 是纯 JSX 条件渲染，Playwright 在本任务
// 中被禁用，无法做渲染级验证；该改动照抄了同文件 :204 AgentWorkspaceInspector 的既有先例写法，
// 且不影响 workspaceStore 的任何状态（只影响是否挂载 <WorkspacePanel>），风险已通过代码走查确认。
