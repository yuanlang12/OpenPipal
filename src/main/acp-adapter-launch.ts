/**
 * 适配器怎么启动——随包分发之后的那条命令。
 *
 * 编辑器接 ACP 要的是一条能直接 spawn 的命令。此前用户得先自己装 Node、再
 * `npm i -g openpipal-acp`，装不上就只能放弃。现在适配器（tsup 打好的单文件，
 * ACP SDK 已内联，只依赖 Node 内置模块）跟着 App 一起装进来，用 App 自带的
 * Electron 当 Node 跑：`ELECTRON_RUN_AS_NODE=1`，零前置。
 *
 * 文件不在就返回 null——**宁可说"这个版本没带适配器"，也不给一条跑不通的命令**。
 */

import { existsSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'

export interface AcpAdapterLaunch {
  /** 拿来当 Node 用的可执行文件（打包态即 App 自己） */
  command: string
  args: string[]
  env: Record<string, string>
}

/**
 * 打包态读 `process.resourcesPath/acp`（见 electron-builder.yml 的 extraResources）；
 * 开发态直接指向仓库里的 `openpipal-acp/dist`——两边都得先 build 过适配器。
 *
 * 打包态特意改名 `.mjs`：Resources 目录下没有 package.json，`.js` 会被 Node 当成
 * CommonJS，第一行 import 就语法报错。开发态那份沿用 `.js` 没问题——
 * `openpipal-acp/package.json` 里有 `"type": "module"`。
 */
export function resolveAcpAdapterLaunch(): AcpAdapterLaunch | null {
  const script = app.isPackaged
    ? join(process.resourcesPath, 'acp', 'openpipal-acp.mjs')
    : join(app.getAppPath(), 'openpipal-acp', 'dist', 'index.js')
  if (!existsSync(script)) return null
  return {
    command: process.execPath,
    args: [script],
    env: { ELECTRON_RUN_AS_NODE: '1' }
  }
}
