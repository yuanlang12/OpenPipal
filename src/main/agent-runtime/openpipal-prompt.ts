import type { ModelConfig } from '../config-manager'
import { buildSkillPromptSection } from '../skill-manager'
import type { AgentOverrides, ChatSource } from './contracts'
import {
  prepareOpenPipalSystemPrompt,
  buildOpenPipalRuntimeContext,
  resolveOpenPipalWorkingDirectory
} from './openpipal-prompt-core'

/** Legacy synchronous prompt wrapper retained for exact rollback parity. */
export function buildOpenPipalSystemPrompt(
  source: ChatSource,
  overrides?: AgentOverrides,
  options?: { stablePrefix?: boolean; modelConfig?: ModelConfig }
): string {
  const prepared = prepareOpenPipalSystemPrompt(source, overrides, options)
  return prepared.render(buildSkillPromptSection(prepared.skillContext))
}

export { buildOpenPipalRuntimeContext, resolveOpenPipalWorkingDirectory }
