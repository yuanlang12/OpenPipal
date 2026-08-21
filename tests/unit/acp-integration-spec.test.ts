import { describe, expect, it } from 'vitest'
import { createRendererI18n } from '../../src/renderer/src/i18n'
import { buildIntegrationSpec } from '../../src/renderer/src/components/AcpConnections'

const TOKEN_PATH = '/Users/x/.openpipal/acp-mcp.token'
const ADAPTER = {
  command: '/Applications/OpenPipal.app/Contents/MacOS/OpenPipal',
  args: ['/Applications/OpenPipal.app/Contents/Resources/acp/openpipal-acp.mjs'],
  env: { ELECTRON_RUN_AS_NODE: '1' }
}

async function spec(locale: string, adapter = ADAPTER as typeof ADAPTER | null): Promise<string> {
  const i18n = await createRendererI18n(locale)
  return buildIntegrationSpec(3031, TOKEN_PATH, adapter, i18n.getFixedT(locale) as never)
}

/**
 * 这段文本是给**另一个 AI** 照着做对接用的，不是给人看的宣传语。
 * 错一个字段名、少一句约定，对方就写出跑不通的集成——所以逐项钉住。
 */
describe('“复制给 AI” 的对接说明', () => {
  it('回答三件事：往哪儿发、怎么带令牌、收发什么格式', async () => {
    const text = await spec('zh-CN')

    // 1. 往哪儿发——真实端口，不是占位符
    expect(text).toContain('http://127.0.0.1:3031/health')
    expect(text).toContain('"app":"openpipal"')
    expect(text).not.toMatch(/\{\{|<port>/)

    // 2. 怎么带令牌——头名 + 这台机器上的真实路径
    expect(text).toContain('X-OpenPipal-ACP-Token: <token>')
    expect(text).toContain(TOKEN_PATH)

    // 3. 收发什么格式——建会话、发消息、SSE 事件、终止条件
    expect(text).toContain('POST http://127.0.0.1:3031/api/conversations')
    expect(text).toContain('POST http://127.0.0.1:3031/chat/stream')
    expect(text).toContain('"source": "acp"')
    expect(text).toContain('data: {"type":"text","content":"..."}')
    expect(text).toContain('data: {"type":"done"}')
    expect(text).toContain('data: {"type":"error","content":"..."}')
  })

  it('把两条最容易写错的约定写死在里面', async () => {
    const text = await spec('zh-CN')

    // 每轮只发最新一条 user 消息——内联历史是纯冗余，第一次对接必踩
    expect(text).toContain('只发最新一条用户消息')
    // 权限事件不回传就会一直卡着，必须原样回 requestId / executionId
    expect(text).toContain('POST http://127.0.0.1:3031/api/permission')
    expect(text).toContain('"requestId"')
    expect(text).toContain('"executionId"')
    expect(text).toContain('停在那里')
  })

  it('英文版同样完整，且接口本身不被翻译', async () => {
    const english = await spec('en')

    expect(english).toContain('OpenPipal local API integration guide')
    expect(english).toContain('send only the newest user message')
    // 代码块是接口本身：翻译它等于写错
    expect(english).toContain('X-OpenPipal-ACP-Token: <token>')
    expect(english).toContain('"source": "acp"')
    expect(english).toContain('data: {"type":"done"}')
  })

  it('端口跟着真实值走，不写死 3031', async () => {
    const i18n = await createRendererI18n('zh-CN')
    const text = buildIntegrationSpec(4577, TOKEN_PATH, null, i18n.getFixedT('zh-CN') as never)

    expect(text).toContain('http://127.0.0.1:4577/chat/stream')
    expect(text).not.toContain('3031')
  })

  /**
   * 随包带了适配器，对方又恰好是支持 ACP 的编辑器时，它根本不用自己拼 HTTP——
   * 直接 spawn 这条命令。命令必须逐字可用：可执行文件 + 脚本路径 + 那个环境变量，
   * 少一样编辑器就起不来。
   */
  it('带了适配器就把编辑器的启动命令一并写进去', async () => {
    const text = await spec('zh-CN')

    expect(text).toContain('ACP')
    expect(text).toContain(ADAPTER.command)
    expect(text).toContain(ADAPTER.args[0])
    expect(text).toContain('"ELECTRON_RUN_AS_NODE": "1"')
  })

  it('没带适配器就整段不写，不给一条跑不通的命令', async () => {
    const text = await spec('zh-CN', null)

    expect(text).not.toContain('ELECTRON_RUN_AS_NODE')
    expect(text).not.toContain('openpipal-acp.mjs')
    // 其余三段照旧完整
    expect(text).toContain('http://127.0.0.1:3031/chat/stream')
  })

  it('技能接口按角色取，不再只认 workspaceId', async () => {
    // role 这一档是内置角色专属技能（teacher 等）唯一的入口：漏了它，
    // 编辑器的斜杠菜单就比模型实际能用的技能少一截
    expect(await spec('zh-CN')).toContain('/api/skills?role=')
  })
})
