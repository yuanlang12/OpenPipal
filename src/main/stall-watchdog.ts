/**
 * 静默看门狗 —— "等模型说话"期间的停摆兜底。
 *
 * 背景（2026-07-29 实案）：模型服务额度/限流窗口用尽时，网关常常既不返错也不断流，
 * 只是把连接挂着。对话路径没有请求超时，agent 就永远 await 一个不回的请求，
 * UI 停在"深度思考"——用户看到的是应用卡死，而不是"服务商没额度了"。
 *
 * 语义（三条，单测锁）：
 *  1. arm() 续命：每次收到模型事件重新计时，长回答/长推理不会被误杀
 *  2. disarm() 撤弦：工具执行期间不计时——bash/render_artifact/subagent 本就可能几分钟，
 *     权限气泡能等 30 分钟，那段静默是正常的
 *  3. 触发后上锁：fired 之后 arm() 不再续命，避免"已判定停摆"又被迟到事件复活
 */
export interface StallWatchdog {
  /** 重新计时（收到模型事件时调）。timeoutMs <= 0 或已触发 → 空操作 */
  arm(): void
  /** 停止计时（工具开跑 / 本轮结束时调） */
  disarm(): void
  /** 是否已判定停摆 */
  readonly fired: boolean
}

/**
 * Product default for an entirely silent model request. A first model event
 * (including a thinking delta) renews the watchdog, while tool execution
 * disarms it. Keep the parsing here so legacy and pi-core cannot silently
 * drift to different default behavior.
 *
 * 取值对齐 pi 自己的编码 agent：`pi-coding-agent/core/http-dispatcher.js` 的
 * DEFAULT_HTTP_IDLE_TIMEOUT_MS = 300_000（可选 30s / 1min / 2min / 5min / 关闭），
 * 作为 undici 的 bodyTimeout + headersTimeout 装在全局 dispatcher 上。
 *
 * 原值 60s 偏紧，而且我们这层比 pi 那层更容易误杀——两处口径不同：
 *  · pi 数的是**字节**（socket 层）：SSE 心跳、任何一个 chunk 都续命
 *  · 我们数的是**已解析的模型事件**：长上下文的预填充阶段（首 token 前）一个事件都没有，
 *    大 context + 推理模型很容易超过 60s，连接其实活得好好的
 * 所以在换成字节级口径之前，至少不该比 pi 的 5 分钟更激进。
 * 真正"网关挂着连接不返错"的场景 5 分钟照样兜得住——那是无限期挂起，不是慢。
 */
export const DEFAULT_MODEL_STALL_TIMEOUT_MS = 300_000

export function resolveModelStallTimeoutMs(raw: unknown): number {
  const configured = Number(raw)
  if (Number.isFinite(configured)) return configured > 0 ? configured : 0
  return DEFAULT_MODEL_STALL_TIMEOUT_MS
}

export function createStallWatchdog(timeoutMs: number, onStall: () => void): StallWatchdog {
  let timer: ReturnType<typeof setTimeout> | null = null
  let fired = false

  const disarm = (): void => {
    if (timer) { clearTimeout(timer); timer = null }
  }

  return {
    arm(): void {
      if (fired || timeoutMs <= 0) return
      disarm()
      timer = setTimeout(() => {
        timer = null
        fired = true
        onStall()
      }, timeoutMs)
    },
    disarm,
    get fired(): boolean {
      return fired
    }
  }
}
