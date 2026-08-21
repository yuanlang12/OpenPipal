import { AgentMark } from '../agent-mark'

/**
 * OpenPipal 品牌标识 —— 官方 logo 就是 Agent Mark 的默认形态（不带配饰、中性表情）。
 *
 * 换句话说产品和它的 Agent 共用同一个符号：用户在侧栏看到的每个 Agent，都是这个 logo
 * 戴上了自己的配饰。所以这里不另画一套几何，直接用 <AgentMark accessory="none">，
 * 明暗自动跟随 --sw-mark-ink / --sw-mark-paper。
 *
 * 静止态逐项等于 resources/brand/agent-mark-source.svg（tests/unit/agent-mark-engine.test.ts
 * 解析那个文件来钉住）；应用图标 resources/icon.svg 是同一份几何的 1024 版本。
 */

interface OpenPipalLogoProps {
  variant?: 'lockup' | 'mark' | 'wordmark'
  /** mark 的像素尺寸；默认 26 */
  size?: number
  className?: string
  /** 品牌位上偶尔想让它眨个眼；默认静止，列表和标题栏不该有动效 */
  animated?: boolean
}

export function OpenPipalLogo({
  variant = 'lockup', size = 26, className = '', animated = false,
}: OpenPipalLogoProps): React.JSX.Element {
  const mark = <AgentMark accessory="none" hue="ink" size={size} animated={animated} />

  const wordmark = (
    <span
      className="font-semibold leading-none text-ink-primary"
      style={{
        fontFamily: 'Geist, -apple-system, system-ui, sans-serif',
        fontSize: Math.round(size * 0.62),
        letterSpacing: '-0.02em',
      }}
    >
      OpenPipal
    </span>
  )

  if (variant === 'mark') {
    return <span className={`inline-flex ${className}`} aria-label="OpenPipal">{mark}</span>
  }
  if (variant === 'wordmark') {
    return <span className={`inline-flex items-center ${className}`} aria-label="OpenPipal">{wordmark}</span>
  }
  return (
    <span className={`inline-flex items-center gap-1.5 ${className}`} aria-label="OpenPipal">
      {mark}
      {wordmark}
    </span>
  )
}
