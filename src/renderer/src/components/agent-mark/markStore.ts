import { useSyncExternalStore } from 'react'
import type { AccessoryId, MarkHue } from './accessories'
import type { MarkShape } from './geometry'

/**
 * 捏头像配置的渲染层缓存 —— 两种 Agent 共用一张表，键是 `${scope}:${id}`。
 *
 *   role:teacher                            内置角色
 *   agent:9f3c...-...                       用户自建 Agent（workspace uuid）
 *
 * 磁盘是真相，这里只负责两件事：
 *   1. 首次用到时懒加载一次（loadMark），避免每个头像各发一次 IPC；
 *   2. 捏完立刻写进来，所有头像同帧重画，不用等下次拉列表。
 * 查不到就返回 undefined，调用方回落到角色默认 / workspace 自己的 emoji。
 */

export type MarkScope = 'role' | 'agent'

export interface MarkOverride {
  accessory?: AccessoryId
  hue?: MarkHue
  /** 身体轮廓；不给 = 圆角方 */
  shape?: MarkShape
}

const overrides = new Map<string, MarkOverride>()
const requested = new Set<string>()
const listeners = new Set<() => void>()
let version = 0

const keyOf = (scope: MarkScope, id: string): string => `${scope}:${id}`
/** 同一轮里多次写入只通知一次：首屏几十个头像各自 loadMark 回来，不该每个都让全部头像重画一遍 */
let emitScheduled = false
const emit = (): void => {
  if (emitScheduled) return
  emitScheduled = true
  queueMicrotask(() => {
    emitScheduled = false
    version += 1
    listeners.forEach((fn) => fn())
  })
}

export function getMarkOverride(scope: MarkScope, id: string): MarkOverride | undefined {
  return overrides.get(keyOf(scope, id))
}

export function setMarkOverride(scope: MarkScope, id: string, config: MarkOverride): void {
  const key = keyOf(scope, id)
  overrides.set(key, config)
  requested.add(key)
  emit()
}

/** 懒加载：同一个 key 只发一次 IPC，失败或没有文件都记成"问过了"。 */
export async function loadMark(scope: MarkScope, id: string): Promise<void> {
  const key = keyOf(scope, id)
  if (requested.has(key)) return
  requested.add(key)
  try {
    const config = await window.api?.getMark?.(scope, id)
    if (config) {
      overrides.set(key, config as MarkOverride)
      emit()
    }
  } catch { /* 没配过就是没配过，回落默认即可 */ }
}

const subscribe = (fn: () => void): (() => void) => {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

/** 订阅这张表；返回值只用于触发重渲染，不要读它的内容。 */
export function useMarkOverrides(): number {
  return useSyncExternalStore(subscribe, () => version, () => version)
}
