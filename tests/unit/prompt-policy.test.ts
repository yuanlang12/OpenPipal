import { describe, expect, it } from 'vitest'
import fs from 'fs'
import path from 'path'
import { GENERAL_SYSTEM_PROMPT } from '../../src/main/role-manager'
import { TOOL_RULES } from '../../src/main/app-config'
import { SKILL_USAGE_NUDGE } from '../../src/main/skill-manager'
import { buildModelPromptAdapterSection } from '../../src/main/model-prompt-adapter'

describe('OpenPipal 通用提示词', () => {
  it('保持跨任务通用，不把近期作业场景写进全局人格', () => {
    expect(GENERAL_SYSTEM_PROMPT).toContain('选择足够可靠且最简单的完成方式')
    expect(GENERAL_SYSTEM_PROMPT).toContain('不增加对结果没有实际帮助的步骤')
    expect(GENERAL_SYSTEM_PROMPT).toContain('可选条件不能扩大成强制步骤')
    expect(GENERAL_SYSTEM_PROMPT).not.toMatch(/OCR|转录|批改|代码/)
  })

  it('获得足够信息后直接完成，只在结果会被显著改变时确认', () => {
    expect(GENERAL_SYSTEM_PROMPT).toContain('获得足够信息后直接完成')
    expect(GENERAL_SYSTEM_PROMPT).toContain('不同理解会显著改变结果')
    expect(GENERAL_SYSTEM_PROMPT).toContain('优先交付可直接使用的结果')
  })
})

describe('通用工具与技能规则', () => {
  it('允许按依赖关系顺序或并行，不再强制每轮一个工具或优先写代码', () => {
    expect(TOOL_RULES).toContain('所必需的最少工具')
    expect(TOOL_RULES).toContain('有依赖的操作按顺序执行')
    expect(TOOL_RULES).toContain('相互独立的操作可在支持时一起执行')
    expect(TOOL_RULES).not.toContain('每轮只调用一个工具')
    expect(TOOL_RULES).not.toContain('优先写代码')
  })

  it('技能只在用户指定或明确匹配时加载，并保留可选条件', () => {
    expect(SKILL_USAGE_NUDGE).toContain('用户明确指定技能')
    expect(SKILL_USAGE_NUDGE).toContain('description 明确匹配')
    expect(SKILL_USAGE_NUDGE).toContain('不扩大为强制步骤')
    expect(SKILL_USAGE_NUDGE).not.toContain('技能正文未读 =')
  })
})

describe('模型提示词适配层', () => {
  it('默认零注入，Qwen 不因模型名自动得到行为补丁', () => {
    expect(buildModelPromptAdapterSection()).toBe('')
    expect(buildModelPromptAdapterSection({})).toBe('')
  })

  it('只注入精确 preset 显式配置的稳定小补丁', () => {
    expect(buildModelPromptAdapterSection({
      systemPromptAdapter: '  对简单任务直接给出结果。  '
    })).toBe('\n\n## 当前模型适配\n对简单任务直接给出结果。')
  })

  it('主对话用会话解析后的模型配置构建最终系统提示词', () => {
    const source = fs.readFileSync(path.resolve('src/main/pi-agent-service.ts'), 'utf8')
    // 拆开包装拿技能段原文后，策略断言跟着落到 prepare 调用上（stablePrefix + 会话解析的 mc 不变）
    expect(source).toContain(
      'prepareOpenPipalSystemPrompt(source, overrides, { stablePrefix: true, modelConfig: mc })'
    )
    // 与旧包装逐字节一致：render 的入参仍是技能段，产出直接作为系统提示词
    expect(source).toContain('const systemPrompt = preparedPrompt.render(skillSection)')
  })
})
