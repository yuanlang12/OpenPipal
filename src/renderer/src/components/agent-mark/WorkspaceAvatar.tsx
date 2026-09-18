import { useEffect } from 'react'
import { AgentMark } from './AgentMark'
import { isDrawnAccessory, isMarkHue } from './accessories'
import { isMarkShape } from './geometry'
import { getMarkOverride, loadMark, useMarkOverrides } from './markStore'
import type { MarkState } from './engine'
import { composeMark } from '../../../../shared/agent-mark-catalog'

/**
 * 用户自建 Pal 的头像。
 *
 * 捏过（agents/<id>/mark.json 存在）就画捏的那一个；没捏过就按 id 现算一个（composeMark：
 * 配饰 / 身体色 / 配饰色 / 轮廓都由 id 散列，同一个 Pal 每次一样，和团队建成员时落盘的是同一套算法）。
 * 不再回落 meta.json 里的 emoji——所有者 2026-09-18：成员排排站里混进一个 emoji 就不是一套头像了，
 * 迁移来的老模板 Pal、Evolver 建的 Pal 都没有 mark.json，全靠这条兜底。
 */
export function WorkspaceAvatar({
  workspaceId, size = 16, state = 'idle', animated = false, halo = false, className, ariaLabel,
}: {
  workspaceId: string
  size?: number
  state?: MarkState
  animated?: boolean
  /** 叠放时身体描一圈背景色，见 AgentMark.halo */
  halo?: boolean
  className?: string
  ariaLabel?: string
}): React.JSX.Element {
  useMarkOverrides()
  useEffect(() => { void loadMark('agent', workspaceId) }, [workspaceId])

  const fallback = composeMark(workspaceId)
  const config = getMarkOverride('agent', workspaceId) ?? fallback
  const accessory = isDrawnAccessory(config.accessory) ? config.accessory : fallback.accessory
  const hue = isMarkHue(config.hue) ? config.hue : fallback.hue
  const accent = isMarkHue(config.accent) ? config.accent : undefined
  const shape = isMarkShape(config.shape) ? config.shape : fallback.shape

  return (
    <AgentMark state={state} accessory={accessory} hue={hue} accent={accent} shape={shape} size={size}
      animated={animated} halo={halo} className={className} ariaLabel={ariaLabel} />
  )
}
