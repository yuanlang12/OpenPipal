/**
 * 「已定下规则」那一行该显示成什么——纯函数，钉三条：
 *   清单拿不到（浏览器插件端 listHooks 返回 null → 永远 loaded=false）不能下"已删除"的判断；
 *   写入时就失败、清单本来就不列的（插件无效）仍显示失败原因；
 *   写入成功过、清单里没了才叫"已删除"。
 */
import { describe, it, expect } from 'vitest'
import { resolveHookRowState } from '../../src/renderer/src/components/messages/HookNoticeRow'

describe('resolveHookRowState', () => {
  it('清单没加载：一律 unknown，按写入时的结论显示', () => {
    expect(resolveHookRowState(false, undefined, 'ok')).toBe('unknown')
    expect(resolveHookRowState(false, undefined, 'error')).toBe('unknown')
  })
  it('清单里有：以清单为准；所在插件停用与自己关掉分开（前者没有"恢复"）', () => {
    expect(resolveHookRowState(true, { status: 'ok' }, 'error')).toBe('ok')
    expect(resolveHookRowState(true, { status: 'off', offReason: 'file' }, 'ok')).toBe('off')
    expect(resolveHookRowState(true, { status: 'off', offReason: 'plugin' }, 'ok')).toBe('plugin-off')
    expect(resolveHookRowState(true, { status: 'error' }, 'ok')).toBe('error')
  })
  it('清单里没有：写入时失败的仍是失败，写入成功过的才算已删除', () => {
    expect(resolveHookRowState(true, undefined, 'error')).toBe('error')
    expect(resolveHookRowState(true, undefined, 'ok')).toBe('deleted')
  })
})
