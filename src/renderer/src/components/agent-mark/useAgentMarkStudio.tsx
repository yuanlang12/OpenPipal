import { useState } from 'react'
import { AgentMarkStudio } from './AgentMarkStudio'
import { getMarkOverride, setMarkOverride, type MarkOverride } from './markStore'

/**
 * 捏头像的三个入口（Agent 卡片 / 对话列表 hover / 欢迎页头像 hover）共用这一份弹窗状态，
 * 免得每个宿主各写一遍 open/close 和保存后的刷新。
 */
export interface MarkStudioTarget {
  /** 'role' = 内置角色；'agent' = 用户自建 Agent（id 传 workspace uuid） */
  scope?: 'role' | 'agent'
  roleName: string
  displayName?: string
  initial?: MarkOverride
}

export function useAgentMarkStudio(): {
  openMarkStudio: (target: MarkStudioTarget) => void
  markStudio: React.JSX.Element | null
} {
  const [target, setTarget] = useState<MarkStudioTarget | null>(null)
  return {
    openMarkStudio: setTarget,
    markStudio: target ? (
      <AgentMarkStudio
        scope={target.scope ?? 'role'}
        roleName={target.roleName}
        displayName={target.displayName}
        initial={target.initial ?? getMarkOverride(target.scope ?? 'role', target.roleName)}
        onClose={() => setTarget(null)}
        onSaved={(config) => setMarkOverride(target.scope ?? 'role', target.roleName, config)}
      />
    ) : null,
  }
}
