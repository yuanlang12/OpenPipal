/**
 * 用户数据根目录 —— 全应用唯一的拼接点。
 *
 * 改名前，数据目录名硬编码在 42 个文件的 91 个位置：改一次名要改 91 处，
 * 漏一处就是一个"数据莫名其妙不见了"的 bug。这里收成一个常量 + 两个函数。
 *
 * 用 `homedir()` 而不是 `app.getPath('home')`：前者在非 Electron 上下文（脚本、单测、
 * QA 驱动）里同样能用；显式 QA 隔离则由 `OPENPIPAL_ISOLATED_HOME` 统一覆盖。
 */
import { homedir } from 'os'
import { isAbsolute, join, resolve } from 'path'

/** 数据目录名。改产品名时只改这一处。 */
export const DATA_DIR_NAME = '.openpipal'

/**
 * QA 真机验收可以通过项目专属变量切到独立目录，不需要改写进程 HOME。
 * 正常启动未设置该变量时，行为与历史版本完全一致。
 */
export function getOpenPipalHome(): string {
  const isolatedHome = process.env.OPENPIPAL_ISOLATED_HOME?.trim()
  if (!isolatedHome) return homedir()
  if (!isAbsolute(isolatedHome)) {
    throw new Error('OPENPIPAL_ISOLATED_HOME must be an absolute path')
  }
  return resolve(isolatedHome)
}

/** `~/.openpipal` */
export function getDataRoot(): string {
  return join(getOpenPipalHome(), DATA_DIR_NAME)
}

/** `~/.openpipal/<...segments>` */
export function dataPath(...segments: string[]): string {
  return join(getDataRoot(), ...segments)
}

/** 会话 id 的形状（UUID）。outputs/ 下只有这种名字的子目录算"某个会话的产物目录"，别的子目录是历史上手写进去的 bundle */
export const CONVERSATION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isConversationOutputsDirName(name: string): boolean {
  return CONVERSATION_ID_RE.test(name)
}

/**
 * 模型产物按会话分目录：`~/.openpipal/outputs/<conversationId>/`（2026-09-12 起）。
 * export_artifact / generate_document 的文件、render_artifact 的截图都落这里；安全层据此放行"自己的目录"、
 * 拦"根与别的会话的目录"，不用再对 outputs 单开一条特判。
 * 没有会话 id（定时任务面、旧调用）或 id 不是合法路径段时退回共享根，行为同以前。
 * 用户自己点导出按钮产的文件仍落根——那是用户的动作，不是某个会话的产物。
 */
export function outputsDirFor(conversationId?: string | null): string {
  const id = typeof conversationId === 'string' ? conversationId.trim() : ''
  const safeSegment = !!id && /^[\w.-]+$/.test(id) && id !== '.' && id !== '..'
  return safeSegment ? dataPath('outputs', id) : dataPath('outputs')
}
