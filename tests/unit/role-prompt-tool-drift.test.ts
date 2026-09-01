import fs from 'node:fs'
import { describe, expect, it, vi } from 'vitest'

/**
 * 角色提示词提到的工具，必须真的在这个角色的工具表里。
 *
 * 提示词里每一句"用 \`grep\` 找""改用 \`edit\`"都是对模型的承诺。工具表变了而提示词没跟着变，
 * 编译不报错、别的测试也不红，只有真跑的时候才发作——而模型撞上一个不存在的工具时，通常
 * 不会说"没这个工具"，而是绕道用 bash，或者干脆按提示词的说法编一个结果出来。
 *
 * 两条规则各盯一种漂移，缺一不可：
 *
 * 1. **反引号里的小写标识符**，要么是已知工具，要么在 SHELL_COMMANDS 白名单里。
 *    盯的是**工具被删掉/改名**——只查"提示词提到的已知工具在不在角色表里"是抓不到删除的，
 *    因为工具名同时从两边消失，扫描器根本不会去找它（第一版就是这么写的，实测放行了
 *    "从 COMMON_TOOLS 删掉 grep"这个改动）。
 * 2. **提示词点名的已知工具**必须在这个角色自己的表里。
 *    盯的是**某个角色的表被收窄**——权限档位（只读档拿掉 write/edit）、
 *    浏览器工具只在扩展连上时注入，都是这一类。
 *
 * 2026-08-22 建这条时的实测：7 个内置角色零漂移（design 提到 18 个、teacher 9 个、coding 9 个）。
 * 所以它不是在修 bug，是给一类"改工具表时没人会想起去查提示词"的静默失效上闩。
 *
 * 已知不覆盖：没写在反引号里的裸提及（中文散文里挑英文单词误报太多）。所以提示词里点名工具
 * 请一律用反引号包起来——这也更好读。
 *
 * 误报了怎么办：把那个词改写成不像工具名的说法，或者确认这个角色本来就该有它、去补工具表。
 * **不要**往 SHELL_COMMANDS 里加工具名——那等于把这条测试关掉。
 */
vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => process.cwd(), getPath: () => '/tmp/openpipal-role-drift' }
}))

const { buildCodingRole } = await import('../../src/main/roles/coding-role')
const { buildDesignRole } = await import('../../src/main/roles/design-role')
const { buildOptionalRoles } = await import('../../src/main/roles/optional-roles')

const roleManagerSrc = fs.readFileSync('src/main/role-manager.ts', 'utf8')

function parseCommonTools(): string[] {
  const seg = roleManagerSrc.slice(roleManagerSrc.indexOf('export const COMMON_TOOLS = ['))
  return Array.from(seg.slice(0, seg.indexOf(']')).matchAll(/'([a-z0-9_]+)'/g)).map(m => m[1])
}

function parseGeneralPrompt(): string {
  const marker = 'export const GENERAL_SYSTEM_PROMPT = `'
  const body = roleManagerSrc.slice(roleManagerSrc.indexOf(marker) + marker.length)
  return body.slice(0, body.indexOf('`'))
}

const COMMON_TOOLS = parseCommonTools()
// questions_v2 故意不在 COMMON_TOOLS，由需要它的角色自己加（见 role-manager 里的注释）
const KNOWN_TOOLS = new Set([...COMMON_TOOLS, 'questions_v2'])

/** 反引号里合法出现的非工具词：shell 命令，用来说明"别用 bash 干这个"。不是豁免清单。 */
const SHELL_COMMANDS = new Set(['cat'])

const ROLES: Record<string, { tools: string[]; systemPrompt: string }> = {
  general: { tools: COMMON_TOOLS, systemPrompt: parseGeneralPrompt() },
  ...buildOptionalRoles(COMMON_TOOLS),
  ...buildDesignRole(COMMON_TOOLS),
  ...buildCodingRole(COMMON_TOOLS)
}
const ROLE_NAMES = Object.keys(ROLES)

/** 反引号里的裸小写标识符。带点/斜杠/空格/连字符的（package.json、git reset --hard）自然被排除 */
function backtickedIdentifiers(prompt: string): string[] {
  return [...new Set(Array.from(prompt.matchAll(/`([a-z][a-z0-9_]*)`/g)).map(m => m[1]))]
}

/** 整词匹配：`read` 不会命中 `read_screen`（下划线是词字符） */
function knownToolsMentionedIn(prompt: string): string[] {
  return [...KNOWN_TOOLS].filter(name => new RegExp(`\\b${name}\\b`).test(prompt))
}

describe('角色提示词与工具表不许漂移', () => {
  it('扫描本身是有效的 —— 至少有角色真的在提示词里点名工具', () => {
    expect(ROLE_NAMES.length).toBeGreaterThanOrEqual(5)
    const total = ROLE_NAMES.reduce((n, r) => n + knownToolsMentionedIn(ROLES[r].systemPrompt).length, 0)
    // 归零说明正则失效或提示词被整体重写，不是"真的没人提工具"
    expect(total).toBeGreaterThan(10)
  })

  it.each(ROLE_NAMES)('%s：反引号里的标识符都还是真工具（抓删除/改名）', roleName => {
    const orphans = backtickedIdentifiers(ROLES[roleName].systemPrompt)
      .filter(id => !KNOWN_TOOLS.has(id) && !SHELL_COMMANDS.has(id))
    expect(orphans, `${roleName} 的提示词点名了系统里已经不存在的工具：${orphans.join(', ')}`).toEqual([])
  })

  it.each(ROLE_NAMES)('%s：点名的工具都在自己表里（抓角色收窄）', roleName => {
    const own = new Set(ROLES[roleName].tools)
    const lying = knownToolsMentionedIn(ROLES[roleName].systemPrompt).filter(t => !own.has(t))
    expect(lying, `${roleName} 的提示词点名了它没有的工具：${lying.join(', ')}`).toEqual([])
  })
})
