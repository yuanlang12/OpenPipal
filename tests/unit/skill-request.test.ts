/**
 * 技能选择 = 单条消息内的强调（不再是会话级白名单），输入侧是 @ 内联 token。
 * 覆盖：
 * - composeSkillRequest（兜底句式 + 标签格式的单一出处）
 * - findSkillMentions（只认已知名单、最长匹配、右边界、中文/空格名）
 * - expandSkillMentions（就地换标签、不加引导句、纯 token 走兜底句、未知 @ 原样保留）
 */
import { describe, it, expect } from 'vitest'
import {
  composeSkillRequest,
  expandSkillMentions,
  findSkillMentions,
  SKILL_REQUEST_PATTERN
} from '../../src/renderer/src/chat/skillRequest'

function parseSkills(text: string): string[] {
  return [...text.matchAll(new RegExp(SKILL_REQUEST_PATTERN))].map(m => m[1])
}

describe('composeSkillRequest', () => {
  it('没选技能时原文不动', () => {
    expect(composeSkillRequest('帮我写个周报', [])).toBe('帮我写个周报')
    expect(composeSkillRequest('', [])).toBe('')
  })

  it('有正文：强调作为首行，正文原样跟在后面', () => {
    const out = composeSkillRequest('帮我写个周报', ['docx'])
    expect(out).toBe('请使用技能 <skill-request>docx</skill-request> 完成以下任务：\n\n帮我写个周报')
  })

  it('无正文：整条消息就是强调', () => {
    expect(composeSkillRequest('   ', ['pdf'])).toBe('请使用技能 <skill-request>pdf</skill-request> 来帮我完成')
  })

  it('多技能：标签并列，都能被解析回名字', () => {
    const out = composeSkillRequest('做个图', ['dataviz', 'frontend-design'])
    expect(parseSkills(out)).toEqual(['dataviz', 'frontend-design'])
  })

  it('标签里只放技能名，不放路径', () => {
    const out = composeSkillRequest('x', ['skill-creator'])
    expect(parseSkills(out)).toEqual(['skill-creator'])
  })
})

const KNOWN = ['pdf', 'pdf-pro', 'dataviz', '课件生成', 'web design', '设计·排版']

describe('findSkillMentions', () => {
  it('只认已知名单，未知 @ 不算 token', () => {
    expect(findSkillMentions('@nope 帮我看看', KNOWN)).toEqual([])
    expect(findSkillMentions('联系我 a@b.com', KNOWN)).toEqual([])
  })

  it('同位置多候选取最长匹配', () => {
    expect(findSkillMentions('用 @pdf-pro 处理', KNOWN).map(m => m.name)).toEqual(['pdf-pro'])
    expect(findSkillMentions('用 @pdf 处理', KNOWN).map(m => m.name)).toEqual(['pdf'])
  })

  it('ASCII 名要求右边界：@pdfx 不命中', () => {
    expect(findSkillMentions('@pdfx', KNOWN)).toEqual([])
  })

  it('中文名后面直接接正文也命中', () => {
    const hits = findSkillMentions('@课件生成一份三角函数', KNOWN)
    expect(hits.map(m => m.name)).toEqual(['课件生成'])
    expect(hits[0].start).toBe(0)
    expect(hits[0].end).toBe(5)
  })

  it('名称含空格 / 间隔号也能整段命中', () => {
    expect(findSkillMentions('试试 @web design 风格', KNOWN).map(m => m.name)).toEqual(['web design'])
    expect(findSkillMentions('@设计·排版 一下', KNOWN).map(m => m.name)).toEqual(['设计·排版'])
  })

  it('多个 token 按出现顺序返回，不重叠', () => {
    const hits = findSkillMentions('先 @dataviz 再 @pdf 导出', KNOWN)
    expect(hits.map(m => m.name)).toEqual(['dataviz', 'pdf'])
    expect(hits[0].end).toBeLessThan(hits[1].start)
  })

  it('名单为空时（插件模式 shim 返回 []）永远不命中', () => {
    expect(findSkillMentions('@dataviz 画图', [])).toEqual([])
  })
})

describe('expandSkillMentions', () => {
  it('有正文：token 就地换标签，不加引导句', () => {
    expect(expandSkillMentions('用 @dataviz 把这组数据画成折线图', KNOWN))
      .toBe('用 <skill-request>dataviz</skill-request> 把这组数据画成折线图')
  })

  it('中文技能名 + 无空格正文', () => {
    expect(expandSkillMentions('@课件生成一份三角函数课件', KNOWN))
      .toBe('<skill-request>课件生成</skill-request>一份三角函数课件')
  })

  it('未知 @ 原样保留，已知的照换', () => {
    expect(expandSkillMentions('@nope 用 @pdf 导出', KNOWN))
      .toBe('@nope 用 <skill-request>pdf</skill-request> 导出')
  })

  it('只有 token 没正文 → 兜底句式', () => {
    expect(expandSkillMentions('@pdf ', KNOWN)).toBe('请使用技能 <skill-request>pdf</skill-request> 来帮我完成')
    expect(expandSkillMentions(' @dataviz  @pdf ', KNOWN))
      .toBe('请使用技能 <skill-request>dataviz</skill-request> <skill-request>pdf</skill-request> 来帮我完成')
  })

  it('纯 token 兜底时重复技能只留一份', () => {
    expect(expandSkillMentions('@pdf @pdf', KNOWN)).toBe('请使用技能 <skill-request>pdf</skill-request> 来帮我完成')
  })

  it('没有 token 时原文一字不动', () => {
    expect(expandSkillMentions('普通的一句话', KNOWN)).toBe('普通的一句话')
    expect(expandSkillMentions('', KNOWN)).toBe('')
  })

  it('换出来的标签能被解析回技能名（与渲染端同一契约）', () => {
    expect(parseSkills(expandSkillMentions('@dataviz 和 @pdf 一起用', KNOWN))).toEqual(['dataviz', 'pdf'])
  })
})
