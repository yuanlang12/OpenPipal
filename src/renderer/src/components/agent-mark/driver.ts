/**
 * 全局唯一的一条 rAF —— 不是每个头像一条。
 *
 * 四道省法都在这里，且都不减效果、只是不做无用功：
 *   1. 静态实例根本不注册（sample 是纯函数，一帧就够）；
 *   2. 窗口不可见（document.hidden）整条循环停；
 *   3. 滚出视口的实例由调用方退订（IntersectionObserver 在组件里）；
 *   4. 一个订阅者都没有时循环自己停，有人订阅再启动。
 */

export type Tick = (t: number) => void

const subscribers = new Set<Tick>()
let raf = 0
let origin = 0

function loop(now: number): void {
  raf = requestAnimationFrame(loop)
  if (document.hidden) return
  const t = (now - origin) / 1000
  subscribers.forEach((fn) => fn(t))
}

function start(): void {
  if (raf) return
  origin = performance.now()
  raf = requestAnimationFrame(loop)
}

function stop(): void {
  if (!raf) return
  cancelAnimationFrame(raf)
  raf = 0
}

export function subscribe(fn: Tick): () => void {
  subscribers.add(fn)
  start()
  return () => {
    subscribers.delete(fn)
    if (subscribers.size === 0) stop()
  }
}

/** 当前时间轴上的秒数 —— 组件切状态时用它记 since，和 sample 收到的 t 同一基准。 */
export const now = (): number => (raf ? (performance.now() - origin) / 1000 : 0)

/** 用户明确要求减少动效时，整套退化成一张静止帧。 */
export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined') return false
  if (document.documentElement.dataset.swReducedMotion === 'always') return true
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
}
