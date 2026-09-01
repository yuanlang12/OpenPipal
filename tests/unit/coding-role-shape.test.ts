/**
 * 编码助手的形状（Phase 2；工具口径 2026-08-22 修正）
 *
 * 这个角色的价值在"提示词薄"，**不在"能力少"**。官方 pi coding agent 跑在约 1000 字符的系统
 * 提示词上，项目知识靠仓库自己的入口文档和技能供给；照设计助手那个分量（18KB 提示词 + 十几个
 * 技能）做出来的编码助手只会更笨。但薄提示词不等于砍工具——这里一度把产物族/浏览器族摘掉，
 * 理由是"怕模型拿 HTML 报告顶替真正的改动"，那是预测模型会犯错（能力拐杖），代价是 13 个内置
 * 技能点名要的工具没了、技能索引里躺着一排跑不动的条目。现在能力给全，交付物纪律进提示词。
 *
 * 所以这里钉的不是文案，而是几条**会被后续改动悄悄破坏**的结构约束：
 *
 * 1. 工具就是 COMMON_TOOLS，一个不少——再有人想"给编码助手瘦身"先看这几条测试的理由。
 * 2. 砍工具让位给提示词：交付物纪律必须在提示词里写着。
 * 3. 提示词不能长回去。
 * 4. 前置页只做一件事：选仓库。不许长出设计助手那样的必选模板卡。
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildCodingRole } from '../../src/main/roles/coding-role'

// 与 role-manager 的 COMMON_TOOLS 保持一致的最小复刻会漂移，所以直接读源文件解析。
// 目的就是"公共表变了这里要跟着动"，用真值而不是快照。
function readCommonTools(): string[] {
  const src = fs.readFileSync('src/main/role-manager.ts', 'utf8')
  const start = src.indexOf('export const COMMON_TOOLS = [')
  const end = src.indexOf(']', start)
  return Array.from(src.slice(start, end).matchAll(/'([a-z0-9_]+)'/g)).map(m => m[1])
}

const COMMON_TOOLS = readCommonTools()
const coding = buildCodingRole(COMMON_TOOLS).coding

describe('工具集', () => {
  it('公共表解析出来是完整的（防止上面那段解析悄悄失效）', () => {
    expect(COMMON_TOOLS.length).toBeGreaterThan(20)
    expect(COMMON_TOOLS).toContain('bash')
    expect(COMMON_TOOLS).toContain('create_artifact')
  })

  it('就是 COMMON_TOOLS，一个不少', () => {
    expect(coding.tools).toEqual(COMMON_TOOLS)
  })

  /**
   * 这条是防复发的：产物族与浏览器族被摘掉过一次，理由是"编码的交付物是仓库里的 diff"。
   * 那句话本身没错，错在用**拿掉能力**来执行它——按 CLAUDE.md 的判定公式，"怕模型选错交付物"
   * 是能力拐杖而不是永久架构，而且是可逆错误，够不上硬拒绝那一档。真实代价：内置技能里
   * dc-authoring / frontend-design / web-research 等 13 个点名要这些工具，摘完它们全成了死条目。
   */
  it('产物族与浏览器族在 —— 曾被当成"噪音"摘掉，是错的', () => {
    for (const tool of [
      'create_artifact', 'read_artifact', 'edit_artifact', 'render_artifact', 'export_artifact',
      'create_visualizer', 'generate_document', 'present_to_user', 'read_page_content',
      'browser_navigate', 'browser_click', 'browser_read_page',
      'execute_code', 'manage_task'
    ]) {
      expect(coding.tools).toContain(tool)
    }
  })

  it('写代码真正要用的当然也都在', () => {
    for (const tool of ['bash', 'read', 'write', 'edit', 'ls', 'find', 'grep', 'update_todos', 'subagent', 'web_search', 'ask_user']) {
      expect(coding.tools).toContain(tool)
    }
  })

  it('屏幕相关的两个在 —— 贴前台应用是这个 App 相对 CLI agent 的真实优势', () => {
    expect(coding.tools).toContain('capture_screenshot')
    expect(coding.tools).toContain('read_screen')
  })

  it('不擅自往上加 —— questions_v2 那种面板重的留给设计助手', () => {
    expect(coding.tools).not.toContain('questions_v2')
  })

  it('公共表下架某个工具时跟着消失，不留死名字', () => {
    const trimmed = COMMON_TOOLS.filter(t => t !== 'subagent')
    expect(buildCodingRole(trimmed).coding.tools).not.toContain('subagent')
  })
})

describe('提示词', () => {
  it('保持薄 —— 越过 6KB 说明知识又开始往角色里搬了', () => {
    expect(coding.systemPrompt.length).toBeLessThan(6_000)
    // 也不能薄到没内容
    expect(coding.systemPrompt.length).toBeGreaterThan(800)
  })

  /**
   * 这几条是对着公开的编码 agent 逐条比对后补齐的（pi 的 system-prompt.js、Codex 的
   * gpt-5.2-codex_prompt.md、DeepSeek Harness 的 code-mode 快照、Claude Code 的输出契约）。
   * 每一条对应一类真实事故，掉了不会有编译错误、只会在真跑的时候咬人。
   */
  it('脏工作区纪律：不回退用户的改动，撞见没做过的改动就停', () => {
    expect(coding.systemPrompt).toContain('不许回退')
    expect(coding.systemPrompt).toContain('停下来问用户')
    // 未经允许不提交
    expect(coding.systemPrompt).toMatch(/git commit|git add/)
  })

  it('退出码要看 —— 命令跑了不看结果等于没跑', () => {
    expect(coding.systemPrompt).toContain('退出码')
  })

  it('注释纪律：只写为什么，不写这行在干什么', () => {
    expect(coding.systemPrompt).toMatch(/注释只加在逻辑不自明/)
  })

  it('别在聊天里预先请示 —— 会弹确认框的直接做', () => {
    expect(coding.systemPrompt).toMatch(/别在聊天里先问/)
    // 但不可逆的仍然要先说清楚，这两条必须同时在，只留一条就跑偏
    expect(coding.systemPrompt).toMatch(/不可逆/)
  })

  it('收尾引用位置用 路径:行号（可点开），不整段贴文件', () => {
    expect(coding.systemPrompt).toMatch(/路径:行号/)
  })

  it('把三条最容易出事的纪律写进去了', () => {
    // 项目规矩已注入，别重复读
    expect(coding.systemPrompt).toContain('<project_context>')
    expect(coding.systemPrompt).toContain('不要再 read 一遍')
    // 没跑过就不许说验证过
    expect(coding.systemPrompt).toContain('尚未运行时验证')
    // 不可逆操作先说清楚
    expect(coding.systemPrompt).toMatch(/git reset --hard/)
  })

  it('交付物纪律进了提示词 —— 它替代了原来"把产物工具摘掉"那种做法', () => {
    expect(coding.systemPrompt).toContain('别拿产物顶替改动')
    // 同时得说清什么时候画是对的，否则只剩禁令、模型会连该画的图也不画
    expect(coding.systemPrompt).toMatch(/架构图|原型/)
  })

  it('不写死具体命令 —— 命令来自项目自己的配置', () => {
    expect(coding.systemPrompt).toContain('package.json')
    expect(coding.systemPrompt).not.toMatch(/npm run test\b/)
  })
})

describe('前置页', () => {
  const manifest = JSON.parse(
    fs.readFileSync(path.join('resources/system-agents/coding/preflow.json'), 'utf8')
  )

  it('只做一件事：选仓库', () => {
    expect(manifest.workingDir?.enabled).toBe(true)
    // 设计助手那种必选模板卡在这里是纯打扰：大多数会话就是"这个 bug 怎么修"
    expect(manifest.fields).toEqual([])
    expect(manifest.allowSkip).toBe(true)
    expect(manifest.projectName?.enabled).toBe(false)
    expect(manifest.dsSelector?.enabled).toBe(false)
  })

  it('英文覆盖层跟基础层的按钮一一对应', () => {
    const kinds = manifest.contextButtons.map((b: any) => b.kind)
    expect(Object.keys(manifest.localeOverlays.en.contextButtons).sort()).toEqual([...kinds].sort())
    expect(manifest.localeOverlays.en.title).toBeTruthy()
    expect(manifest.localeOverlays.en.inputPlaceholder).toBeTruthy()
  })
})

describe('落盘的 agent.md 种子', () => {
  /**
   * tools 给全之后 roleConfigToMd 会写 `*`，加载时再展开成**当时**的 COMMON_TOOLS。
   * 这比显式清单更抗漂移：公共表增删工具，存量安装的 agent.md 不用重新种子就跟着变。
   */
  it('写成 `*`（加载时展开成当时的 COMMON_TOOLS）', () => {
    const loader = fs.readFileSync('src/main/role-loader.ts', 'utf8')
    expect(loader).toContain('const isSupersetOfCommon = commonTools.every(t => roleSet.has(t))')
    expect(COMMON_TOOLS.every(t => coding.tools.includes(t))).toBe(true)
    // `*` 必须能被解析回来，否则种子写出去就读不回
    expect(loader).toContain("if (item === '*')")
  })
})

describe('注册', () => {
  const roleManager = fs.readFileSync('src/main/role-manager.ts', 'utf8')

  it('在 BUILTIN_ROLES 里展开，且走自己的文件（文件式取舍）', () => {
    expect(roleManager).toContain("import { buildCodingRole } from './roles/coding-role'")
    expect(roleManager).toContain('...buildCodingRole(COMMON_TOOLS)')
  })

  it('角色名进了 i18n 键表，否则界面上显示的是原始 name', () => {
    const resources = fs.readFileSync('src/shared/i18n/resources.ts', 'utf8')
    expect(resources).toContain("coding: 'roles.coding.name'")
    expect(resources).toContain("name: '编码助手'")
    expect(resources).toContain("name: 'Coding Assistant'")
  })
})
