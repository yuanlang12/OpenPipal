/**
 * 技能选择 = 单条消息内的强调，不是会话级过滤器。
 *
 * 用户在输入框用 @ 内联插入技能（`@技能名 ` 纯文本，与正文自然混排），发送时把命中的
 * token 就地换成标签（模型看到的就是原始文本），发完即清空。system prompt 里的技能索引
 * 永远全量注入，不随选择变化——既保证模型始终知道自己有哪些技能，又让前缀缓存不被逐轮翻转。
 *
 * 格式契约（本文件写、UserMessage 解析成 pill）：<skill-request>技能名</skill-request>
 */

/** 解析用（全局标志，使用前注意 lastIndex；调用方每次自己 new 或用 matchAll） */
export const SKILL_REQUEST_PATTERN = /<skill-request>([\s\S]*?)<\/skill-request>/g

/**
 * 把选中的技能合并进消息文本。skills 为空时原样返回。
 * - 有正文：技能强调作为首行，正文跟在后面
 * - 无正文（用户只点了技能就发）：整条消息就是这句强调
 */
export function composeSkillRequest(text: string, skills: string[]): string {
  if (skills.length === 0) return text
  const tags = skills.map(name => `<skill-request>${name}</skill-request>`).join(' ')
  const body = text.trim()
  return body
    ? `请使用技能 ${tags} 完成以下任务：\n\n${body}`
    : `请使用技能 ${tags} 来帮我完成`
}

export interface SkillMention {
  /** '@' 在原文里的下标 */
  start: number
  /** token 结束下标（不含），即 start + 1 + name.length */
  end: number
  name: string
}

/** 技能名尾字符是 ASCII 词字符时才要求右边界——中文名后面直接接中文正文是常态 */
const ASCII_WORD = /[A-Za-z0-9_-]/

/**
 * 在文本里找出 `@技能名` token。**只认已知名单**（名字可含中文/空格/·，无法用 \w+ 猜边界），
 * 同一位置多个候选取最长匹配（`@pdf-pro` 不会被 `pdf` 抢走）。
 * 未命中的 @ 一律不算 token（`@pdfx`、邮箱等原样保留）。
 */
export function findSkillMentions(text: string, knownSkills: string[]): SkillMention[] {
  if (!text || knownSkills.length === 0) return []
  const names = knownSkills.filter(Boolean).sort((a, b) => b.length - a.length)
  const out: SkillMention[] = []
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '@') continue
    for (const name of names) {
      if (!text.startsWith(name, i + 1)) continue
      const after = text[i + 1 + name.length]
      if (after && ASCII_WORD.test(after) && ASCII_WORD.test(name[name.length - 1])) continue
      out.push({ start: i, end: i + 1 + name.length, name })
      i += name.length // 外层 i++ 后正好落到 token 之后
      break
    }
  }
  return out
}

/**
 * 发送时转换：把正文里的 `@技能名` 换成 <skill-request> 标签。
 * - 有正文：token 留在用户自己的行文位置，不额外加引导句
 * - 只有 token 没正文：套兜底句（复用 composeSkillRequest 的句式）
 */
export function expandSkillMentions(text: string, knownSkills: string[]): string {
  const hits = findSkillMentions(text, knownSkills)
  if (hits.length === 0) return text
  let out = ''
  let last = 0
  for (const h of hits) {
    out += text.slice(last, h.start) + `<skill-request>${h.name}</skill-request>`
    last = h.end
  }
  out += text.slice(last)
  const bare = out.replace(new RegExp(SKILL_REQUEST_PATTERN), '').trim()
  return bare ? out : composeSkillRequest('', Array.from(new Set(hits.map(h => h.name))))
}
