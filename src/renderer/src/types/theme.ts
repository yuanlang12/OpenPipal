/**
 * OpenPipal Theme — openpipal-theme-v1
 *
 * 用户自定义主题的契约。一个 theme 包含 light/dark 两套 variant,
 * 加上全局的 uiZoom 和 reducedMotion 偏好。
 *
 * 可序列化为 "openpipal-theme-v1:{...}" 字符串,方便用户复制/分享/导入。
 *
 * 对照 Codex 的 codex-theme-v1 协议:
 *   - accent:    强调色(品牌主色)
 *   - surface:   背景种子色
 *   - ink:       前景文字种子色
 *   - contrast:  对比度滑块 0-100
 *   - fonts:     UI / mono 字体
 *   - semantic:  语义色覆盖(diff/skill/success/danger)
 */

export interface OpenPipalSemanticColors {
  success?: string
  danger?: string
  warning?: string
  info?: string
  diffAdded?: string
  diffRemoved?: string
  skill?: string
}

export interface OpenPipalThemeVariant {
  /** 强调色 — hex */
  accent: string
  /** 主表面色 — hex */
  surface: string
  /** 前景文字色 — hex */
  ink: string
  /** 对比度 0-100,影响二级/三级文字透明度 */
  contrast: number
  /** UI 字体 + 等宽字体 */
  fonts: { ui: string; mono: string }
  /** 半透明侧边栏(false = opaque) */
  sidebarOpaque: boolean
  /** 语义色覆盖,未指定走默认派生 */
  semantic: OpenPipalSemanticColors
}

/** 内容阅读密度。它统一内容型界面的字号基准，并控制聊天的行距和消息间距。 */
export type ChatDensity = 'compact' | 'comfortable' | 'relaxed'

export interface OpenPipalTheme {
  schema: 'openpipal-theme-v1'
  light: OpenPipalThemeVariant
  dark: OpenPipalThemeVariant
  /** UI 字号缩放 0.8 - 1.5 */
  uiZoom: number
  /** 内容阅读密度 */
  chatDensity: ChatDensity
  /** 动效偏好 */
  reducedMotion: 'system' | 'always' | 'never'
}

export type ThemeVariantKey = 'light' | 'dark'
