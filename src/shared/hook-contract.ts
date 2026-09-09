/**
 * 用户规则（插件 hooks/）的跨进程契约：主进程 → preload → 渲染层 / 会话存储 共用同一份形状。
 * 面向规则作者的类型（事件、HookAPI）住在 main/hooks/hook-types.ts，不在这里。
 */

/**
 * 规则来自哪：全局插件（对话里定的全局规则都在 local-rules）或某个独立智能体自己的 hooks/ 目录。
 * 位置即范围：插件里的对所有 Agent 生效，Agent 目录里的只对它生效、跟着它走。
 */
export interface HookSource {
  kind: 'plugin' | 'agent'
  /** 插件名 / 独立智能体 id */
  id: string
  /** 显示名：插件名 / 独立智能体名 */
  name: string
}

/**
 * 规则文件刚被写入/改动后，加载器给出的结论。
 * 对话流里的那行提醒、回给模型的反馈，都只从这里来——是加载器的事实，不是模型的宣称。
 */
export interface HookNotice {
  status: 'ok' | 'error'
  /** `<容器>/<文件名去后缀>`；容器是插件名或 `agent:<id>`（由 source 拼出，只有这一处编码） */
  hookId: string
  source: HookSource
  /** 绝对路径 */
  file: string
  description: string
  error?: string
}

/** 规则清单的一条：在生效的、加载失败的、被关掉的（文件 .off 或整个插件停用）都列 */
export interface HookEntry {
  id: string
  source: HookSource
  file: string
  description?: string
  status: 'ok' | 'error' | 'off'
  /** status 为 off 时：是这条规则自己关了（文件改名 .off），还是所在插件整个停用 */
  offReason?: 'file' | 'plugin'
  error?: string
  events: string[]
}

export type HookToggleResult = { ok: true; file: string } | { ok: false; error: string }

/** 对话里定下的全局规则都放在这个本地插件里；规则页把它显示成「所有 Agent」，插件页不把它当插件列 */
export const LOCAL_RULES_PLUGIN = 'local-rules'
