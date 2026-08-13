/**
 * 文件路径 → 面向用户的说法。
 *
 * 老师看到的不该是"读取文件: 01-硬约束.md ~/.openpipal/workspace/a…"——
 * 序号前缀、扩展名、绝对路径都是实现细节。这里把长期档案类路径翻译成
 * "教学风格 · 小学语文 · 硬约束"，其余路径返回 null 走原来的通用文件行。
 * 纯函数，单测锁行为。
 */

import type { TFunction } from 'i18next'

export interface FileDisplayLabel {
  /** 去序号与扩展名后的原始显示值；未知名称始终原样展示 */
  raw: string
  /** 仅已知 OpenPipal 别名拥有稳定 key；实际文案在渲染时由当前 locale 解析 */
  translationKey?: string
}

export interface FileDisplayInfo {
  /** role-system = 角色长期档案（教师的教学风格）；memory = 反馈记忆 */
  scope: 'role-system' | 'memory'
  /** 原始教学风格名；memory 没有用户命名的分组，保持空串 */
  groupName: string
  /** 文档名稳定描述符（去掉序号前缀与扩展名）；不在数据层冻结翻译 */
  docName: FileDisplayLabel
  /** 聚合键：同一档案文件夹的多次读取合成一行 */
  groupKey: string
}

const ASSETS_SEG = '/workspace/assets/'
const MEMORY_SEG = '/.openpipal/memory/'

/** 权威主文件是档案入口而不是某类内容，旧 SKILL.md 只保留兼容说法 */
const DOC_ALIAS_KEYS: Record<string, string> = {
  风格: 'chat.fileDisplay.aliases.styleOverview',
  SKILL: 'chat.fileDisplay.aliases.archiveOverview',
  README: 'chat.fileDisplay.aliases.description',
}

export function prettyDocName(base: string): FileDisplayLabel {
  const noExt = base.replace(/\.[a-z0-9]{1,8}$/i, '')
  // "01-硬约束" → "硬约束"：序号是给文件系统排序用的，不是给人看的
  const noSeq = noExt.replace(/^\d{1,2}[-_.\s]+/, '')
  const raw = noSeq || base
  const translationKey = DOC_ALIAS_KEYS[raw]
  return translationKey ? { raw, translationKey } : { raw }
}

export function resolveFileDisplayLabel(label: FileDisplayLabel, t: TFunction): string {
  return label.translationKey ? t(label.translationKey) : label.raw
}

export function describeFilePath(path: string | null | undefined): FileDisplayInfo | null {
  if (!path) return null

  const ai = path.indexOf(ASSETS_SEG)
  if (ai >= 0) {
    // assets/<role>/<系统名>/<文件…>——散落在 assets/<role>/ 根下的素材文件不算档案
    const rest = path.slice(ai + ASSETS_SEG.length).split('/').filter(Boolean)
    if (rest.length < 3) return null
    return {
      scope: 'role-system',
      groupName: rest[1],
      docName: prettyDocName(rest[rest.length - 1]),
      groupKey: path.slice(0, ai) + ASSETS_SEG + rest[0] + '/' + rest[1]
    }
  }

  const mi = path.indexOf(MEMORY_SEG)
  if (mi >= 0) {
    const base = path.slice(mi + MEMORY_SEG.length)
    if (!base || base.includes('/')) return null
    return {
      scope: 'memory',
      groupName: '',
      docName: prettyDocName(base.replace(/^feedback[_-]/i, '')),
      groupKey: path.slice(0, mi) + MEMORY_SEG
    }
  }

  return null
}
