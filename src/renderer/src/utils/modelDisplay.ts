/**
 * 内置模型/服务商的展示名本地化（红线：内置连接信息不可见亦不可改——
 * 主进程只产出中文哨兵值 '内置模型'/'内置服务'，翻译只能在渲染层按 builtin 位做，
 * 绝不能反过来暴露真实 name/model）。
 */

export type TranslateModelDisplay = (key: string, params?: Record<string, unknown>) => string

export interface ModelDisplayEntry {
  name: string
  builtin?: boolean
}

/** builtin 条目永远返回本地化占位符，绝不透出 entry.name/model 原始值。 */
export function displayModelEntryName(
  entry: ModelDisplayEntry,
  t: TranslateModelDisplay,
  key: string = 'chat.modelControl.builtinModel',
): string {
  return entry.builtin ? t(key) : entry.name
}

/** 服务商分组标题：按组内任一模型的 builtin 位判定（分组本身不携带该位）。 */
export function displayModelGroupLabel(
  group: string,
  groupIsBuiltin: boolean | undefined,
  t: TranslateModelDisplay,
): string {
  if (groupIsBuiltin) return t('chat.modelControl.builtinService')
  return group || t('chat.modelControl.ungrouped')
}
