import { config } from 'dotenv'
import { join } from 'path'
import { app } from 'electron'
import { getDevelopmentEnvPath } from './credential-paths'

// stdout/stderr 免疫:打包 app 被终端管道方式启动、对端提前关闭时,console.log 会抛
// EPIPE 变成主进程未捕获异常弹窗。日志通道坏了只该静默丢弃,不该崩 app。
// 放在首个被 import 的模块顶部,保证先于一切 console 输出生效。
for (const stream of [process.stdout, process.stderr]) {
  stream?.on?.('error', () => {})
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
