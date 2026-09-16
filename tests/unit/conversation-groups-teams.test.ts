/**
 * 左栏分组（所有者 2026-09-13 定的分级）：
 *   - 团队话题按团队分桶、桶内按频道分，一条话题只出现在它的团队组里，不进日期组
 *   - 团队按最近活动排序；没频道的话题排最前，其余频道按名字
 *   - 单对话按 今天 / 昨天 / 过去 7 天 / 更早，"过去 7 天"是自然日往前数满 7 天，不按周一对齐
 */
import { describe, expect, it } from 'vitest'
import { groupConversations } from '../../src/renderer/src/hooks/useConversationGroups'
import type { ConversationSummary } from '../../src/renderer/src/stores/chatStore'

const DAY = 86400000
const now = Date.now()
const todayStart = new Date(new Date(now).getFullYear(), new Date(now).getMonth(), new Date(now).getDate()).getTime()

function conv(id: string, updatedAt: number, extra: Partial<ConversationSummary> = {}): ConversationSummary {
  return { id, title: id, role: 'general', createdAt: updatedAt, updatedAt, messageCount: 1, ...extra }
}

describe('左栏分组：团队 + 日期', () => {
  it('团队话题进团队组，不进日期组；桶内按频道；团队按最近活动排', () => {
    const list = [
      conv('t2-only', now - 3 * DAY, { teamId: 'team-2', workspaceId: 'lead-2' }),
      conv('t1-root', now - 1000, { teamId: 'team-1', workspaceId: 'lead-1' }),
      conv('t1-grade', now - 2 * DAY, { teamId: 'team-1', workspaceId: 'lead-1', channel: '批改' }),
      conv('t1-prep', now - DAY, { teamId: 'team-1', workspaceId: 'lead-1', channel: '备课' }),
      conv('single', now - 60_000),
    ].sort((a, b) => b.updatedAt - a.updatedAt)
    const grouped = groupConversations(list, '')
    expect(grouped.teams.map(t => t.teamId)).toEqual(['team-1', 'team-2'])
    expect(grouped.teams[0].channels.map(c => [c.channel, c.items.map(i => i.id)])).toEqual([
      [null, ['t1-root']],
      ['备课', ['t1-prep']],
      ['批改', ['t1-grade']],
    ])
    expect(grouped.groups.flatMap(g => g.items.map(i => i.id))).toEqual(['single'])
  })

  it('搜索同样只在团队组里命中团队话题', () => {
    const list = [conv('教案改稿', now, { teamId: 'team-1' }), conv('教案单聊', now - 1000)]
    const grouped = groupConversations(list, '教案')
    expect(grouped.teams[0].channels[0].items.map(i => i.id)).toEqual(['教案改稿'])
    expect(grouped.groups.flatMap(g => g.items.map(i => i.id))).toEqual(['教案单聊'])
    expect(groupConversations(list, '改稿').groups).toEqual([])
  })

  it('日期分级：今天 / 昨天 / 过去 7 天 / 更早，第 7 天还算"过去 7 天"，第 8 天算更早', () => {
    const list = [
      conv('today', todayStart + 1000),
      conv('yesterday', todayStart - 1000),
      conv('six-days-ago', todayStart - 6 * DAY + 1000),
      conv('seven-days-ago', todayStart - 7 * DAY + 1000),
      conv('month-ago', todayStart - 30 * DAY),
    ]
    const grouped = groupConversations(list, '')
    expect(grouped.groups.map(g => [g.label, g.items.map(i => i.id)])).toEqual([
      ['今天', ['today']],
      ['昨天', ['yesterday']],
      ['过去 7 天', ['six-days-ago']],
      ['更早', ['seven-days-ago', 'month-ago']],
    ])
  })
})
