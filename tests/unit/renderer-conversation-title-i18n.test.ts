import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createRendererI18n } from '../../src/renderer/src/i18n'
import { groupConversations } from '../../src/renderer/src/hooks/useConversationGroups'
import {
  getConversationDisplayTitle,
  isPersistedDefaultConversationTitle,
} from '../../src/renderer/src/utils/conversationDisplayTitle'
import {
  refreshConversationSummaries,
  type ConversationSummary,
} from '../../src/renderer/src/stores/chatStore'

function conversation(overrides: Partial<ConversationSummary> = {}): ConversationSummary {
  return {
    id: 'conversation-1',
    title: '新对话',
    role: 'general',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    messageCount: 0,
    ...overrides,
  }
}

describe('conversation display title i18n', () => {
  it('hot-switches only the exact empty unbound persisted sentinel', async () => {
    const i18n = await createRendererI18n('zh-CN')
    const value = conversation()

    expect(isPersistedDefaultConversationTitle(value)).toBe(true)
    expect(getConversationDisplayTitle(value, i18n.t)).toBe('新对话')

    await i18n.changeLanguage('en')
    expect(getConversationDisplayTitle(value, i18n.t)).toBe('New conversation')
  })

  it.each([
    ['dynamic title', conversation({ title: '用户自定义标题' })],
    ['non-empty sentinel', conversation({ messageCount: 1 })],
    ['agent sentinel', conversation({ agentId: 'agent-1' })],
    ['workspace sentinel', conversation({ workspaceId: 'workspace-1' })],
  ])('preserves %s as raw dynamic content', async (_label, value) => {
    const i18n = await createRendererI18n('en')
    expect(isPersistedDefaultConversationTitle(value)).toBe(false)
    expect(getConversationDisplayTitle(value, i18n.t)).toBe(value.title)
  })

  it('searches both the raw sentinel and its localized display alias', async () => {
    const i18n = await createRendererI18n('en')
    const sentinel = conversation()
    const dynamic = conversation({ id: 'dynamic', title: 'New project', messageCount: 2 })
    const values = [sentinel, dynamic]
    const displayTitle = (value: ConversationSummary) => getConversationDisplayTitle(value, i18n.t)

    expect(groupConversations(values, '新对话', displayTitle).groups.flatMap(group => group.items)).toContain(sentinel)
    expect(groupConversations(values, 'New conversation', displayTitle).groups.flatMap(group => group.items)).toEqual([sentinel])
    expect(groupConversations(values, 'New project', displayTitle).groups.flatMap(group => group.items)).toEqual([dynamic])
  })

  it('replaces optimistic summaries with the authoritative list after title updates', async () => {
    const authoritative = [conversation({ messageCount: 1 })]
    const listConversations = vi.fn().mockResolvedValue(authoritative)
    const apply = vi.fn()

    await refreshConversationSummaries(listConversations, apply)

    expect(listConversations).toHaveBeenCalledOnce()
    expect(apply).toHaveBeenCalledWith(authoritative)
  })

  it('renders the helper in both history surfaces and wires title updates to the authoritative refresh', () => {
    const sidebar = readFileSync(resolve('src/renderer/src/components/Sidebar.tsx'), 'utf8')
    const popover = readFileSync(resolve('src/renderer/src/components/HistoryPopover.tsx'), 'utf8')
    const store = readFileSync(resolve('src/renderer/src/stores/chatStore.ts'), 'utf8')

    expect(sidebar).toContain('getConversationDisplayTitle(conv, t)')
    expect(popover).toContain('getConversationDisplayTitle(conv, t)')
    expect(store).toMatch(/onTitleUpdated[\s\S]*refreshConversationSummaries\([\s\S]*window\.api\.listConversations\(\)/)
  })
})
