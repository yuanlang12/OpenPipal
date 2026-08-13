import { useEffect, useRef } from 'react'
import type { CanvasEngine } from '../utils/canvasEngine'
import { useChatStore } from '../stores/chatStore'
import { useArtifactStore } from '../stores/artifactStore'
import { exportCanvasSnapshot } from '../utils/canvasSnapshot'

/**
 * Cave 节拍器 (N1 重构):
 *
 * 不再做状态判断——状态判断交给 AI(看图 + 看摘要 + 看历史)。
 * 这里只做三件事:
 *   1. 每 TICK_MS 周期性触发一次
 *   2. 计算与上次观察相比的差量摘要(新增/擦除/总笔数/距最后动笔)
 *   3. 通过 task-trigger 通道把"画布快照 + 摘要"喂给 AI 自己判断
 *
 * 守门(简化):
 *   - 画布可见(panelOpen + activeId === artifactId)——退出 cave 不打扰
 *   - AI 不在响应中(避免观察自己的响应)
 *   - 画布有内容(空白画布不发观察,留给 BLANK 后续支持)
 *
 * 状态判断、介入策略、追问规则——全部由 AI 在 prompt 层完成,
 * 见 ~/.openpipal/system-agents/learner/agent.md。
 */

/** 节拍周期。MVP/演示期取 15s,生产期可以放宽到 20-30s 以省成本。 */
const TICK_MS = 15_000

interface DiffSummary {
  shapesAdded: number      // 期间新增笔迹数量
  shapesRemoved: number    // 期间擦除笔迹数量
  totalShapes: number      // 当前总笔数
  msSinceLastUserChange: number  // 距最后一次用户操作毫秒数
  intervalMs: number       // 本周期长度
}

interface Options {
  artifactId: string
  roleName: string
  /** 可选:返回当前画布引擎。提供时,观察会附带画布 PNG 快照。 */
  getEngine?: () => CanvasEngine | null
  enabled?: boolean
}

/** 把差量摘要拼成观察文本。AI 综合这段文本 + 当前帧图 + 历史观察文本判断状态。 */
function buildObservationText(diff: DiffSummary, artifactId: string): string {
  const stale = diff.shapesAdded === 0 && diff.shapesRemoved === 0
  const lines = [
    `[系统观察 / 画布 ${artifactId}]`,
    `周期: ${Math.round(diff.intervalMs / 1000)}s`,
    `变化: 新增 ${diff.shapesAdded} 笔, 擦除 ${diff.shapesRemoved} 笔, 当前总笔数 ${diff.totalShapes}`,
    `距最后动笔: ${Math.round(diff.msSinceLastUserChange / 1000)}s`
  ]
  if (stale) lines.push('(本周期画布无变化)')
  lines.push('请综合当前画布快照、本摘要、之前几条观察的文本,自行判断学生状态(在 flow / 在审视 / 真卡住 / 看似做完了 / 重复尝试…),决定介入或 NO_REPLY。')
  return lines.join('\n')
}

export function useCaveStateMachine(engine: CanvasEngine, opts: Options): void {
  const { artifactId, roleName, getEngine, enabled = true } = opts

  const lastUserActivityAt = useRef<number>(Date.now())
  const lastShapeIdsRef = useRef<Set<string>>(new Set())

  // 监听用户改动(引擎只在收笔/擦除/撤销这类真实变更时通知),刷新 lastUserActivityAt
  useEffect(() => {
    if (!enabled) return
    return engine.subscribe(() => { lastUserActivityAt.current = Date.now() })
  }, [engine, enabled])

  // 初始化基线:挂载时把已有笔迹视作"已知",避免第一拍误报"新增 N 笔"
  // (artifact 持久化加载后,引擎已经有内容)
  useEffect(() => {
    if (!enabled) return
    lastShapeIdsRef.current = new Set(engine.getStrokeIds())
  }, [engine, enabled])

  // 节拍器
  useEffect(() => {
    if (!enabled) return

    const tick = (): void => {
      // 守门:可见性 + AI 不忙
      const artifactState = useArtifactStore.getState()
      const visible = artifactState.panelOpen && artifactState.activeId === artifactId
      if (!visible) return
      if (useChatStore.getState().isStreaming) return

      // 收集当前笔迹 ids
      const currentIds = new Set<string>(engine.getStrokeIds())

      // 空白画布跳过(BLANK 暂不支持,留给后续扩展)
      if (currentIds.size === 0 && lastShapeIdsRef.current.size === 0) return

      // 计算差量
      const last = lastShapeIdsRef.current
      let added = 0
      currentIds.forEach(id => { if (!last.has(id)) added++ })
      let removed = 0
      last.forEach(id => { if (!currentIds.has(id)) removed++ })

      const diff: DiffSummary = {
        shapesAdded: added,
        shapesRemoved: removed,
        totalShapes: currentIds.size,
        msSinceLastUserChange: Date.now() - lastUserActivityAt.current,
        intervalMs: TICK_MS
      }

      // 异步导出 + 注入观察消息
      void (async () => {
        const current = getEngine?.()
        const imageBase64 = current ? await exportCanvasSnapshot(current) : null
        void useChatStore.getState().sendMessage(
          buildObservationText(diff, artifactId),
          roleName,
          imageBase64 ? [imageBase64] : undefined,
          undefined,           // fileAttachments
          'task-trigger'       // messageKind:UI 隐藏 + 触发 silentResponseCycle
        )
      })()

      // 更新基线供下次 diff
      lastShapeIdsRef.current = currentIds
    }

    const handle = setInterval(tick, TICK_MS)
    return () => clearInterval(handle)
  }, [engine, artifactId, roleName, enabled, getEngine])
}
