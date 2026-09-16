/**
 * 统一身份第 4 段（后半）：全局"当前角色"退场。
 *   - 主进程没有 switchRole / 全局 currentRole；只剩 getDefaultRole()（通用助手），且只给"没有任何身份线索"的兜底用
 *   - IPC / HTTP / preload / 插件 shim 都没有 get-current / switch / init-state 三条
 *   - 渲染层：appStore.currentRole 从活跃会话的 role 派生（App 里一个 effect 同步），欢迎页点头像改的是空会话的 role，
 *     选内置 Agent = 开一条它的会话；没有 'learner' 兜底（公开版没有这个角色）
 *   - 资产库按"这条对话的角色"取目录，删除边界是所有角色资产库的父目录
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (file: string): string => readFileSync(file, 'utf8')

describe('主进程：没有全局当前角色', () => {
  it('role-manager 只剩 getDefaultRole；不再读写 config.role', () => {
    const src = read('src/main/role-manager.ts')
    expect(src).toContain('export function getDefaultRole(): RoleConfig')
    expect(src).not.toMatch(/export function (switchRole|getCurrentRole)\b/)
    expect(src).not.toMatch(/^let currentRole\b/m)
    expect(src).not.toMatch(/config\.role\b/)
    expect(src).not.toContain("from './config-manager'")
  })

  it('IPC / HTTP / 允许名单 / preload / shim 都没有 current / switch / init-state', () => {
    expect(read('src/main/index.ts')).not.toMatch(/role:(get-current|switch|get-init-state)/)
    const http = read('src/main/http-server.ts')
    expect(http).not.toMatch(/\/role\/(current|switch|init-state)/)
    expect(read('src/main/local-http-auth.ts')).not.toMatch(/\/role\/(current|switch|init-state)/)
    for (const file of ['src/preload/index.ts', 'src/preload/index.d.ts', 'src/renderer/src/web-api-shim.ts']) {
      expect(read(file), file).not.toMatch(/getRoleInitState|getCurrentRole|switchRole/)
    }
  })

  it('运行时兜底全部走 getDefaultRole，没有一处再读 getCurrentRole', () => {
    for (const file of ['src/main/agent-overrides.ts', 'src/main/ipc-handlers.ts', 'src/main/http-server.ts', 'src/main/scheduler.ts', 'src/main/realtime-session.ts', 'src/main/agent-runtime/openpipal-prompt-core.ts']) {
      expect(read(file), file).not.toMatch(/getCurrentRole\(/)
    }
    expect(read('src/main/scheduler.ts')).toMatch(/task\.role \|\| DEFAULT_AGENT_ID/)
    expect(read('src/main/scheduler.ts')).not.toContain("'learner'")
  })

  it('资产库按对话的角色取目录；删除边界是所有角色资产库的父目录', () => {
    const rm = read('src/main/role-manager.ts')
    expect(rm).toContain('export function getRoleAssetsDir(roleName?: string): string')
    expect(rm).toContain('export function getRoleAssetsRoot(): string')
    const ipc = read('src/main/ipc-handlers.ts')
    expect(ipc).toMatch(/ipcMain\.handle\('assets:list-role-systems', async \(_event, roleName\?: string\) => listRoleSystemFolders\(roleName\)\)/)
    expect(ipc).toMatch(/const roots = \[getRoleAssetsRoot\(\), dataPath\('workspace', 'uploads'\)\]/)
    expect(read('src/main/http-server.ts')).toMatch(/getRoleAssetsDir\(body\.roleName\)/)
    expect(read('src/renderer/src/components/RolePreflowPanel.tsx')).toContain('listRoleSystems?.(roleName)')
  })
})

describe('渲染层：正看着的角色 = 活跃会话的角色', () => {
  it('appStore 没有 switchRole；currentRole 由 setCurrentRoleName 对表设定，认不出回落通用助手', () => {
    const store = read('src/renderer/src/stores/appStore.ts')
    expect(store).not.toContain('switchRole')
    expect(store).not.toContain('getRoleInitState')
    expect(store).toMatch(/roles\.find\(r => r\.name === name\) \?\? roles\.find\(r => r\.name === DEFAULT_AGENT_ID\) \?\? roles\[0\] \?\? null/)
  })

  it('App 启动只 initConversations 一次，再用一个 effect 把活跃会话的 role 同步进 currentRole', () => {
    const app = read('src/renderer/src/App.tsx')
    expect(app).toMatch(/useEffect\(\(\) => \{\n\s*if \(initialized\) useChatStore\.getState\(\)\.initConversations\(\)\n\s*\}, \[initialized\]\)/)
    expect(app).toMatch(/const activeRoleName = useChatStore\(s => s\.conversations\.find\(c => c\.id === s\.activeConversationId\)\?\.role\)/)
    expect(app).toMatch(/useEffect\(\(\) => \{ if \(activeRoleName\) setCurrentRoleName\(activeRoleName\) \}, \[activeConversationId, activeRoleName, setCurrentRoleName\]\)/)
    expect(app).not.toContain('handleSwitchRole')
  })

  it('欢迎页点头像 = 改 appStore 里的待定选择（首条消息才钉成会话 role），不再有本地 selectedRole 状态、不调任何 IPC', () => {
    const welcome = read('src/renderer/src/components/WelcomePage.tsx')
    expect(welcome).toContain("const selectedRole = currentRole?.name || 'general'")
    expect(welcome).toMatch(/const pickRole = useCallback\(\(name: string\) => setCurrentRoleName\(name\), \[setCurrentRoleName\]\)/)
    expect(welcome).not.toContain('useState(\'general\')')
    expect(welcome).not.toContain('welcomeNonce')
  })

  it("渲染层没有 'learner' 兜底；新建对话固定通用助手", () => {
    const files = ['App.tsx', 'components/ChatPanel.tsx', 'hooks/useRealtimeVoice.ts', 'components/BrowserTopBar.tsx', 'components/workspace/tabs/ArtifactTab.tsx', 'components/PendingMessageStack.tsx', 'components/InputBar.tsx', 'components/artifacts/CanvasOrb.tsx', 'components/artifacts/CanvasArtifact.tsx', 'components/OrbView.tsx', 'components/Sidebar.tsx']
    for (const file of files) expect(read(`src/renderer/src/${file}`), file).not.toMatch(/\|\| 'learner'/)
    expect(read('src/renderer/src/components/BrowserTopBar.tsx')).toContain("newConversation('general')")
    expect(read('src/renderer/src/components/Sidebar.tsx')).toContain("newConversation('general')")
  })
})
