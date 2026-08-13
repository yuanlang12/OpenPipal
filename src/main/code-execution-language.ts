export type SupportedCodeExecutionLanguage = 'python' | 'javascript' | 'bash'

export interface CodeExecutionLanguageSpec {
  language: SupportedCodeExecutionLanguage
  extension: 'py' | 'js' | 'sh'
  runner: 'python3' | 'node' | 'bash'
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

export function resolveCodeExecutionLanguage(value: unknown): CodeExecutionLanguageSpec | null {
  const language = normalizeCodeExecutionLanguage(value)
  if (!language) return null
  if (language === 'python') return { language, extension: 'py', runner: 'python3' }
  if (language === 'javascript') return { language, extension: 'js', runner: 'node' }
  return { language, extension: 'sh', runner: 'bash' }
}
