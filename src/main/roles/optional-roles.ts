/**
 * 本发行版不含学习助手 / 教学助手 / 办公 / 同传四个内置角色。
 *
 * 发行裁剪脚本（scripts/make-open-source-cut.mjs）把本文件换成空实现，
 * role-manager 的组合处因此一行不用改。
 * 与 config/open-source-policy.json 里对应的规则。
 */
import type { RoleConfig } from '../role-manager'

export function buildOptionalRoles(_COMMON_TOOLS: string[]): Record<string, RoleConfig> {
  return {}
}
