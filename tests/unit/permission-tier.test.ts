import fs from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * 权限档位（Phase 4）—— 只给编码助手的会话级开关。
 *
 * 这个文件钉的核心是**一条不可破的不变量**：`full`（完全允许）只吃掉
 * `needs_confirmation` 那一档的弹框，绝不放行 `risky`，也绝不越过 `assessToolScope`
 * 的任务边界。用户点"别再问我了"表达的是嫌打扰，不是要把安全层关掉——这两件事被混成
 * 一件，就是把一个 UX 开关悄悄改造成了权限提升按钮。
 *
 * 另一条是只读档的**两层**：schema 层收窄（模型压根看不到写工具，不会反复重试绕路）
 * 加执行层拒绝（纵深防御，兜住某条组装路径漏了收窄的情况）。只留一层都不算数。
 */
vi.mock('../../src/main/sandbox-manager', () => ({
  isSandboxed: () => true,
  syncSandboxWorkspaceRoots: () => {}
}))

const {
  authorizeToolCall,
  clearSessionApprovals,
  READONLY_TIER_TOOLS
} = await import('../../src/main/pi-security')
const { filterOpenPipalTools } = await import('../../src/main/openpipal-product-tools')
const { BROWSER_READ_TOOLS, BROWSER_WRITE_TOOLS } = await import('../../src/main/browser-tools')

afterEach(() => { clearSessionApprovals() })

/** 记录"有没有弹框问用户"——档位的全部作用就体现在这一件事上 */
function spyHandler(answer = true): { handler: any; calls: () => number } {
  let calls = 0
  return { handler: async () => { calls++; return answer }, calls: () => calls }
}

describe('full 档：只吃确认，不碰安全层', () => {
  it('放行普通的 needs_confirmation（不再弹框）', async () => {
    const spy = spyHandler()
    const verdict = await authorizeToolCall(
      'some_unclassified_tool', { value: 'x' },
      { conversationId: 'c1', onConfirmation: spy.handler, tier: 'full' }
    )
    expect(verdict).toBeUndefined()
    expect(spy.calls()).toBe(0)
  })

  it('risky 照旧硬拒 —— 这是 full 与"关掉安全层"的分界线', async () => {
    const spy = spyHandler()
    // blocked 档（不可逆 / 越过沙箱信任模型）：有沙箱也拦，Layer 3 硬边界
    const verdict = await authorizeToolCall(
      'bash', { command: 'sudo rm -rf /' },
      { conversationId: 'c1', onConfirmation: spy.handler, tier: 'full' }
    )
    expect(verdict?.block).toBe(true)
    expect(spy.calls()).toBe(0)
  })

  /**
   * 第一版这里是漏的：`rm -rf` / `git reset --hard` 属于 confirm 档而不是 blocked 档
   * （故意的——编码工作里它们是日常操作，硬拒会让 agent 在需要回滚时走投无路），
   * 于是 full 一短路就把它们全自动放行了。少问一次省几秒，问漏一次可能是别人半天的活，
   * 代价不对称。现在它们和主目录遍历同待遇：alwaysConfirm，完全允许档也吃不掉。
   */
  it.each([
    ['bash', { command: 'git reset --hard HEAD~3' }],
    ['bash', { command: 'rm -rf ./src' }],
    ['bash', { command: 'git push --force origin main' }],
    ['execute_code', { language: 'python', code: 'import shutil; shutil.rmtree("src")' }]
  ])('破坏性操作仍然要问一次：%s', async (toolName, args) => {
    const spy = spyHandler()
    const verdict = await authorizeToolCall(
      toolName, args as Record<string, any>,
      { conversationId: 'c-destructive', onConfirmation: spy.handler, tier: 'full' }
    )
    expect(verdict).toBeUndefined()
    expect(spy.calls(), '完全允许档不许替用户裁决破坏性操作').toBe(1)
  })

  it('远程 MCP 工具不放行 —— 名字和实现都由对方控制，不继承内置自动放行', async () => {
    const spy = spyHandler()
    const verdict = await authorizeToolCall(
      'read', { path: '/tmp/x' },
      { conversationId: 'c1', onConfirmation: spy.handler, tier: 'full', scope: { origin: 'mcp' } }
    )
    expect(verdict).toBeUndefined()
    // 放行是因为用户在弹框里点了同意，不是因为档位短路
    expect(spy.calls()).toBe(1)
  })

  it('主目录/全盘遍历仍然要问 —— 隐私同意不该被一次"别问我了"顺带关掉', async () => {
    const spy = spyHandler()
    const home = process.env.HOME || '/Users/x'
    const verdict = await authorizeToolCall(
      'bash', { command: `find ${home} -name '*.png'` },
      { conversationId: 'c1', onConfirmation: spy.handler, tier: 'full' }
    )
    expect(verdict).toBeUndefined()
    expect(spy.calls(), '完全允许档不许吃掉 alwaysConfirm 的那一类').toBe(1)
  })
})

describe('auto 档 / 不传：就是历史行为', () => {
  it.each([undefined, 'auto' as const])('tier=%s 时该问还是问', async tier => {
    const spy = spyHandler()
    await authorizeToolCall(
      'some_unclassified_tool', { value: 'x' },
      { conversationId: `c-${String(tier)}`, onConfirmation: spy.handler, tier }
    )
    expect(spy.calls()).toBe(1)
  })
})

describe('readonly 档', () => {
  it('拦下写类工具，并且告诉模型接下来该干什么', async () => {
    const spy = spyHandler()
    const verdict = await authorizeToolCall(
      'write', { path: '/tmp/x', content: 'y' },
      { conversationId: 'c2', onConfirmation: spy.handler, tier: 'readonly' }
    )
    expect(verdict?.block).toBe(true)
    // 只说"被拒"模型会换个工具再试一遍；要让它知道这一档就是不给动手
    expect(verdict?.reason).toContain('只读档')
    expect(verdict?.reason).toMatch(/告诉用户|自动审核/)
    expect(spy.calls()).toBe(0)
  })

  it.each(['bash', 'edit', 'subagent', 'execute_code', 'browser_click'])(
    '%s 不在白名单里', async toolName => {
      const verdict = await authorizeToolCall(
        toolName, {}, { conversationId: 'c2', onConfirmation: spyHandler().handler, tier: 'readonly' }
      )
      expect(verdict?.block).toBe(true)
    }
  )

  it('读类工具照常放行', async () => {
    for (const toolName of ['ask_user', 'update_todos']) {
      const verdict = await authorizeToolCall(
        toolName, { question: 'x' }, { conversationId: 'c3', tier: 'readonly' }
      )
      expect(verdict, `${toolName} 应当放行`).toBeUndefined()
    }
  })

  it('schema 层就收窄 —— 模型看不到写工具，才不会反复找绕法', () => {
    const tools = [
      { name: 'read' }, { name: 'grep' }, { name: 'ls' },
      { name: 'write' }, { name: 'edit' }, { name: 'bash' }, { name: 'create_artifact' }
    ]
    const kept = filterOpenPipalTools(tools, { permissionTier: 'readonly' }).map(t => t.name)
    expect(kept).toEqual(['read', 'grep', 'ls'])
    // 不传档位时一个都不少（默认零影响）
    expect(filterOpenPipalTools(tools, {}).map(t => t.name)).toHaveLength(tools.length)
  })
})

describe('只读白名单本身', () => {
  it('浏览器读工具与 browser-tools 的定义一致，写工具一个都不在', () => {
    for (const t of BROWSER_READ_TOOLS) expect(READONLY_TIER_TOOLS).toContain(t)
    for (const t of BROWSER_WRITE_TOOLS) expect(READONLY_TIER_TOOLS).not.toContain(t)
  })

  it('不含任何能动东西的工具', () => {
    for (const t of ['write', 'edit', 'bash', 'execute_code', 'subagent',
                     'create_artifact', 'edit_artifact', 'generate_document', 'manage_task']) {
      expect(READONLY_TIER_TOOLS).not.toContain(t)
    }
  })

  it('每个名字都是真工具（不留死名字）', () => {
    const src = fs.readFileSync('src/main/role-manager.ts', 'utf8')
    const seg = src.slice(src.indexOf('export const COMMON_TOOLS = ['))
    const common = new Set(Array.from(seg.slice(0, seg.indexOf(']')).matchAll(/'([a-z0-9_]+)'/g)).map(m => m[1]))
    for (const t of READONLY_TIER_TOOLS) expect(common, `${t} 不在 COMMON_TOOLS 里`).toContain(t)
  })
})

describe('接线', () => {
  it('档位只在编码助手的会话上生效 —— 外部客户端能 PATCH 会话 config，放宽必须有门', () => {
    const src = fs.readFileSync('src/main/agent-overrides.ts', 'utf8')
    expect(src).toContain("roleName === 'coding'")
    expect(src).toContain('conversationConfig?.permissionTier')
  })

  it('界面只给编码助手渲染档位控件 —— 别的角色不该被迫理解工具风险分级', () => {
    const src = fs.readFileSync('src/renderer/src/components/InputBar.tsx', 'utf8')
    expect(src).toMatch(/roleName === 'coding' && <PermissionTierControl/)
  })

  it('三档的名字和说明都走 i18n，中英都有', () => {
    const src = fs.readFileSync('src/shared/i18n/resources.ts', 'utf8')
    // 每档一个 label + 一个 desc，两种语言 = 12 处；少一处就是某语言漏了
    for (const tier of ['readonly', 'auto', 'full']) {
      const block = new RegExp(`${tier}: \\{\\s*\\n\\s*label:[^\\n]*\\n\\s*desc:`, 'g')
      expect(src.match(block)?.length, `${tier} 应当在中英两份里各有一处`).toBe(2)
    }
  })

  it('完全允许档的说明必须写明破坏性操作仍会问 —— 界面不许比代码承诺得多', () => {
    const src = fs.readFileSync('src/shared/i18n/resources.ts', 'utf8')
    expect(src).toMatch(/删除、回滚、强推这类仍会问一次/)
    expect(src).toMatch(/Deleting, resetting, and force-pushing still ask once/)
  })

  it('档位跟着会话走，不写全局配置', () => {
    const src = fs.readFileSync('src/renderer/src/stores/chatStore.ts', 'utf8')
    const fn = src.slice(src.indexOf('setConversationPermissionTier: (tier)'))
    const body = fn.slice(0, fn.indexOf('\n  },'))
    expect(body).toContain('updateConversationConfig')
    expect(body, '档位不该碰全局设置').not.toMatch(/updateConfig|saveConfig|appConfig/)
  })

  it('两条运行时都把档位传进授权层', () => {
    expect(fs.readFileSync('src/main/agent-runtime/pi-core-runtime.ts', 'utf8'))
      .toContain('tier: overrides?.permissionTier')
    expect(fs.readFileSync('src/main/pi-agent-service.ts', 'utf8'))
      .toContain('overrides?.permissionTier')
  })
})
