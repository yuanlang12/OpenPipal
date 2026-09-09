import { RoleAvatar, type RoleAvatarStatus } from './RoleAvatar'
import { WorkspaceAvatar } from '../agent-mark'

/**
 * 一条对话的身份头像：属于某个 Pal 就画它捏的 Mark（没捏过回落它的 emoji），否则画内置角色的。
 * 侧栏历史、顶栏历史浮层、对话列表三处同一个入口——身份的画法只能有一种，
 * 不然改了一处、漏了一处，捏完头像又是"这里更新了那里没有"。
 */
export function ConversationAvatar({
  workspaceId, role, icon, status = 'idle', animated = false, size, className,
}: {
  workspaceId?: string
  role: string
  /** Pal 自己的 emoji：没捏过头像时显示它 */
  icon?: string
  status?: RoleAvatarStatus
  animated?: boolean
  size: number
  /** Pal 头像：管 emoji 回落的字号；角色头像：透传给 Mark */
  className?: string
}): React.JSX.Element {
  return workspaceId
    ? <WorkspaceAvatar workspaceId={workspaceId} icon={icon} state={status} animated={animated} size={size} className={className} />
    : <RoleAvatar role={{ name: role }} status={status} animated={animated} size={size} className={className} />
}
