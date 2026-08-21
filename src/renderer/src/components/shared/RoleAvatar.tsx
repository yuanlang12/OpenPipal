import { useEffect } from 'react'
import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'
import { getBuiltinRoleNameKey } from '../../../../shared/i18n/resources'
import { AgentMark } from '../agent-mark'
import { isAccessoryId, isMarkHue, type AccessoryId, type MarkHue } from '../agent-mark'
import { getMarkOverride, loadMark, useMarkOverrides } from '../agent-mark/markStore'

/**
 * 角色头像 —— 单一来源的"角色身份图标"。
 *
 * 渲染顺序：
 *   1. role.avatarDataUrl 有图 → 圆形 <img>（用户上传，落盘 system-agents/<role>/avatar.png）
 *   2. 其余一律 <AgentMark>：同一套眼睛 + 角色自己的配饰
 *
 * 眼型是核心符号，六个角色一模一样，一个像素都不改；身份挂在配饰和配饰自带的那点颜色上。
 * 配饰组合可被 role.mark 覆盖（来自 system-agents/<role>/mark.json，文件式 opt-in，
 * 同 layout.json；不存在就用下面的角色默认）。
 *
 * 注意：这里是"角色"身份图标，不覆盖 workspace / agent / task 的自定义图标。
 */

/** 从磁盘/IPC 来的值是宽字符串；窄化在 resolveRoleMark 里做，调用处直接透传即可。 */
export interface MarkConfig {
  accessory?: string
  hue?: string
}

export interface RoleAvatarRole {
  name: string
  icon?: string
  avatarDataUrl?: string
  mark?: MarkConfig
}

export type RoleAvatarStatus = 'idle' | 'thinking' | 'generating'

const ROLE_STATUS_KEYS: Record<RoleAvatarStatus, string> = {
  idle: 'roles.status.idle',
  thinking: 'roles.status.thinking',
  generating: 'roles.status.generating',
}

const LEGACY_ROLE_NAME_ALIASES: Record<string, string> = {
  writer: 'office',
  writing: 'office',
}

export interface ResolvedMark {
  accessory: AccessoryId
  hue: MarkHue
}

/** 角色 → 默认配饰。加内置角色时在这里登记一件配饰 + 一个色，不要动眼型。 */
const ROLE_MARK: Record<string, ResolvedMark> = {
  general: { accessory: 'none', hue: 'ink' },
  teacher: { accessory: 'scarf', hue: 'red' },
  learner: { accessory: 'question', hue: 'blue' },
  design: { accessory: 'palette', hue: 'amber' },
  office: { accessory: 'briefcase', hue: 'slate' },
  interpreter: { accessory: 'headphones', hue: 'teal' },
}

const DEFAULT_MARK: ResolvedMark = { accessory: 'none', hue: 'ink' }

/** 按优先级取第一个认得出的值；认不出的一律当没设置。 */
function firstValid<T extends string>(
  guard: (v: unknown) => v is T,
  candidates: (string | undefined)[],
): T | undefined {
  for (const v of candidates) if (guard(v)) return v
  return undefined
}

/** 优先级：刚捏完的内存覆盖 > 磁盘 mark.json（随角色带过来）> 角色默认。 */
export function resolveRoleMark(role: RoleAvatarRole): ResolvedMark {
  const canonical = LEGACY_ROLE_NAME_ALIASES[role.name] ?? role.name
  const base = ROLE_MARK[canonical] ?? DEFAULT_MARK
  const live = getMarkOverride('role', role.name)
  return {
    accessory: firstValid(isAccessoryId, [live?.accessory, role.mark?.accessory]) ?? base.accessory,
    hue: firstValid(isMarkHue, [live?.hue, role.mark?.hue]) ?? base.hue,
  }
}

export function getRoleAvatarAriaLabel(
  roleName: string,
  status: RoleAvatarStatus,
  t: TFunction,
): string {
  const roleNameKey = getBuiltinRoleNameKey(LEGACY_ROLE_NAME_ALIASES[roleName] || roleName)
  const displayName = roleNameKey ? t(roleNameKey) : roleName
  return `${displayName} · ${t(ROLE_STATUS_KEYS[status])}`
}

interface RoleAvatarProps {
  role: RoleAvatarRole
  status?: RoleAvatarStatus
  /** 只有当前可见、活跃的 Agent 才开动画；列表里的后台任务保持静态，零 rAF */
  animated?: boolean
  size?: number
  className?: string
  /** 作用于 <img>；传入时让图片填满父容器的圆形头像位 */
  imgClassName?: string
}

export function RoleAvatar({
  role, status = 'idle', animated = false, size = 20, className = '', imgClassName,
}: RoleAvatarProps): React.JSX.Element {
  const { t } = useTranslation()
  useMarkOverrides()   // 捏完立刻重画，不等下次拿角色列表
  useEffect(() => { void loadMark('role', role.name) }, [role.name])
  const ariaLabel = getRoleAvatarAriaLabel(role.name, status, t)

  if (role.avatarDataUrl) {
    return (
      <img
        src={role.avatarDataUrl}
        alt={ariaLabel}
        className={imgClassName ?? `rounded-full object-cover ${className}`}
        style={imgClassName ? undefined : { width: size, height: size }}
        draggable={false}
      />
    )
  }

  const mark = resolveRoleMark(role)
  return (
    <AgentMark
      state={status}
      accessory={mark.accessory}
      hue={mark.hue}
      size={size}
      animated={animated}
      ariaLabel={ariaLabel}
      className={imgClassName ?? className}
    />
  )
}
