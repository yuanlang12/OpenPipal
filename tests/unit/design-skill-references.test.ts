/**
 * 设计技能与角色提示词的**引用完整性**。
 *
 * 为什么要有这条：这一类 bug 在 2026-08-17 这一轮里被手工逮到三次——
 *   · `flier` 技能说「挂 doc-page」，角色提示词说「不挂」，模型两边都读得到；
 *   · 删掉 `prototype-tweaks` 后，角色提示词的技能索引还在点它的名；
 *   · 重写 `hi-fi-design` 换掉方案编排规范后，角色提示词还在指旧规范名 `dv-turn`。
 * 三次都是**静默的**：模型照着不存在的东西做，没有任何一环会报警。手工 grep 逮三次说明它该归代码。
 *
 * 两条断言：
 *   1. 角色提示词点名的每个技能，目录真的在；
 *   2. 技能与角色提示词里写的每个运行时标识符（`data-*` / 事件名 / CSS 变量 / 模板标签），
 *      在 `resources/dc-runtime/` 或 `src/` 里真的有——**教模型用一个我们没有的东西，
 *      写了不报错也不起作用**，这是清点里最常见的一类错。
 *
 * 不含 openai/skills 那六份 Apache-2.0 外部技能：它们不描述我们的运行时，标识符自成一套。
 */
import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

const ROOT = path.resolve(__dirname, '../..')
const SKILL_DIR = path.join(ROOT, 'resources/skills')
const ROLE_FILE = path.join(ROOT, 'src/main/roles/design-role.ts')

/** openai/skills 的 Apache-2.0 快照，不描述我们的运行时 */
const VENDORED = new Set(['doc', 'pdf', 'skill-creator', 'slides', 'spreadsheet', 'tool-installer'])

/** 教学角色的课程技能，不属于设计能力 */
const NON_DESIGN = new Set(['curriculum-info-tech-primary', 'curriculum-physics-junior'])

const ourSkills = fs
  .readdirSync(SKILL_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory() && !VENDORED.has(d.name))
  .map((d) => d.name)

const roleText = fs.readFileSync(ROLE_FILE, 'utf8')

/** 只在这两棵树里找依据：运行时件与宿主代码 */
const HAYSTACK = ['resources/dc-runtime', 'src'].flatMap((rel) => walk(path.join(ROOT, rel)))

function walk(dir: string): string[] {
  const out: string[] = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...walk(p))
    else if (/\.(ts|tsx|js|jsx|mjs|cjs|css)$/.test(e.name)) out.push(p)
  }
  return out
}

const HAYSTACK_TEXT = HAYSTACK.map((f) => fs.readFileSync(f, 'utf8')).join('\n')

/**
 * 抓「只可能来自我们运行时」的标识符。故意不抓通用 CSS 属性与 HTML 属性——
 * 那些不是我们的协议，抓了只会制造噪声。
 */
const IDENT_RE =
  /data-(?:dc|deck|screen|props|prop|openpipal|drags|om)[a-z0-9-]*|openpipal:[a-z-]+|--(?:deck|doc-page|image-slot)-[a-z-]+/g

describe('设计技能与角色提示词的引用完整性', () => {
  /**
   * 只查「点了的必须存在」，**不查「存在的必须被点」**——后者是错的口径。
   *
   * 技能路由靠的是 system prompt 里的技能索引（`skill-manager.ts` 的 `buildSkillIndexForContext`），
   * 索引对全局会话恒为全量，模型按索引里的 name + description 自己决定读哪份；
   * `resources/skills/` 全是**全局技能**，design 角色并没有 `resources/system-agents/design/skills/`。
   * 角色提示词里那串技能名只是任务类型 → 技能的阅读建议，不是路由机制。
   * 所以「某技能没被角色提示词点名」不是缺陷（例如 frontend-design 是判断层技能，按需触发才对）；
   * 而「点了一个不存在的名字」是缺陷——它会把模型引向读不到的东西。
   */
  it('角色提示词点名的技能目录都存在', () => {
    const named = new Set<string>()
    for (const name of ourSkills) {
      if (NON_DESIGN.has(name)) continue
      // 技能名以 `xxx（…必读）`/`xxx 技能`/反引号 等形式出现，统一按裸名匹配
      if (new RegExp(`\\b${name}\\b`).test(roleText)) named.add(name)
    }
    // 反向：提示词里出现的、看起来像技能名的 token，必须真有目录
    const looksLikeSkill = roleText.match(/\b[a-z][a-z0-9]+(?:-[a-z0-9]+){1,3}\b(?= 技能|（)/g) || []
    const missing = [...new Set(looksLikeSkill)].filter(
      (n) => /^(dc|deck|design|doc|hi|html|three|trifold|web|wire|anim|inter|proto|front)/.test(n) &&
        !fs.existsSync(path.join(SKILL_DIR, n))
    )
    expect(missing, `角色提示词点了不存在的技能：${missing.join(', ')}`).toEqual([])
    expect(named.size).toBeGreaterThan(10) // 防止正则退化成永远为空的假绿
  })

  it('技能与角色提示词里的运行时标识符，代码里都真的有', () => {
    const sources: { file: string; text: string }[] = [
      { file: 'src/main/roles/design-role.ts', text: roleText }
    ]
    for (const name of ourSkills) {
      const f = path.join(SKILL_DIR, name, 'SKILL.md')
      if (fs.existsSync(f)) sources.push({ file: `resources/skills/${name}/SKILL.md`, text: fs.readFileSync(f, 'utf8') })
    }

    const ghosts: string[] = []
    let checked = 0
    for (const { file, text } of sources) {
      for (const ident of new Set(text.match(IDENT_RE) || [])) {
        checked++
        if (!HAYSTACK_TEXT.includes(ident)) ghosts.push(`${file} → ${ident}`)
      }
    }
    expect(checked).toBeGreaterThan(15) // 同上，防假绿
    expect(ghosts, `教了运行时里不存在的东西（写了不报错、也不起作用）：\n${ghosts.join('\n')}`).toEqual([])
  })
})
