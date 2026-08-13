import type { TFunction } from 'i18next'

/**
 * Stable UI keys for protocol tool names. The protocol names stay untouched;
 * only their renderer-facing label and progress phrase are localized.
 */
export const TOOL_PHRASES: Record<string, { labelKey: string; ongoingKey: string }> = {
  save_memory: { labelKey: 'chat.tools.saveMemory.label', ongoingKey: 'chat.tools.saveMemory.ongoing' },
  recall_memory: { labelKey: 'chat.tools.recallMemory.label', ongoingKey: 'chat.tools.recallMemory.ongoing' },
  web_search: { labelKey: 'chat.tools.webSearch.label', ongoingKey: 'chat.tools.webSearch.ongoing' },
  capture_screenshot: { labelKey: 'chat.tools.captureScreenshot.label', ongoingKey: 'chat.tools.captureScreenshot.ongoing' },
  read_screen: { labelKey: 'chat.tools.readScreen.label', ongoingKey: 'chat.tools.readScreen.ongoing' },
  read_page_content: { labelKey: 'chat.tools.readPageContent.label', ongoingKey: 'chat.tools.readPageContent.ongoing' },
  generate_document: { labelKey: 'chat.tools.generateDocument.label', ongoingKey: 'chat.tools.generateDocument.ongoing' },
  ask_user: { labelKey: 'chat.tools.askUser.label', ongoingKey: 'chat.tools.askUser.ongoing' },
  questions_v2: { labelKey: 'chat.tools.questionsV2.label', ongoingKey: 'chat.tools.questionsV2.ongoing' },
  load_skill: { labelKey: 'chat.tools.loadSkill.label', ongoingKey: 'chat.tools.loadSkill.ongoing' },
  mcp_execute: { labelKey: 'chat.tools.mcpExecute.label', ongoingKey: 'chat.tools.mcpExecute.ongoing' },
  create_artifact: { labelKey: 'chat.tools.createArtifact.label', ongoingKey: 'chat.tools.createArtifact.ongoing' },
  create_visualizer: { labelKey: 'chat.tools.createVisualizer.label', ongoingKey: 'chat.tools.createVisualizer.ongoing' },
  execute_code: { labelKey: 'chat.tools.executeCode.label', ongoingKey: 'chat.tools.executeCode.ongoing' },
  bash: { labelKey: 'chat.tools.bash.label', ongoingKey: 'chat.tools.bash.ongoing' },
  read: { labelKey: 'chat.tools.read.label', ongoingKey: 'chat.tools.read.ongoing' },
  write: { labelKey: 'chat.tools.write.label', ongoingKey: 'chat.tools.write.ongoing' },
  edit: { labelKey: 'chat.tools.edit.label', ongoingKey: 'chat.tools.edit.ongoing' },
  ls: { labelKey: 'chat.tools.listFiles.label', ongoingKey: 'chat.tools.listFiles.ongoing' },
  find: { labelKey: 'chat.tools.findFiles.label', ongoingKey: 'chat.tools.findFiles.ongoing' },
  grep: { labelKey: 'chat.tools.searchFiles.label', ongoingKey: 'chat.tools.searchFiles.ongoing' },
  execute_command: { labelKey: 'chat.tools.bash.label', ongoingKey: 'chat.tools.bash.ongoing' },
  write_file: { labelKey: 'chat.tools.write.label', ongoingKey: 'chat.tools.write.ongoing' },
}

const PROPER_NOUNS: Record<string, string> = { classin: 'ClassIn' }

export function formatUnknownToolName(name: string): string {
  return name
    .split(/[_-]/)
    .filter(Boolean)
    .map((part) => PROPER_NOUNS[part.toLowerCase()] ?? part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

export function toolLabelKey(name: string): string | undefined {
  return TOOL_PHRASES[name]?.labelKey
}

export function toolOngoingKey(name: string): string | undefined {
  return TOOL_PHRASES[name]?.ongoingKey
}

export function toolLabel(name: string, t: TFunction): string {
  const key = toolLabelKey(name)
  return key ? t(key) : formatUnknownToolName(name)
}

export function toolOngoing(name: string, t: TFunction): string {
  const key = toolOngoingKey(name)
  return key
    ? t(key)
    : t('chat.tools.unknownOngoing', { label: formatUnknownToolName(name) })
}
