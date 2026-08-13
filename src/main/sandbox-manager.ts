/**
 * Sandbox Manager — OS 级沙箱隔离
 *
 * 使用 @anthropic-ai/sandbox-runtime (SRT) 在 macOS 上通过 Seatbelt (sandbox-exec)
 * 实现进程级别的文件系统和网络隔离。
 *
 * 设计原则：
 * - 初始化失败时 graceful fallback 到现有三层安全模型
 * - 不阻塞应用启动
 * - 配置可通过环境变量覆盖
 */

import type { SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime'
import { SENSITIVE_DIRS, ALLOWED_DIRS } from './pi-security'
import { getCredentialReadDenyPaths, SENSITIVE_READ_GLOBS } from './credential-paths'

// 延迟加载 ESM-only 模块，避免 Electron CJS 主进程的 require() 报错
let _SRT: any = null
async function getSRT() {
  if (!_SRT) {
    const mod = await import('@anthropic-ai/sandbox-runtime')
    _SRT = mod.SandboxManager
  }
  return _SRT
}

// =====================================================================
// 状态
// =====================================================================

let _initialized = false
let _enabled = false

// =====================================================================
// 配置
// =====================================================================

/** 从环境变量读取允许的网络域名 */
function getAllowedDomains(): string[] {
  const envDomains = process.env.OPENPIPAL_ALLOWED_DOMAINS
  if (envDomains) {
    return envDomains.split(',').map(d => d.trim()).filter(Boolean)
  }
  // 默认允许 AI API 域名
  return [
    'api.anthropic.com',
    'api.openai.com',
    'api.deepseek.com',
    'generativelanguage.googleapis.com',
    'api.tavily.com',
    // npm registry（工具可能需要查包信息）
    'registry.npmjs.org',
  ]
}

/** 构建沙箱运行时配置 */
export function buildSandboxConfig(): SandboxRuntimeConfig {
  return {
    filesystem: {
      denyRead: [...SENSITIVE_DIRS, ...SENSITIVE_READ_GLOBS],
      allowWrite: ['.', ...ALLOWED_DIRS],
      denyWrite: [
        '.env',
        '.git/hooks',
        ...getCredentialReadDenyPaths(),
        ...SENSITIVE_READ_GLOBS,
      ],
    },
    network: {
      allowedDomains: getAllowedDomains(),
      deniedDomains: [],
      allowLocalBinding: true, // 允许绑定本地端口（dev server 等）
    },
  }
}

// =====================================================================
// 敏感环境变量过滤
// =====================================================================

/** 需要从沙箱环境中移除的敏感环境变量 */
const SENSITIVE_ENV_KEYS = [
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'DEEPSEEK_API_KEY',
  'GOOGLE_API_KEY',
  'TAVILY_API_KEY',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'NPM_TOKEN',
  'CLASSIN_SID',
]

/** Filter sensitive credentials from an arbitrary environment patch. */
export function sanitizeEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...source }
  for (const key of SENSITIVE_ENV_KEYS) {
    delete env[key]
  }
  // 也移除所有包含 _KEY、_SECRET、_TOKEN 的变量（宽泛匹配）
  for (const key of Object.keys(env)) {
    if (/_(KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL)$/i.test(key)) {
      delete env[key]
    }
  }
  return env
}

/** 返回过滤后的进程环境变量（移除敏感 key） */
export function getSanitizedEnv(): NodeJS.ProcessEnv {
  return sanitizeEnvironment(process.env)
}

// =====================================================================
// 初始化
// =====================================================================

/**
 * 初始化沙箱。应在应用启动时调用一次。
 * 如果平台不支持或初始化失败，会 graceful fallback。
 */
export async function initSandbox(): Promise<boolean> {
  if (_initialized) return _enabled

  try {
    const SRT = await getSRT()

    // 检查平台支持
    if (!SRT.isSupportedPlatform()) {
      console.log('[Sandbox] 当前平台不支持沙箱，降级到应用层安全模型')
      _initialized = true
      _enabled = false
      return false
    }

    const config = buildSandboxConfig()
    await SRT.initialize(config)
    _initialized = true
    _enabled = SRT.isSandboxingEnabled()

    if (_enabled) {
      console.log('[Sandbox] 沙箱已启用（macOS Seatbelt）')
    } else {
      console.warn('[Sandbox] 沙箱初始化完成但未启用，降级到应用层安全模型')
    }

    return _enabled
  } catch (err: any) {
    console.error('[Sandbox] 初始化失败，降级到应用层安全模型:', err.message)
    _initialized = true
    _enabled = false
    return false
  }
}

// =====================================================================
// 命令包装
// =====================================================================

/**
 * 用沙箱包装 bash 命令。
 * 如果沙箱不可用，原样返回命令。
 */
export async function wrapCommand(command: string): Promise<string> {
  if (!_enabled) return command
  try {
    const SRT = await getSRT()
    return await SRT.wrapWithSandbox(command)
  } catch (err: any) {
    console.warn('[Sandbox] 命令包装失败，回退到原始命令:', err.message)
    return command
  }
}

/**
 * Wrap a command for a security boundary that has already auto-approved the
 * operation because sandboxing is active. Unlike the legacy helper above, a
 * wrapper failure must reject instead of silently executing the raw command.
 */
export async function wrapCommandStrict(command: string): Promise<string> {
  if (!_enabled) return command
  const SRT = await getSRT()
  return SRT.wrapWithSandbox(command)
}

// =====================================================================
// 查询接口
// =====================================================================

/** 沙箱是否已启用 */
export function isSandboxed(): boolean {
  return _enabled
}

/** 获取当前沙箱配置（调试用） */
export async function getSandboxConfig(): Promise<SandboxRuntimeConfig | undefined> {
  const SRT = await getSRT()
  return SRT.getConfig()
}

/** 清理沙箱资源 */
export async function resetSandbox(): Promise<void> {
  if (_enabled) {
    const SRT = await getSRT()
    await SRT.reset()
    _enabled = false
    _initialized = false
  }
}
