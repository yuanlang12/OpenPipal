import type { ModelConfig } from './config-manager'

/**
 * 模型提示词补丁是共同提示词后的可选稳定层。
 *
 * 不在这里按模型名硬编码行为；补丁跟随精确 preset，只有评测证明参数/能力配置
 * 无法解决某个稳定问题时才填写。这样同名模型的不同网关不会互相污染。
 */
export function buildModelPromptAdapterSection(
  modelConfig?: Pick<ModelConfig, 'systemPromptAdapter'>
): string {
  const adapter = modelConfig?.systemPromptAdapter?.trim()
  if (!adapter) return ''
  return `\n\n## 当前模型适配\n${adapter}`
}
