/**
 * set_rule：前台助手只递交"以后都要这样"的要求，写规则文件的活在后台
 * （hooks/rule-writer → Evolver set-rule）。工具立刻返回，主线任务不停；
 * 写好后主进程把结论送到渲染层，落成一枚胶囊。
 *
 * 单独成文件、不引 electron：产品工具模块在 node 测试里 import 不了，这个能。
 * 三处登记：openpipal-product-tools（定义）/ role-manager COMMON_TOOLS / pi-security classifyToolRisk。
 */
import { Type } from 'typebox'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { requestRule, type RuleRequest } from './rule-writer'

export interface SetRuleToolOptions {
  conversationId?: string
  roleName?: string
  /** 独立智能体（我的 Agents）里调的：规则默认只对它生效 */
  workspaceId?: string
}

export interface SetRuleToolDeps {
  requestRule: (request: RuleRequest) => Promise<unknown>
}

export function createSetRuleTool(options: SetRuleToolOptions, deps: SetRuleToolDeps = { requestRule }): AgentTool {
  return {
    name: 'set_rule',
    label: '定规则',
    description: `用户提出**以后长期生效**、且关于**你怎么用工具**的要求时调用："以后读成绩表先遮名字""别再跑 rm -rf""每次改完代码就跑测试""每轮开工先提醒我…"。你只递交要求，写规则文件由后台完成，写好后 App 会直接提醒用户；调完立刻继续手头的任务。不要自己写规则文件，不要说"已生效"。一次性的要求（"这次…"）不要调；教做事方法的写技能（skill-creator）。`,
    parameters: Type.Object({
      description: Type.String({ description: '一句大白话，照用户原话写，用户会看到这句（40 字以内）' }),
      details: Type.String({ description: '给后台写规则的人看：什么时候触发（哪个工具、什么条件、涉及的路径/命令/关键词）、要做什么（改参数 / 拦下 / 改结果 / 每轮加什么提示）' })
    }),
    execute: async (_id, params) => {
      const p = (params ?? {}) as { description?: unknown; details?: unknown }
      const description = String(p.description ?? '').trim()
      const details = String(p.details ?? '').trim()
      if (!description) {
        return { content: [{ type: 'text', text: 'error: description 为空——用一句大白话说清这条规则' }], details: {} }
      }
      // 不等：后台写多久与主线无关，结论走 rule-writer 的 sink 直达渲染层
      void deps.requestRule({
        description,
        details: details || description,
        conversationId: options.conversationId,
        roleName: options.roleName,
        workspaceId: options.workspaceId
      }).catch(() => undefined)
      return {
        content: [{ type: 'text', text: `已交给后台写规则「${description}」，写好后会直接提醒用户。继续当前任务；不要再自己写规则文件，也不要说规则已生效。` }],
        details: {}
      }
    }
  }
}
