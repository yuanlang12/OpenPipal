import { RoleAvatar, type RoleAvatarStatus } from './RoleAvatar'
import { WorkspaceAvatar } from '../agent-mark'
import type { AgentSummary } from '../../types'

/**
 * 统一身份的头像：内置画角色 Mark（配饰 / 上传头像），Pal 画它的 Mark（捏过画捏的，没捏过按 id 现算）。
 * 选择器、我的 Pal 页、欢迎页三处同一个入口——身份的画法只能有一种（对话行走 ConversationAvatar）。
 */
export function AgentAvatar({
  agent, size, className, status = 'idle', animated = false,
}: {
  agent: Pick<AgentSummary, 'id' | 'kind' | 'mark' | 'avatarDataUrl'>
  size: number
  className?: string
  status?: RoleAvatarStatus
  animated?: boolean
}): React.JSX.Element {
  return agent.kind === 'builtin'
    ? <RoleAvatar role={{ name: agent.id, avatarDataUrl: agent.avatarDataUrl, mark: agent.mark }} status={status} animated={animated} size={size} className={className} />
    : <WorkspaceAvatar workspaceId={agent.id} state={status} animated={animated} size={size} className={className} />
}
