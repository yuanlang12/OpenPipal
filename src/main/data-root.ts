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
