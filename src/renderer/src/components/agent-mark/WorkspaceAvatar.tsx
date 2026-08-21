import { useEffect } from 'react'
import { AgentMark } from './AgentMark'
import { isAccessoryId, isMarkHue } from './accessories'
import { getMarkOverride, loadMark, useMarkOverrides } from './markStore'
import type { MarkState } from './engine'

/**
 * 用户自建 Agent 的头像。
 *
 * 默认仍然是 workspace 自己的 emoji —— 那是用户为这个 Agent 选的图标，不该被我们顶掉。
 * 只有真捏过头像（agents/<id>/mark.json 存在）才换成 Agent Mark。
 * 这就是"默认 opt-in、不启用时代码路径走不到"：没捏过的 Agent 一行新逻辑都走不到。
 */
export function WorkspaceAvatar({
  workspaceId, icon, size = 16, state = 'idle', animated = false, ariaLabel,
}: {
  workspaceId: string
  icon?: string
  size?: number
  state?: MarkState
  animated?: boolean
  ariaLabel?: string
}): React.JSX.Element {
  useMarkOverrides()
  useEffect(() => { void loadMark('agent', workspaceId) }, [workspaceId])

  const config = getMarkOverride('agent', workspaceId)
  const accessory = isAccessoryId(config?.accessory) ? config.accessory : null
  const hue = isMarkHue(config?.hue) ? config.hue : 'ink'

  if (!accessory) {
    return <span className="text-sm" aria-label={ariaLabel}>{icon || '🤖'}</span>
  }
  return (
    <AgentMark state={state} accessory={accessory} hue={hue} size={size}
      animated={animated} ariaLabel={ariaLabel} />
  )
}
