/**
 * Pal 头像只有一个出口：WorkspaceAvatar（读 markStore，捏完同帧重画，没捏过回落 emoji）；
 * 对话行再包一层 ConversationAvatar（属于 Pal 画 Mark，否则画内置角色）。
 * 所有者实撞：我的 Pal 页捏了头像，侧栏历史和工作区面板头部还是老 emoji——那几处直接打印
 * workspace.icon，从来没读过 mark.json。这条钉住"渲染 Pal 身份的组件不得绕过头像组件"，
 * 包括把身份拼成字符串（`${ws.icon} ${ws.name}`）这种绕法。
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const COMPONENTS = 'src/renderer/src/components'
/** 画 Pal 身份的每一处 → 该用哪个组件 */
const PAL_SURFACES: Array<[file: string, component: 'WorkspaceAvatar' | 'ConversationAvatar']> = [
  ['Sidebar.tsx', 'ConversationAvatar'],
  ['HistoryPopover.tsx', 'ConversationAvatar'],
  ['ConversationList.tsx', 'ConversationAvatar'],
  ['AgentSwitcher.tsx', 'WorkspaceAvatar'],
  ['AgentWorkspaceInspector.tsx', 'WorkspaceAvatar'],
  ['ChatPanel.tsx', 'WorkspaceAvatar'],
  ['TaskEditor.tsx', 'WorkspaceAvatar'],
  ['AgentsPanel.tsx', 'WorkspaceAvatar'],
]

const read = (file: string): string => readFileSync(resolve(COMPONENTS, file), 'utf8')

describe('Pal 头像统一走头像组件', () => {
  it.each(PAL_SURFACES)('%s 用 %s，不直接打印 workspace 的 emoji', (file, component) => {
    const source = read(file)
    expect(source).toContain(`<${component}`)
    // 老 bug 的形状：workspace 的 icon 直接进 JSX 文本（`>{w.icon}<`）或拼进字符串（`${ws.icon} …`）；
    // 作为 prop 传给头像组件（`icon={w.icon}`）是对的
    expect(source).not.toMatch(/(?<!=)\{(?:activeWorkspace|w|ws|workspace\.meta|workspaceMap\.get\([^)]*\)\?)\.icon(?: \|\| '🤖')?\}/)
    expect(source).not.toMatch(/\$\{(?:activeWorkspace|w|ws|workspace\.meta)\.icon/)
  })

  it('ConversationAvatar 按有没有 workspaceId 二选一，两边都透传状态与动画', () => {
    const source = readFileSync(resolve(COMPONENTS, 'shared/ConversationAvatar.tsx'), 'utf8')
    expect(source).toMatch(/workspaceId\s*\?\s*<WorkspaceAvatar[^>]*state=\{status\}[^>]*animated=\{animated\}/)
    expect(source).toMatch(/:\s*<RoleAvatar[^>]*status=\{status\}[^>]*animated=\{animated\}/)
  })

  it('WorkspaceAvatar 的 className 同时管 emoji 回落与 Mark 外层——调用方按位置给字号，不用自己包一层', () => {
    const source = readFileSync(resolve(COMPONENTS, 'agent-mark/WorkspaceAvatar.tsx'), 'utf8')
    expect(source).toContain("className={className || 'text-sm'}")
    expect(source).toMatch(/<AgentMark[\s\S]*className=\{className\}/)
  })
})
