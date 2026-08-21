import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  getBuiltinRoleNameKey,
  getConversationGroupKey,
  getConversationTimeDescriptor,
} from '../../src/shared/i18n/resources'
import { createRendererI18n } from '../../src/renderer/src/i18n'
import { getRoleAvatarAriaLabel } from '../../src/renderer/src/components/shared/RoleAvatar'

const SHELL_FILES = [
  'src/renderer/src/App.tsx',
  'src/renderer/src/components/Sidebar.tsx',
  'src/renderer/src/components/WelcomePage.tsx',
  'src/renderer/src/components/BrowserTopBar.tsx',
  'src/renderer/src/components/StatusBar.tsx',
  'src/renderer/src/components/AgentSwitcher.tsx',
  'src/renderer/src/components/HistoryPopover.tsx',
  'src/renderer/src/components/shared/ConvStatusDot.tsx',
  'src/renderer/src/components/shared/RoleAvatar.tsx',
  'src/renderer/src/components/workspace/WorkspacePanel.tsx',
]

const read = (path: string): string => readFileSync(resolve(path), 'utf8')

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

describe('renderer shell i18n', () => {
  it('serves English shell, role, history, and welcome strings', async () => {
    const i18n = await createRendererI18n('en')

    expect(i18n.t('shell.navigation.newConversation')).toBe('New conversation')
    expect(i18n.t('shell.history.messageCount', { count: 1 })).toBe('1 message')
    expect(i18n.t('shell.history.messageCount', { count: 3 })).toBe('3 messages')
    expect(i18n.t('roles.teacher.name')).toBe('Teacher Assistant')
    expect(i18n.t('roles.status.idle')).toBe('Idle')
    expect(i18n.t('shell.history.status.generating')).toBe('Generating…')
    expect(i18n.t('shell.history.status.needsAttention')).toBe(
      'Needs attention: completed or waiting for your input'
    )
    expect(i18n.t('shell.workspace.sourcesWithCount', { count: 3 })).toBe('Sources · 3')
    expect(i18n.t('shell.workspace.newTabUnavailable')).toBe('New tab (coming soon)')
    expect(i18n.t('welcome.input.placeholder')).toContain('assign a task')
  })

  it('announces every RoleAvatar state without translating dynamic role names', async () => {
    const i18n = await createRendererI18n('en')

    expect(['general', 'teacher', 'learner', 'design', 'office', 'interpreter'].map(roleName =>
      getRoleAvatarAriaLabel(roleName, 'idle', i18n.t)
    )).toEqual([
      'OpenPipal · Idle',
      'Teacher Assistant · Idle',
      'Learning Assistant · Idle',
      'Design Assistant · Idle',
      'Office Assistant · Idle',
      'Interpreter · Idle',
    ])

    expect([
      getRoleAvatarAriaLabel('design', 'idle', i18n.t),
      getRoleAvatarAriaLabel('design', 'thinking', i18n.t),
      getRoleAvatarAriaLabel('自定义 🌟', 'generating', i18n.t),
    ]).toEqual([
      'Design Assistant · Idle',
      'Design Assistant · Thinking',
      '自定义 🌟 · Generating',
    ])
    expect(getRoleAvatarAriaLabel('writer', 'idle', i18n.t)).toBe('Office Assistant · Idle')

    // 两条渲染路径都要报出角色+状态：用户上传的 <img> 走 alt，其余走 AgentMark 的 aria-label
    const roleAvatar = read('src/renderer/src/components/shared/RoleAvatar.tsx')
    expect(roleAvatar).toContain('alt={ariaLabel}')
    expect(roleAvatar).toContain('ariaLabel={ariaLabel}')
    const agentMark = read('src/renderer/src/components/agent-mark/AgentMark.tsx')
    expect(agentMark).toContain('aria-label={ariaLabel}')
  })

  it('exposes localized conversation status dots to assistive technology', () => {
    const source = read('src/renderer/src/components/shared/ConvStatusDot.tsx')

    expect(source.match(/role="img"/g)).toHaveLength(2)
    expect(source.match(/aria-label=\{label\}/g)).toHaveLength(2)
  })

  it('maps only stable built-in role ids and preserves custom role names', () => {
    expect(getBuiltinRoleNameKey('general')).toBe('roles.general.name')
    expect(getBuiltinRoleNameKey('design')).toBe('roles.design.name')
    expect(getBuiltinRoleNameKey('my-custom-role')).toBeUndefined()
  })

  it('adapts legacy date groups through stable translation keys', () => {
    expect(getConversationGroupKey('今天')).toBe('shell.history.groups.today')
    expect(getConversationGroupKey('更早')).toBe('shell.history.groups.earlier')
    expect(getConversationGroupKey('Custom group')).toBeUndefined()
    const now = new Date('2026-08-09T12:00:00Z').getTime()
    expect(getConversationTimeDescriptor(now - 5 * 60_000, now)).toEqual({
      kind: 'relative',
      key: 'shell.history.relative.minutesAgo',
      count: 5,
    })
    expect(getConversationTimeDescriptor(now - 8 * 86_400_000, now)).toEqual({
      kind: 'absolute',
      timestamp: now - 8 * 86_400_000,
    })
  })

  it('removes obvious hard-coded Chinese shell copy from the migrated surfaces', () => {
    const source = stripComments(SHELL_FILES.map(read).join('\n'))
    const migratedShellLiterals = [
      '记忆整理中...',
      '新建对话',
      '历史记录',
      '搜索对话...',
      '没有匹配的对话',
      '还没有对话',
      '需要查看：已完成或等待你的输入',
      '生成中…',
      '全局角色',
      '暂无独立 Agent',
      '待命',
      '关闭标签',
      '新建标签（稍后启用）',
      '收起摘要面板',
      '会话简报 · 已保存，开始对话即生效',
      '输入问题，或分配一个任务...（@ 唤起技能）',
      '存为 Agent',
    ]

    for (const literal of migratedShellLiterals) expect(source).not.toContain(literal)
  })

  it('keeps user and custom Agent content outside translation calls', () => {
    const sidebar = read('src/renderer/src/components/Sidebar.tsx')
    const switcher = read('src/renderer/src/components/AgentSwitcher.tsx')
    const welcome = read('src/renderer/src/components/WelcomePage.tsx')

    expect(sidebar).toContain('{getConversationDisplayTitle(conv, t)}')
    expect(switcher).toContain('activeWorkspace.name')
    expect(switcher).toContain('{w.name}')
    expect(welcome).toContain('{t.name}')
    expect(welcome).toContain('{t.description')
  })

  it('keeps migrated text buttons content-sized or fluid', () => {
    const sidebar = read('src/renderer/src/components/Sidebar.tsx')
    const browserTopBar = read('src/renderer/src/components/BrowserTopBar.tsx')
    const statusBar = read('src/renderer/src/components/StatusBar.tsx')

    expect(sidebar).toContain('w-full py-2 px-4')
    expect(browserTopBar).toContain('px-2.5 py-1.5')
    expect(statusBar).toContain('shrink-0 flex items-center gap-1 px-2 py-1')
  })
})
