import { Page } from '@playwright/test'

/**
 * 共享测试引导 helper。
 *
 * 背景：App 启动 / newConversation 后 activeConversationId=null、messages=[]，
 * 界面停在 WelcomePage（不是 ChatPanel）——ChatPanel 只在
 * messages.length>0 || isStreaming || activeWorkspaceId 时才挂载。
 * 测试若要命中 ChatPanel 内的 InputBar / 工具卡 / 消息流等断言目标，
 * 必须先建会话再塞至少一条消息，把 WelcomePage 挤掉。
 *
 * 用法：await page.addInitScript(...) + page.goto('/') 之后调用本函数。
 */
export interface BootstrapChatMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  timestamp?: number
  [key: string]: unknown
}

export interface BootstrapChatOptions {
  /** 角色名，默认 'learner' */
  role?: string
  /** 注入的初始消息（至少一条才能让 ChatPanel 挂载） */
  messages: BootstrapChatMessage[]
}

export async function bootstrapChat(page: Page, opts: BootstrapChatOptions): Promise<void> {
  const { role = 'learner', messages } = opts
  await page.evaluate(
    async ({ role, messages }) => {
      const store = (window as any).__chatStore
      await store.getState().newConversation(role)
      store.setState({ messages })
    },
    { role, messages }
  )
  await page.locator('textarea').waitFor({ timeout: 5000 })
}


/* ────────────────────────────────────────────────────────────────
 * 真 Electron 启动脚手架
 *
 * 两个 spec 各抄了一份「拼 Electron 可执行路径 + mkdtemp 隔离 home +
 * 写 config.json + launch + finally 清理」。共享的是隔离契约本身
 * （隔离 home、禁跟随、退出即删），差异（入口参数、额外环境变量）留成参数,
 * 别为了「统一」把 locale-builtins 特意注入的 OPENAI_* 抹平。
 * ──────────────────────────────────────────────────────────────── */
import { _electron as electron, type ElectronApplication } from 'playwright'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export interface IsolatedElectronOptions {
  /** 写进 <home>/.openpipal/config.json,与隔离所需的默认值浅合并 */
  config?: Record<string, unknown>
  /** 追加到 process.env 之上的环境变量 */
  env?: Record<string, string>
  /** electron.launch 的 args[0]；默认整个仓库目录 */
  entry?: string
}

export interface IsolatedElectron {
  app: ElectronApplication
  /** 隔离 home 根,测试可往里塞 fixture */
  home: string
  /** 关窗 + 删隔离目录 —— 放进 finally */
  dispose: () => Promise<void>
}

/** 在一次性隔离 home 里起一个真 Electron 实例。 */
export async function launchIsolatedElectron(
  options: IsolatedElectronOptions = {}
): Promise<IsolatedElectron> {
  const home = await mkdtemp(join(tmpdir(), 'openpipal-e2e-'))
  await mkdir(join(home, '.openpipal'), { recursive: true })
  await writeFile(
    join(home, '.openpipal', 'config.json'),
    JSON.stringify(
      { configVersion: 2, onboardingCompleted: true, appFollowingEnabled: false, ...options.config },
      null,
      2
    ),
    'utf8'
  )

  const app = await electron.launch({
    executablePath: electronExecutablePath(),
    args: [options.entry ?? process.cwd()],
    env: {
      ...process.env,
      HOME: home,
      OPENPIPAL_ISOLATED_HOME: home,
      OPENPIPAL_DISABLE_APP_TRACKING: '1',
      ...options.env
    }
  })

  return {
    app,
    home,
    dispose: async () => {
      await app.close().catch(() => undefined)
      await rm(home, { recursive: true, force: true })
    }
  }
}

/** 各平台的 Electron 可执行文件路径（electron 包 dist 目录内） */
export function electronExecutablePath(root = process.cwd()): string {
  const dist = join(root, 'node_modules', 'electron', 'dist')
  if (process.platform === 'darwin') return join(dist, 'Electron.app', 'Contents', 'MacOS', 'Electron')
  if (process.platform === 'win32') return join(dist, 'electron.exe')
  return join(dist, 'electron')
}
