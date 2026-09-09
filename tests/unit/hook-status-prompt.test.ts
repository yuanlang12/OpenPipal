/**
 * 每轮塞进系统提示的规则清单（formatHookStatusForPrompt）：模型看不到胶囊，问它"定没定"只能猜
 * ——真机实撞：后台没写成，用户再提一遍，模型答"已经完成了"。
 * 钉三件事：没规则零注入；生效 / 没生效 / 后台正在写三段各自只在有内容时出现；开头说明清单就是全部。
 * 只给事实，不给"别说已完成"这类指令——怎么答归模型（hook-creator 技能里有该怎么说）。
 */
import { describe, it, expect } from 'vitest'
import { formatHookStatusForPrompt } from '../../src/main/hooks/hook-registry'

const ok = { id: 'local-rules/mask', source: { kind: 'plugin' as const, id: 'local-rules', name: 'local-rules' }, file: '/p/hooks/mask.ts', description: '读成绩表先把学生名字遮掉（仅 物理教案专家）', status: 'ok' as const, events: ['tool_result' as const] }
const bad = { id: 'local-rules/broken', source: { kind: 'plugin' as const, id: 'local-rules', name: 'local-rules' }, file: '/p/hooks/broken.ts', description: 'broken', status: 'error' as const, error: '编译失败：第 3 行', events: [] }

describe('formatHookStatusForPrompt', () => {
  it('没有规则、没有在写的：空串，零注入', () => {
    expect(formatHookStatusForPrompt([], [])).toBe('')
  })

  it('生效 / 没生效 / 后台正在写各成一段，只在有内容时出现；开头说明这就是全部', () => {
    const text = formatHookStatusForPrompt([ok, bad], ['别再跑 rm -rf'])
    expect(text.startsWith('<rules>')).toBe(true)
    expect(text.endsWith('</rules>')).toBe(true)
    expect(text).toMatch(/生效中：\n- 读成绩表先把学生名字遮掉（仅 物理教案专家）/)
    expect(text).toMatch(/没生效[^\n]*\n- broken：编译失败：第 3 行/)
    expect(text).toMatch(/后台正在写[^\n]*\n- 别再跑 rm -rf/)
    expect(text).toMatch(/这是全部：不在清单里的规则不存在/)
    expect(text).not.toMatch(/别说已完成/)

    const onlyPending = formatHookStatusForPrompt([], ['读成绩表先遮名字'])
    expect(onlyPending).not.toMatch(/生效中/)
    expect(onlyPending).not.toMatch(/没生效/)
    expect(onlyPending).toMatch(/后台正在写/)
  })

  it('Agent 规则目录读不了：不说"这是全部"，说明清单不全并带原因', () => {
    const text = formatHookStatusForPrompt([ok], [], 'EACCES: permission denied')
    expect(text).toMatch(/本轮读不了（EACCES: permission denied）/)
    expect(text).not.toMatch(/这是全部/)
    expect(formatHookStatusForPrompt([], [], 'EACCES')).toMatch(/<rules>/)
  })

  it('同样的规则两轮输出一模一样（系统提示前缀缓存不被翻）', () => {
    expect(formatHookStatusForPrompt([ok], [])).toBe(formatHookStatusForPrompt([ok], []))
  })
})
