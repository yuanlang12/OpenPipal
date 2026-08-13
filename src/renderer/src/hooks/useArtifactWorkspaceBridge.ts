import { useEffect, useRef } from 'react'
import { useArtifactStore } from '../stores/artifactStore'
import { useWorkspaceStore } from '../stores/workspaceStore'
import { stripDcSuffix } from '../utils/format'
import { shouldDismissTodosArtifact } from '../utils/todosArtifactLifecycle'
import { artifactTabTitleDescriptor } from '../components/workspace/workspaceLabels'

/**
 * Artifact ⇄ Workspace 桥接。
 *
 * 订阅 artifactStore，artifact 有新变化时自动在 workspaceStore 打开对应 tab：
 *   - streamingArtifact 开始 → 临时 "streaming" tab
 *   - streamingArtifact 结束 → 关掉临时 tab（真实 artifact 会在 artifacts 列表触发新 tab）
 *   - artifacts 末尾新增 → 以真实 artifactId 开 tab
 *
 * 顺带自动打开 workspace 面板（仅"新内容来临"时，用户手动关闭后不再打扰）。
 * useRef 追踪已处理过的 artifact id，避免重复打开。
 */
export function useArtifactWorkspaceBridge() {
  const streaming = useArtifactStore(s => s.streamingArtifact)
  const artifacts = useArtifactStore(s => s.artifacts)
  const streamingTabIdRef = useRef<string | null>(null)
  // 追踪“当前仍存在”的 id，而非只记最后一个 id：删除只做遗忘，不应重新聚焦旧 artifact；
  // 同一个稳定 id（如 todos-<conversationId>）退场后再启用时，又能被识别为新加入并重新开 tab。
  const knownArtifactIdsRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    const { openTab, closeTab } = useWorkspaceStore.getState()
    if (streaming) {
      if (!streamingTabIdRef.current) {
        const rawTitle = stripDcSuffix(streaming.title)
        const usesFallback = !rawTitle || rawTitle === '生成中...' || rawTitle === '生成中…'
        // openTab 的 auto 分支自带"弹开面板 + 本轮抑制让位"完整语义,无需再补 setOpen
        streamingTabIdRef.current = openTab({
          kind: 'artifact',
          title: streaming.titleKey || usesFallback ? '' : rawTitle,
          ...(streaming.titleKey
            ? { titleKey: streaming.titleKey }
            : usesFallback
              ? { titleKey: 'artifacts.shell.generating' }
              : {}),
          artifactId: 'streaming'
        }, { auto: true })
      }
    } else if (streamingTabIdRef.current) {
      closeTab(streamingTabIdRef.current)
      streamingTabIdRef.current = null
    }
  }, [streaming])

  useEffect(() => {
    // 兼容修改前已经留在内存里的完成清单（例如开发态 HMR 后的当前会话）：
    // 即使没有新的 artifact IPC 事件，也主动清掉 artifact 投影和对应 tab。
    const dismissed = artifacts.filter(shouldDismissTodosArtifact)
    if (dismissed.length > 0) {
      const artifactStore = useArtifactStore.getState()
      const workspace = useWorkspaceStore.getState()
      for (const artifact of dismissed) {
        artifactStore.removeArtifact(artifact.id)
        const tabs = workspace.tabs.filter(tab => tab.kind === 'artifact' && tab.artifactId === artifact.id)
        for (const tab of tabs) workspace.closeTab(tab.id)
      }
    }

    const visibleArtifacts = artifacts.filter(artifact => !shouldDismissTodosArtifact(artifact))
    const previousIds = knownArtifactIdsRef.current
    const currentIds = new Set(visibleArtifacts.map(artifact => artifact.id))
    const added = visibleArtifacts.filter(artifact => !previousIds.has(artifact.id))
    knownArtifactIdsRef.current = currentIds
    // 重灌产物不在这里开 tab——切会话的 tab 集合由 chatStore 按会话记忆恢复
    // （restoreArtifactTabsForConversation）。按数据来源判别而非 rehydrating 窗口：
    // effect 的 flush 可能晚于窗口关闭，靠时序会把重灌产物误当新产物弹 tab、污染记忆。
    const live = added.filter(artifact => !artifact.rehydrated)
    if (live.length === 0) return

    const latest = live[live.length - 1]
    const title = stripDcSuffix(latest.title)
    const tabTitle = artifactTabTitleDescriptor({ ...latest, title })
    useWorkspaceStore.getState().openTab({
      kind: 'artifact',
      ...tabTitle,
      artifactId: latest.id
    }, { auto: true })
  }, [artifacts])
}
