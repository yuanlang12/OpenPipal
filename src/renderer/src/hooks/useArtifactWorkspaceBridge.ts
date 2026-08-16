import { useEffect, useRef } from 'react'
import { useArtifactStore, type Artifact } from '../stores/artifactStore'
import { useWorkspaceStore } from '../stores/workspaceStore'
import { stripDcSuffix } from '../utils/format'
import { shouldDismissTodosArtifact } from '../utils/todosArtifactLifecycle'
import { artifactTabTitleDescriptor } from '../components/workspace/workspaceLabels'
import { collectDcSiblingArtifactIds, isDcHtml, isSceneSourceArtifact } from '../components/artifacts/dcRuntime'

/**
 * Artifact ⇄ Workspace 桥接。
 *
 * 订阅 artifactStore，artifact 有新变化时自动在 workspaceStore 打开对应 tab：
 *   - streamingArtifact 开始 → 临时 "streaming" tab
 *   - streamingArtifact 结束 → 关掉临时 tab（真实 artifact 会在 artifacts 列表触发新 tab）
 *   - artifacts 末尾新增 → 以真实 artifactId 开 tab
 *
 * **交付物与素材分治**（2026-08-15 所有者裁决："产物壳子总是存在，别的内容的文件不用单独打开"）：
 * 动画类交付物是「一份薄壳 html + N 份场景 jsx」，模型的写作顺序通常是先场景后薄壳。若每份
 * 场景都开一个 tab，用户在整轮生成期间看到的就是几个源码 tab 轮流抢舞台，真正的视频壳子最后
 * 才冒出来。所以：
 *   · 场景 jsx（或已被某个薄壳 from 引用的产物）= **素材**，不单独开 tab（在 Outputs 里点得到）
 *   · 素材流式期间复用同一个 "streaming" tab 当**等待中的舞台**（ArtifactTab 里画 tips），
 *     且流结束后不关——直到真正的交付物到场把它换掉
 *   · 薄壳后到时，回收先前替这批素材开过的 tab（顺序无关）
 *
 * 顺带自动打开 workspace 面板（仅"新内容来临"时，用户手动关闭后不再打扰）。
 * useRef 追踪已处理过的 artifact id，避免重复打开。
 */

/** 会话里被任一 dc 薄壳 from 引用的产物 id —— 它们已经在薄壳里被看见了，不必再各占一个 tab */
function referencedMaterialIds(artifacts: Artifact[]): Set<string> {
  const out = new Set<string>()
  for (const a of artifacts) {
    if (!(a.type === 'html' || !a.type) || !isDcHtml(a.content || '')) continue
    for (const id of collectDcSiblingArtifactIds(a.content || '')) out.add(id)
  }
  return out
}

export function useArtifactWorkspaceBridge() {
  const streaming = useArtifactStore(s => s.streamingArtifact)
  const artifacts = useArtifactStore(s => s.artifacts)
  const streamingTabIdRef = useRef<string | null>(null)
  // 这个 streaming tab 是"等待中的舞台"（素材流），流结束后留着不关
  const stageHoldRef = useRef(false)
  // 追踪“当前仍存在”的 id，而非只记最后一个 id：删除只做遗忘，不应重新聚焦旧 artifact；
  // 同一个稳定 id（如 todos-<conversationId>）退场后再启用时，又能被识别为新加入并重新开 tab。
  const knownArtifactIdsRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    const { openTab, closeTab } = useWorkspaceStore.getState()
    if (streaming) {
      const material = isSceneSourceArtifact(streaming)
      stageHoldRef.current = material
      // 切会话会整批清掉 artifact 类 tab（含这个 streaming tab），ref 会悬空 —— 先验活再复用，
      // 否则本会话后续的流式产物永远开不出 tab
      const tabs = useWorkspaceStore.getState().tabs
      const alive = !!streamingTabIdRef.current && tabs.some(t => t.id === streamingTabIdRef.current)
      // 台上已经有稿子（薄壳先写、或上一轮的成品）时，素材流不再另起等待舞台——
      // 那会把用户正在看的画面挤掉换成 tips，比"看着源码流"更糟
      if (!alive && material && tabs.some(t => t.kind === 'artifact' && t.artifactId && t.artifactId !== 'streaming')) {
        return
      }
      if (!alive) {
        const rawTitle = stripDcSuffix(streaming.title)
        const usesFallback = !rawTitle || rawTitle === '生成中...' || rawTitle === '生成中…'
        // 素材流固定叫"预览舞台"：它承载的是一整轮的等待态，标题不该跟着某一份场景文件跳
        const titleKey = material
          ? 'artifacts.shell.stage.tabTitle'
          : streaming.titleKey || (usesFallback ? 'artifacts.shell.generating' : undefined)
        // openTab 的 auto 分支自带"弹开面板 + 本轮抑制让位"完整语义,无需再补 setOpen
        streamingTabIdRef.current = openTab({
          kind: 'artifact',
          title: titleKey ? '' : rawTitle,
          ...(titleKey ? { titleKey } : {}),
          artifactId: 'streaming'
        }, { auto: true })
      }
    } else if (streamingTabIdRef.current && !stageHoldRef.current) {
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

    // 这一批新到的薄壳带来的素材 —— 只回收它们的 tab。不拿全量引用集去清扫：用户可能刚从
    // Outputs 手点开一份场景源码要看，那是他自己的决定，桥接不该在下一次产物更新时把它抽走。
    const freshMaterials = referencedMaterialIds(live.filter(a => (a.type === 'html' || !a.type)))
    if (freshMaterials.size > 0) {
      const workspace = useWorkspaceStore.getState()
      for (const tab of workspace.tabs) {
        if (tab.kind === 'artifact' && tab.artifactId && freshMaterials.has(tab.artifactId)) {
          workspace.closeTab(tab.id)
        }
      }
    }

    // 素材不单独开 tab：场景 jsx 本身，或已被会话里任一薄壳引用的产物
    const referenced = referencedMaterialIds(visibleArtifacts)
    const deliverables = live.filter(a => !isSceneSourceArtifact(a) && !referenced.has(a.id))
    if (deliverables.length === 0) return

    // 真交付物到场 → 等待中的舞台让位（它的使命就是撑到这一刻）
    if (stageHoldRef.current && streamingTabIdRef.current) {
      useWorkspaceStore.getState().closeTab(streamingTabIdRef.current)
      streamingTabIdRef.current = null
      stageHoldRef.current = false
    }

    const latest = deliverables[deliverables.length - 1]
    const title = stripDcSuffix(latest.title)
    const tabTitle = artifactTabTitleDescriptor({ ...latest, title })
    useWorkspaceStore.getState().openTab({
      kind: 'artifact',
      ...tabTitle,
      artifactId: latest.id
    }, { auto: true })
  }, [artifacts])
}
