import fs from 'node:fs'
import { describe, expect, it, vi } from 'vitest'

/**
 * repo-onboarding 技能（Phase 3）
 *
 * 编码助手的角色提示词刻意薄，"到了一个陌生仓库怎么上手"这类只在特定时刻才用得上的
 * 流程住在技能里按需读取（渐进式披露）。这里钉两类东西：
 *
 * 1. **接线**：真的 skill 引擎能从 resources/system-agents/coding/skills 里把它加载出来，
 *    而且只有编码助手看得见——目录摆错一层、frontmatter 写坏，模型就永远看不到它。
 * 2. **几条会被后续改动悄悄写没的纪律**：
 *    - 只有 CLAUDE.md 时绝不新建 AGENTS.md（同目录两者并存时读取端只认 AGENTS.md，
 *      新建 = 把用户那份 CLAUDE.md 整份遮蔽掉，见 agent-runtime/project-context.ts 的候选顺序）
 *    - 写进文档的命令必须真跑过（这份文档会被之后每个 AI 工具当成事实）
 *    - 不给生成的文档打自己的署名
 */

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => process.cwd(),
    getPath: () => '/tmp/openpipal-coding-skill-home'
  }
}))
vi.mock('../../src/main/mcp-manager', () => ({ listMcpSkillDirs: () => [] }))

const skills = await import('../../src/main/skill-manager')
const coreSkills = await import('../../src/main/agent-runtime/pi-core-skills')
await skills.preloadSkillEngine()

const SKILL_PATH = 'resources/system-agents/coding/skills/repo-onboarding/SKILL.md'
const raw = fs.readFileSync(SKILL_PATH, 'utf8')
const frontmatter = raw.split('---')[1] ?? ''
const body = raw.slice(raw.indexOf('---', 3) + 3)

describe('接线', () => {
  it('真的 skill 引擎能加载出来 —— 目录层级与 frontmatter 都对', () => {
    const index = skills.buildSkillIndexForContext({ roleName: 'coding' })
    expect(index).toContain('<name>repo-onboarding</name>')
  })

  it('只有编码助手看得见，不外溢到别的角色', () => {
    for (const role of ['design', 'teacher', 'general']) {
      expect(skills.buildSkillIndexForContext({ roleName: role })).not.toContain('repo-onboarding')
    }
    // 独立 workspace Agent 只看自己的目录，不继承角色技能
    expect(skills.buildSkillIndexForContext({ workspaceId: 'iso', roleName: 'coding' })).toBe('')
  })

  it('pi-core 与 legacy 两条运行时看到的是同一份', async () => {
    const legacy = skills.buildSkillPromptSection({ roleName: 'coding' })
    const core = await coreSkills.loadPiCoreSkillCatalog({ roleName: 'coding' })
    expect(core.promptSection).toBe(legacy)
    expect(core.skills.some(s => s.name === 'repo-onboarding')).toBe(true)
  })

  it('也出现在菜单里 —— 否则 /repo-onboarding 不展开', () => {
    const names = skills.listSkillsMeta(undefined, 'coding').filter(s => s.enabled).map(s => s.name)
    expect(names).toContain('repo-onboarding')
    expect(skills.listSkillsMeta(undefined, 'design').map(s => s.name)).not.toContain('repo-onboarding')
  })
})

describe('description（每轮都在上下文里，所以要短且带反向触发）', () => {
  it('短', () => {
    const desc = /description: (.*)/.exec(frontmatter)?.[1] ?? ''
    expect(desc.length).toBeGreaterThan(40)
    expect(desc.length).toBeLessThan(400)
  })

  it('说清什么时候用、什么时候不用', () => {
    expect(frontmatter).toContain('AGENTS.md')
    // 反向触发：项目规矩已注入且没人要写文档时不该加载它
    expect(frontmatter).toMatch(/不需要这个技能|无需(加载|读)/)
  })
})

describe('三分支纪律', () => {
  it('已有 AGENTS.md：不重复读', () => {
    expect(body).toContain('不要再 read')
  })

  // 这条规矩的前提（同目录只取优先级最高的那一份）由
  // project-context-injection.test.ts 的「AGENTS.md 与 CLAUDE.md 同在时只取 AGENTS.md」钉住。
  // 哪天改成"两份都注入"，这里的禁令就该跟着改，那条测试会先红。
  it('只有 CLAUDE.md：绝不新建 AGENTS.md 去遮蔽它', () => {
    expect(body).toContain('绝不新建 AGENTS.md')
    expect(body).toMatch(/遮蔽/)
    // 补规矩的正确做法必须一起写出来，否则模型只知道禁止、不知道走哪
    expect(body).toMatch(/edit.*CLAUDE\.md/)
  })

  it('两个都没有：先给用户看过再写盘', () => {
    expect(body).toMatch(/用户同意了?再 `?write`?/)
  })
})

describe('生成内容的质量闸', () => {
  it('每条命令必须真跑过', () => {
    expect(body).toContain('绝不把没跑过的命令写进文档')
  })

  it('只跑读类命令，发布/部署类只记录不执行', () => {
    expect(body).toMatch(/publish|deploy/)
    expect(body).toContain('只记录、不执行')
  })

  it('有文件预算和长度上限 —— 失控的入口文档每次会话都要吃注入预算', () => {
    expect(body).toContain('最多 10 个文件')
    expect(body).toMatch(/250[–-]450/)
  })

  it('不给用户的仓库打我们的署名', () => {
    expect(body).toMatch(/不写署名/)
    expect(raw).not.toContain('由 OpenPipal 生成')
  })
})

describe('技能自身保持薄', () => {
  it('单文件，没有 references/ 子目录（如无必要勿增实体）', () => {
    const dir = 'resources/system-agents/coding/skills/repo-onboarding'
    expect(fs.readdirSync(dir)).toEqual(['SKILL.md'])
  })

  it('越过 8KB 说明流程又开始往技能里搬知识了', () => {
    expect(Buffer.byteLength(raw, 'utf8')).toBeLessThan(8_192)
  })
})
