import {
  blendProfile, circleProfile, clamp, easeOutCubic, easeOutQuint, lerp,
  profilePath, roundedSquareProfile, type Eye,
} from './geometry'
import { blendExpression, EXPRESSIONS, type ExpressionId } from './expressions'
import { RING_SHRINK } from './rings'

/**
 * sample(t, mark) 是**时间的纯函数** —— 没有内部状态、不读 Date.now()。
 * 三个直接好处：
 *   1. 列表里的后台 Agent 只画一帧、不挂 rAF（实测省掉 40 个头像 1.5ms/帧）；
 *   2. 冻结任意时刻都能复现，截图和单测不用和动画赛跑；
 *   3. 暂停/继续/跳到某一刻永远给出同一张图。
 * 所以这里任何"缓存上一帧"的优化都不许进来 —— 那会让它不再可重放。
 */

export type MarkState =
  | 'idle' | 'doze' | 'thinking' | 'generating' | 'done' | 'error' | 'alert' | 'cancel'

/** 常驻态只有三个，其余都是"闪一下就回中性"——不这么定界面会一直在做表情，很吵。 */
export const RESIDENT_STATES: MarkState[] = ['idle', 'doze', 'thinking', 'generating', 'alert']

/** 瞬时情绪的自动回落时长（秒）。常驻态没有这一项。 */
export const TRANSIENT_HOLD: Partial<Record<MarkState, number>> = {
  done: 1.2,
  error: 1.6,
  cancel: 1.2,
}

export const STATE_EXPRESSION: Record<MarkState, ExpressionId> = {
  idle: 'neutral',
  doze: 'sleepy',
  thinking: 'thinking',
  generating: 'focused',
  done: 'happy',
  error: 'angry',
  alert: 'surprised',
  cancel: 'sad',
}

/** 状态机的可读快照 —— 组件持有它，engine 只读。 */
export interface MarkClock {
  state: MarkState
  prevState: MarkState
  /** 显式指定表情（捏头像预览用）；不给就按 state 映射 */
  expression: ExpressionId | null
  prevExpression: ExpressionId | null
  /** 上次切态的时刻，单位秒，和传给 sample 的 t 同一个基准 */
  since: number
}

export interface MarkFrame {
  t: number
  body: string
  scaleX: number
  scaleY: number
  scale: number
  rotate: number
  eyeSquash: number
  eyeShift: number
  eyeAlpha: number
  propAlpha: number
  ringAlpha: number
  dots: { x: number; radius: number; alpha: number; hot: number }[]
  l: Eye
  r: Eye
}

const TAU = Math.PI * 2
const SQUARE = roundedSquareProfile()
export const BODY_NEUTRAL = profilePath(SQUARE)
const DOT_RADIUS = 7.5
const DOT_X = 19
const MORPH = 0.24

/** 思考态三点的行波：每颗点错开 0.17s，看起来像从左扫到右。 */
const dotBump = (t: number, index: number): number => {
  const q = ((((t - index * 0.17) / 0.85) % 1) + 1) % 1
  return q < 0.5 ? clamp((0.5 - 0.5 * Math.cos(q * TAU)) * 2) : 0
}

export function sample(t: number, clock: MarkClock): MarkFrame {
  const to = clock.expression ?? STATE_EXPRESSION[clock.state]
  const from = clock.prevExpression ?? STATE_EXPRESSION[clock.prevState]
  const k = easeOutQuint(clamp((t - clock.since) / MORPH))
  const eyes = blendExpression(from, to, k)

  const f: MarkFrame = {
    t, body: BODY_NEUTRAL, scaleX: 1, scaleY: 1, scale: 1, rotate: 0,
    eyeSquash: 1, eyeShift: 0, eyeAlpha: 1, propAlpha: 1, ringAlpha: 0,
    dots: [], l: eyes.l, r: eyes.r,
  }

  switch (clock.state) {
    case 'idle':
    case 'doze': {
      f.scaleY = 1 + Math.sin((t / 2.2) * TAU) * 0.014
      f.scaleX = 1 - Math.sin((t / 2.2) * TAU) * 0.01
      if (clock.state === 'idle') {
        // 5.4s 一次、170ms 完成的眨眼：闭得快、睁得慢，才不像机械开关
        const ph = (t % 5.4) / 0.17
        if (ph <= 1) f.eyeSquash = ph < 0.45 ? 1 - (ph / 0.45) * 0.94 : 0.06 + ((ph - 0.45) / 0.55) * 0.94
      }
      break
    }
    case 'thinking': {
      const p = ((t - clock.since) % 2.8) / 2.8
      const raw = p < 0.18 ? p / 0.18 : p < 0.82 ? 1 : 1 - (p - 0.82) / 0.18
      const m = easeOutCubic(raw)
      f.eyeAlpha = clamp(1 - m * 2.6)
      f.propAlpha = clamp(1 - m * 1.8)
      const mid = dotBump(t, 1)
      // 身体**变成**中间那颗点，morph 全程连续；两侧点从腰上长出来
      f.body = m > 0.001 ? profilePath(blendProfile(SQUARE, circleProfile(DOT_RADIUS * (1 + 0.22 * mid)), m)) : BODY_NEUTRAL
      if (m > 0.05) {
        f.dots = [-1, 1].map((s) => {
          const hot = dotBump(t, s < 0 ? 0 : 2)
          return { x: DOT_X * s * m, radius: DOT_RADIUS * (1 + 0.22 * hot), alpha: m * (0.55 + 0.45 * hot), hot }
        })
      }
      break
    }
    case 'generating': {
      const p = (t % 0.9) / 0.9
      f.scaleY = 1 - Math.sin(p * TAU) * 0.055
      f.scaleX = 1 + Math.sin(p * TAU) * 0.045
      f.eyeShift = Math.sin(p * TAU) * 3.2
      const e = easeOutQuint(clamp((t - clock.since) / 0.45))
      f.ringAlpha = e
      f.scale = lerp(1, RING_SHRINK, e)   // 缩一档给彩环让位，布局盒不变
      break
    }
    case 'done': {
      const e = Math.sin(clamp((t - clock.since) / 0.5) * Math.PI)
      f.scaleY = 1 + e * 0.1
      f.scaleX = 1 - e * 0.07
      break
    }
    case 'error': {
      const p = t - clock.since
      f.rotate = p < 0.6 ? Math.sin((p / 0.6) * TAU * 2) * 5 : 0
      break
    }
    default:
      break
  }
  return f
}

/** 静止帧：捏头像的小格子、列表里的后台 Agent 用这个，不挂 rAF。 */
export function staticFrame(expression: ExpressionId = 'neutral'): MarkFrame {
  return sample(0, {
    state: 'idle', prevState: 'idle', expression, prevExpression: expression, since: -999,
  })
}

export { EXPRESSIONS }
