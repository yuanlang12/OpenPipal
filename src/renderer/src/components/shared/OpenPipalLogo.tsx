/**
 * OpenPipal 品牌标识 — 移植官方 logo(assets/logo-mark.svg / logo-lockup.svg)。
 *
 * 构造照 Pi 官方标识那套：所有坐标吸附在半模块网格上（64 视窗、半模块 6），
 * 纯 fill 无 stroke——品牌标识用块面，任意缩放都不会因线宽变化而失衡。
 * 形是「主面板 + 右侧贴边窄条」，即产品唯一的那个动作：贴到旁边去。
 * 这里用 token 驱动而非两份 light/inverse SVG:
 *   - 方块 fill=currentColor(父级 text-ink-primary → light #1B2429 / dark #F2F6F9)
 *   - 竖条 fill=var(--sw-brand-sage)(light #6F864F / dark #A8BB87)
 *     注意:这里刻意不用 --sw-brand-500 —— 动作色已经换成墨,而品牌 sage 必须留在标识上。
 *     官方对 logo 的描述就是「墨色方块 + 右侧贴边的 sage 窄条」,竖条一变黑,标识就没了。
 * 因此一份组件自动适配明暗 + 主题强调色,无需 asset pipeline、无闪烁。
 */

interface OpenPipalLogoProps {
  variant?: 'lockup' | 'mark' | 'wordmark'
  /** mark SVG 像素尺寸(可见方块 ≈ size * 0.625);默认 26 */
  size?: number
  className?: string
}

export function OpenPipalLogo({ variant = 'lockup', size = 26, className = '' }: OpenPipalLogoProps) {
  const mark = (
    <svg viewBox="0 0 64 64" width={size} height={size} fill="none" aria-hidden="true" className="shrink-0">
      <rect x="8" y="8" width="36" height="48" fill="currentColor" />
      <rect x="50" y="14" width="6" height="36" fill="var(--sw-brand-sage)" />
    </svg>
  )

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
    return <span className={`inline-flex text-ink-primary ${className}`} aria-label="OpenPipal">{mark}</span>
  }
  if (variant === 'wordmark') {
    return <span className={`inline-flex items-center ${className}`} aria-label="OpenPipal">{wordmark}</span>
  }
  return (
    <span className={`inline-flex items-center gap-1.5 text-ink-primary ${className}`} aria-label="OpenPipal">
      {mark}
      {wordmark}
    </span>
  )
}
