/**
 * 契约锁：只有「用得上」时，用户/环境信息才准进上下文。
 *
 * 两条独立的门：
 *   1. ClassIn UID —— 只在本会话确实挂载了 classin 工具时才进系统提示词
 *   2. 前台应用信息（应用名 / 环境快照 / 截图）—— 只在**真的挂靠**时才可获取
 *
 * 历史坑：注入条件曾是「环境变量 CLASSIN_SID 有值就注入」。于是默认助手这种
 * 跟 ClassIn 毫无关系的会话也会在系统提示里拿到用户 UID —— 用户问「你是谁」，
 * 模型顺口答「你当前在 ClassIn 里使用我(UID …)」。凭据不但被模型说出来，
 * 还每一轮都随请求发给用户自己配置的第三方端点。
 *
 * 这里钉两件事：注入必须过 hasVisibleMcpServer 这道门，以及那道门本身的语义
 * （会话内不可见的 server 不算挂载）。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const promptCore = readFileSync('src/main/agent-runtime/openpipal-prompt-core.ts', 'utf8')
const mcpManager = readFileSync('src/main/mcp-manager.ts', 'utf8')

const windowTracker = readFileSync('src/main/window-tracker.ts', 'utf8')
const productTools = readFileSync('src/main/openpipal-product-tools.ts', 'utf8')

describe('ClassIn UID 注入范围', () => {
  it('注入条件必须包含「classin 工具在场」这道门，不能退回只看环境变量', () => {
    // 门本身
    expect(promptCore).toContain("hasVisibleMcpServer('classin', overrides?.conversationId)")
    expect(promptCore).toContain('const classinMounted =')
    // 拼接必须用 classinMounted，而不是直接用 classinUid 真值
    expect(promptCore).toContain('const userContext = classinMounted')
    expect(promptCore).not.toMatch(/const userContext = classinUid\s*\n?\s*\?/)
  })

  it('UID 只出现在被门控的那一处，没有第二条注入路径', () => {
    const hits = promptCore.match(/\$\{classinUid\}/g) || []
    expect(hits).toHaveLength(1)
  })

  it('hasVisibleMcpServer 走 visibleServers，因此 ACP 会话注入的 server 不会跨会话生效', () => {
    expect(mcpManager).toContain('export function hasVisibleMcpServer')
    const fn = mcpManager.slice(
      mcpManager.indexOf('export function hasVisibleMcpServer'),
      mcpManager.indexOf('export function getMcpToolIndex')
    )
    // 必须复用同一套可见性判定（isVisible → sessionId 匹配），不能自己遍历 servers
    expect(fn).toContain('visibleServers(sessionId)')
    expect(fn).not.toMatch(/\bservers\.(some|filter|find)\b/)
  })
})

describe('前台应用信息的获取范围', () => {
  it('提示词里的应用名与截图工具都过同一道门', () => {
    expect(promptCore).toContain('stablePrefix || !isDockedToTargetApp()')
    // 旧判据 displayName === processName 只说明「这个应用在内置表里」，与用户是否同意无关
    expect(promptCore).not.toContain('config.displayName === config.processName')
    const tool = productTools.slice(
      productTools.indexOf('function createCaptureScreenshotTool'),
      productTools.indexOf('await captureTargetWindow()')
    )
    expect(tool).toContain('if (!isDockedToTargetApp())')
  })
})
