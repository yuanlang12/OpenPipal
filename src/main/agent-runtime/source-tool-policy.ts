import type { ChatSource } from './contracts'

/**
 * Background scheduler turns have no interactive user or visible desktop.
 * Keep this deny-list at the Runtime boundary so both legacy and pi-core (and
 * any MCP tool with a colliding name) receive the same non-interactive surface.
 */
export const SCHEDULER_BLOCKED_TOOL_NAMES = [
  'capture_screenshot',
  'read_screen',
  'get_environment',
  'present_to_user',
  'ask_user',
  'questions_v2'
] as const

const schedulerBlockedTools = new Set<string>(SCHEDULER_BLOCKED_TOOL_NAMES)

export function isToolBlockedForChatSource(source: ChatSource, toolName: string): boolean {
  return source === 'scheduler' && (
    schedulerBlockedTools.has(toolName) ||
    toolName.startsWith('browser_')
  )
}

export function filterToolsForChatSource<TTool extends { name: string }>(
  source: ChatSource,
  tools: TTool[]
): TTool[] {
  if (source !== 'scheduler') return tools
  return tools.filter(tool => !isToolBlockedForChatSource(source, tool.name))
}
