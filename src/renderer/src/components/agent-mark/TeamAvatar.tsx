import { useEffect } from 'react'
import { AgentMark } from './AgentMark'
import { composeTeamMark } from '../../../../shared/agent-mark-catalog'
import { isDrawnAccessory, isMarkHue } from './accessories'
import { isMarkShape } from './geometry'
import { getMarkOverride, loadMark, useMarkOverrides } from './markStore'
import type { MarkState } from './engine'

/**
 * 团队的头像。团队自己有一个 mark（所有者定的：不是成员头像叠）。
 *
 * 团队和 Pal 一样：没捏过时给一个**由 id 决定的默认 mark**（composeTeamMark），
 * （composeTeamMark：六边形 + 徽章 + 按 id 散列的颜色——同一个团队每次都长一样，两个团队一眼分得开，
 * 和 Pal 也不会混）。捏过（teams/<id>/mark.json）就用捏的。
 */
export function TeamAvatar({
  teamId, size = 16, state = 'idle', animated = false, className, ariaLabel,
}: {
  teamId: string
  size?: number
  state?: MarkState
  animated?: boolean
  className?: string
  ariaLabel?: string
}): React.JSX.Element {
  useMarkOverrides()
  useEffect(() => { void loadMark('team', teamId) }, [teamId])

  const config = getMarkOverride('team', teamId)
  const fallback = composeTeamMark(teamId)
  const accessory = isDrawnAccessory(config?.accessory) ? config.accessory : fallback.accessory
  const hue = isMarkHue(config?.hue) ? config.hue : fallback.hue
  // 捏过身体色但没捏配饰色：按搭配表配，不拿散列出的默认搭子（那是配给默认身体色的）
  const accent = isMarkHue(config?.accent) ? config.accent : config?.hue ? undefined : fallback.accent
  const shape = isMarkShape(config?.shape) ? config.shape : fallback.shape
  return (
    <AgentMark state={state} accessory={accessory} hue={hue} accent={accent} shape={shape} size={size}
      animated={animated} className={className} ariaLabel={ariaLabel} />
  )
}
