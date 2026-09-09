import { config } from 'dotenv'
import { existsSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import { getDevelopmentEnvPath } from './credential-paths'

// stdout/stderr 免疫:打包 app 被终端管道方式启动、对端提前关闭时,console.log 会抛
// EPIPE 变成主进程未捕获异常弹窗。日志通道坏了只该静默丢弃,不该崩 app。
// 放在首个被 import 的模块顶部,保证先于一切 console 输出生效。
for (const stream of [process.stdout, process.stderr]) {
  stream?.on?.('error', () => {})
}

// esbuild 同步 API（artifact-store / ds-compile / hooks 的 transformSync）默认 new Worker 自举、
// 在 worker 线程里 spawn 平台二进制。Electron 的 asar 改写只装在主线程：worker 线程里 spawn
// app.asar/…/bin/esbuild 报 `spawn ENOTDIR`，dev 下 node_modules 是真实目录、永不复现
// （2026-09-08 装机版 1.1.2 实撞：规则全部"编译失败"，jsx 产物预编译同样中招）。
// 修法：装机版把二进制路径直接指到 app.asar.unpacked 里的真实文件——worker 常驻，每次编译约 1.5ms。
// 找不到那个文件才退回关 worker 线程：主线程 execFileSync 有 asar 改写、一定能跑，但每次编译都
// spawn 一个进程（约 17ms），设计稿几十个模块串行编译会卡住主线程。esbuild 在模块加载时读这两个
// 变量，必须先于任何 require('esbuild')——本模块是入口第二个 import。
// 装机版验法只有一种：scripts/qa/packaged-esbuild-probe.mjs 在 App 自己的主进程里跑真编译。
if (app.isPackaged && !process.env.ESBUILD_BINARY_PATH && !process.env.ESBUILD_WORKER_THREADS) {
  const binary = join(
    process.resourcesPath, 'app.asar.unpacked', 'node_modules', '@esbuild', `${process.platform}-${process.arch}`,
    ...(process.platform === 'win32' ? ['esbuild.exe'] : ['bin', 'esbuild'])
  )
  if (existsSync(binary)) process.env.ESBUILD_BINARY_PATH = binary
  else process.env.ESBUILD_WORKER_THREADS = '0'
}

// 在打包后从 app 目录加载，开发时从项目根加载
const envPath = app.isPackaged
  ? join(process.resourcesPath, '.env')
  : getDevelopmentEnvPath()

config({ path: envPath })

export const ENV = {
  OPENAI_BASE_URL: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
  OPENAI_API_KEY: process.env.OPENAI_API_KEY || '',
  OPENAI_MODEL: process.env.OPENAI_MODEL || 'gpt-4o',
  TAVILY_API_KEY: process.env.TAVILY_API_KEY || '',
  REALTIME_API_URL: process.env.REALTIME_API_URL || 'https://api.302.ai/v1/realtime',
  REALTIME_API_KEY: process.env.REALTIME_API_KEY || '',
  REALTIME_MODEL: process.env.REALTIME_MODEL || 'gpt-4o-realtime-preview-2024-12-17',
  REALTIME_PROVIDER: process.env.REALTIME_PROVIDER || 'openai',
  REALTIME_API_VERSION: process.env.REALTIME_API_VERSION || '2025-04-01-preview',
  REALTIME_DEPLOYMENT: process.env.REALTIME_DEPLOYMENT || '',
  REALTIME_VOICE: process.env.REALTIME_VOICE || 'alloy'
}
