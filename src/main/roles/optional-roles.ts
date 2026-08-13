/**
 * 本发行版只带默认 OpenPipal Agent。
 *
 * 私仓里这里是学习助手 / 教学助手 / 办公 / 设计 / 同传五个内置角色；它们依赖的
 * 设计运行时尚未完成自研替换，因此本次不随开源发行。发行裁剪脚本
 * （scripts/make-open-source-cut.mjs）把本文件换成空实现。
 */
import type { RoleConfig } from '../role-manager'

export function buildOptionalRoles(_COMMON_TOOLS: string[]): Record<string, RoleConfig> {
  return {}
}
