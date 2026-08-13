import { BookOpen, GraduationCap, Briefcase, Palette, Sparkles, Bot, type LucideIcon } from 'lucide-react'
import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'
import { getBuiltinRoleNameKey } from '../../../../shared/i18n/resources'

/**
 * 角色头像 — 单一来源的"角色身份图标"。
 *
 * 渲染顺序(对齐官方设计系统 hard-rule: 不用 emoji):
 *   1. role.avatarDataUrl 有图 → 圆形 <img>(用户上传,落盘 system-agents/<role>/avatar.png)
 *   2. 内置全局角色 → 日间像素 / 夜间 ASCII sprite（跟随 .dark）
 *   3. 未知角色 → 按 role.name 映射的 Lucide 线性图标(strokeWidth 1.75)
 *   4. 仍未命中 → Bot 兜底
 *
 * 注意:这是"角色"身份图标,不覆盖 workspace / agent / task 的自定义图标
 * (那些有各自的 .icon 语义,用户可编辑,不在本组件范围内)。
 */

/** 角色名 → Lucide 图标。新增内置角色时在这里登记。 */
export const ROLE_LUCIDE: Record<string, LucideIcon> = {
  learner: BookOpen,
  teacher: GraduationCap,
  office: Briefcase,
  design: Palette,
  general: Sparkles,
}

export interface RoleAvatarRole {
  name: string
  icon?: string
  avatarDataUrl?: string
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
  /** 当前运行状态。内置 sprite 会切换到对应帧；用户头像保持原图。 */
  status?: RoleAvatarStatus
  /** 仅当前可见、活跃的 Agent 才开启帧动画；列表中的后台任务保持静态，避免无效合成开销。 */
  animated?: boolean
  /** Lucide 图标 + 默认 <img> 方框的像素尺寸(默认 20) */
  size?: number
  /** 作用于 Lucide 图标(颜色等);<img> 模式下若未传 imgClassName 也会沿用做圆形裁切 */
  className?: string
  /**
   * 作用于 <img>。传入时(如 "w-full h-full rounded-full object-cover")
   * 让图片填满父容器(圆形头像位);不传则按 size 渲染一个圆形小图。
   */
  imgClassName?: string
}

/** 角色 → atlas 列。office/writer 共用写作助手；interpreter 为补齐的第六套正式素材。 */
const ROLE_SPRITE_COLUMN: Record<string, number> = {
  general: 0,
  teacher: 1,
  learner: 2,
  design: 3,
  office: 4,
  writer: 4,
  writing: 4,
  interpreter: 5,
}

const STATUS_ROW: Record<RoleAvatarStatus, number> = {
  idle: 0,
  thinking: 1,
  generating: 2,
}

function framePosition(column: number, row: number): string {
  return `${column * 20}% ${row * 50}%`
}

function avatarStyle(
  column: number,
  size: number,
  fillParent: boolean,
): React.CSSProperties {
  return {
    ...(fillParent ? {} : { width: size, height: size }),
    backgroundPosition: framePosition(column, 0),
  }
}

export function RoleAvatar({
  role,
  status = 'idle',
  animated = false,
  size = 20,
  className = '',
  imgClassName,
}: RoleAvatarProps) {
  const { t } = useTranslation()
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

  const spriteColumn = ROLE_SPRITE_COLUMN[role.name]
  if (spriteColumn !== undefined) {
    return (
      <span
        role="img"
        aria-label={ariaLabel}
        data-role-avatar={role.name}
        data-status={status}
        className={`sw-role-avatar sw-role-avatar--${status} ${animated ? 'sw-role-avatar--animated' : ''} ${imgClassName ?? className}`}
        style={avatarStyle(spriteColumn, size, !!imgClassName)}
      >
        {status !== 'idle' && (
          <span
            className="sw-role-avatar__state-frame"
            style={{ backgroundPosition: framePosition(spriteColumn, STATUS_ROW[status]) }}
            aria-hidden="true"
          />
        )}
      </span>
    )
  }

  const Icon = ROLE_LUCIDE[role.name] ?? Bot
  return <Icon size={size} strokeWidth={1.75} className={className} aria-label={ariaLabel} />
}
