export type SupportedCodeExecutionLanguage = 'python' | 'javascript' | 'bash'

export interface CodeExecutionLanguageSpec {
  language: SupportedCodeExecutionLanguage
  extension: 'py' | 'js' | 'sh'
  runner: 'python3' | 'python' | 'node' | 'bash'
}

const SUPPORTED_LANGUAGES = new Set<SupportedCodeExecutionLanguage>([
  'python',
  'javascript',
  'bash'
])

/**
 * Keep authorization and execution on the same closed language set. Unknown
 * values must never be reinterpreted as shell code after the policy decision.
 */
export function normalizeCodeExecutionLanguage(
  value: unknown
): SupportedCodeExecutionLanguage | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim().toLowerCase() as SupportedCodeExecutionLanguage
  return SUPPORTED_LANGUAGES.has(normalized) ? normalized : null
}

export function resolveCodeExecutionLanguage(
  value: unknown,
  platform: NodeJS.Platform = process.platform
): CodeExecutionLanguageSpec | null {
  const language = normalizeCodeExecutionLanguage(value)
  if (!language) return null
  if (language === 'python') {
    // Windows 上 python.org 安装器与 py 启动器都不提供 `python3`，商店版的 python3.exe 只是个
    // 打开 Microsoft Store 的桩——那里真正存在的名字是 `python`。
    return { language, extension: 'py', runner: platform === 'win32' ? 'python' : 'python3' }
  }
  if (language === 'javascript') return { language, extension: 'js', runner: 'node' }
  return { language, extension: 'sh', runner: 'bash' }
}
