import { blendEye, eye, HALF, type Eye } from './geometry'

/**
 * 表情目录 —— 眼型不随角色变，只随情绪变。
 *
 * `neutral` 是家：它逐项等于 resources/brand 里 agent-icon-atlas-mark.svg 的两个 rect
 * （原文件绕矩形左上角旋转，这里换算成绕中心，差值叠加校验为全黑）。改它等于改品牌标识。
 * 其余表情都是 neutral 的偏移，情绪一过必须回 neutral。
 *
 * 倾角约定（y 轴向下，正角顺时针）：正 = `/`，负 = `\`。
 *   愤怒 = 内侧压低 → 左 `\`(负) + 右 `/`(正)，向下收成 V
 *   难过 = 内侧抬高 → 左 `/`(正) + 右 `\`(负)，向上拱成 Λ，整体下垂
 */
export type ExpressionId =
  | 'neutral' | 'thinking' | 'focused' | 'happy' | 'angry' | 'sad'
  | 'surprised' | 'sleepy' | 'wink' | 'curious' | 'doubt' | 'proud'

export interface EyePair {
  l: Eye
  r: Eye
}

/**
 * 素材包 resources/brand/agent-mark-source.svg 里的两个 rect，原样抄下来。
 * 它绕**矩形左上角**旋转，我们的眼图元绕中心旋转 —— 换算就在下面这个函数里做，
 * 不把换算结果抄成常数：抄常数就测不出抄错（第一版抄成 14.16，实际 14.1545）。
 */
const SOURCE_EYES = [
  { x: 17, y: 18, w: 10, h: 22, deg: -11 },
  { x: 38, y: 14, w: 10, h: 22, deg: -18 },
] as const

/** rect(左上角旋转) → 我们的眼图元(中心旋转)。描边宽 = rect 宽，直段长 = 高 - 宽。 */
function fromSourceRect(r: (typeof SOURCE_EYES)[number]): Eye {
  const rad = (r.deg * Math.PI) / 180
  const dx = r.w / 2
  const dy = r.h / 2
  return eye(
    r.x + dx * Math.cos(rad) - dy * Math.sin(rad) - HALF,
    r.y + dx * Math.sin(rad) + dy * Math.cos(rad) - HALF,
    r.h - r.w,
    r.w,
    r.deg,
  )
}

export const NEUTRAL: EyePair = {
  l: fromSourceRect(SOURCE_EYES[0]),
  r: fromSourceRect(SOURCE_EYES[1]),
}

const from = (l: Partial<Eye>, r: Partial<Eye>): EyePair =>
  ({ l: { ...NEUTRAL.l, ...l }, r: { ...NEUTRAL.r, ...r } })

export const EXPRESSIONS: Record<ExpressionId, EyePair> = {
  neutral: NEUTRAL,
  thinking: from({ cy: -8, L: 9, tilt: -16 }, { cy: -13, L: 9, tilt: -24 }),
  focused: from({ L: 3, w: 10, tilt: -11 }, { L: 3, w: 10, tilt: -18 }),
  happy: from({ cy: -3, L: 15, w: 7.5, tilt: -92, bend: 9 }, { cy: -8, L: 15, w: 7.5, tilt: -86, bend: 9 }),
  angry: from({ cy: -3, L: 8, tilt: -42 }, { cy: -8, L: 8, tilt: 20 }),
  sad: from({ cy: 8, L: 10, w: 8.5, tilt: 22, bend: -6 }, { cy: 3, L: 10, w: 8.5, tilt: -42, bend: 6 }),
  surprised: from({ L: 4, w: 16, tilt: -6 }, { L: 4, w: 16, tilt: -10 }),
  sleepy: from({ cy: 2, L: 11, w: 5.5, tilt: -93 }, { cy: -3, L: 11, w: 5.5, tilt: -88 }),
  wink: from({ cy: -3, L: 10, w: 4, tilt: -95 }, {}),
  curious: from({ cy: -7, L: 13, w: 11, tilt: -6 }, { cy: -11, L: 8, w: 9, tilt: -24 }),
  doubt: from({ cy: -2, L: 5, w: 10, tilt: -11 }, { cy: -11, L: 13, w: 10, tilt: -18 }),
  proud: from({ cy: -2, L: 12, w: 8, tilt: -100, bend: 6 }, { cy: -7, L: 12, w: 8, tilt: -94, bend: 6 }),
}

export const EXPRESSION_IDS = Object.keys(EXPRESSIONS) as ExpressionId[]

export const blendExpression = (a: ExpressionId, b: ExpressionId, t: number): EyePair => ({
  l: blendEye(EXPRESSIONS[a].l, EXPRESSIONS[b].l, t),
  r: blendEye(EXPRESSIONS[a].r, EXPRESSIONS[b].r, t),
})
