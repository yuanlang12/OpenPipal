/**
 * Theme engine — applyTheme / serialize / parse / DEFAULT_THEME
 *
 * 核心职责:把 OpenPipalTheme JSON 应用到 :root 的 CSS variables。
 * tokens.css 里的 L2 token 是 var(--sw-*) 的目标,这里负责改 :root.style。
 */
import type {
  ChatDensity,
  OpenPipalTheme,
  OpenPipalThemeVariant,
  OpenPipalSemanticColors,
  ThemeVariantKey,
} from '../types/theme'

const SCHEMA = 'openpipal-theme-v1' as const
const STRING_PREFIX = `${SCHEMA}:`

/**
 * 阅读密度 token。正文大小是整个内容区（对话、列表、文本型 Artifact）的
 * 共用基准；对话额外拥有行高和消息留白，因此仍能在不破坏产物画布的前提下
 * 获得更舒适的阅读节奏。
 */
export const CHAT_DENSITY_TOKENS: Record<ChatDensity, {
  body: string
  reasoning: string
  label: string
  meta: string
  small: string
  /** 让全局 14px 基准与本档回答正文对齐。 */
  contentScale: number
  leading: string
  messageGap: string
  userPaddingY: string
  userPaddingX: string
}> = {
  compact: {
    body: '14px', reasoning: '12px', label: '12px', meta: '11px', small: '10px',
    contentScale: 1,
    leading: '1.65', messageGap: '12px', userPaddingY: '10px', userPaddingX: '14px',
  },
  comfortable: {
    body: '15px', reasoning: '13px', label: '13px', meta: '12px', small: '11px',
    contentScale: 15 / 14,
    leading: '1.7', messageGap: '16px', userPaddingY: '11px', userPaddingX: '14px',
  },
  relaxed: {
    body: '16px', reasoning: '14px', label: '14px', meta: '12px', small: '11px',
    contentScale: 16 / 14,
    leading: '1.75', messageGap: '20px', userPaddingY: '13px', userPaddingX: '16px',
  },
}

/* ════════════════════════════════════════════════════════
 * 默认主题 —— 官方设计系统 daylight glass
 *
 * accent 是「墨」不是色相:主按钮、激活导航、链接、焦点环都是白底近黑。
 * sage 退回品牌位,只承担 success / orb / logo —— 所以它落在 semantic.success
 * 而不是 accent。这就是「主色调从绿色换掉」的落点:改种子,
 * 七百多处 brand-* 用法跟着 applyTheme 一次性换掉,不逐个文件改。
 * ════════════════════════════════════════════════════════ */
export const DEFAULT_THEME: OpenPipalTheme = {
  schema: SCHEMA,
  light: {
    accent: '#1B2429',   /* ink-700 — action color,不是色相 */
    surface: '#FFFFFF',  /* 会话画布是不透明白,玻璃只上 chrome */
    ink: '#1B2429',      /* fg-primary */
    contrast: 50,
    fonts: { ui: 'Geist', mono: 'Geist Mono' },
    sidebarOpaque: true,
    semantic: {
      success: '#6F864F',     /* sage — 品牌色留在语义位,不做动作色 */
      danger: '#B25A3E',      /* clay-red */
      warning: '#B8843C',
      info: '#5B7388',
      diffAdded: '#6F864F',
      diffRemoved: '#B25A3E',
      skill: '#6F864F',
    },
  },
  dark: {
    accent: '#F2F6F9',   /* 暗底把墨反过来 */
    surface: '#161D22',
    ink: '#F2F6F9',
    contrast: 62,
    fonts: { ui: 'Geist', mono: 'Geist Mono' },
    sidebarOpaque: true,
    semantic: {
      success: '#A8BB87',
      danger: '#D9A57E',
      warning: '#D9A57E',
      info: '#8FA8BC',
      diffAdded: '#A8BB87',
      diffRemoved: '#D9A57E',
      skill: '#A8BB87',
    },
  },
  uiZoom: 1,
  chatDensity: 'comfortable',
  reducedMotion: 'system',
}

/* ════════════════════════════════════════════════════════
 * 颜色派生引擎 — hex 操作工具(因为 color-mix 不兼容 Tailwind alpha modifier)
 * ════════════════════════════════════════════════════════ */

/** "#C2410C" → [194, 65, 12](支持 #rgb / #rrggbb / #rrggbbaa) */
function hexToRgbArr(hex: string): [number, number, number] {
  let s = hex.replace('#', '').trim()
  if (s.length === 3) s = s.split('').map(c => c + c).join('')
  if (s.length !== 6 && s.length !== 8) return [0, 0, 0]
  return [
    parseInt(s.slice(0, 2), 16),
    parseInt(s.slice(2, 4), 16),
    parseInt(s.slice(4, 6), 16),
  ]
}

/** [r, g, b] → "r g b"(Tailwind <alpha-value> 兼容格式) */
function rgbArrToTriplet([r, g, b]: [number, number, number]): string {
  return `${r} ${g} ${b}`
}

/** 在 sRGB 空间线性混合两个 hex,ratioOfA ∈ [0, 1](A 占比) */
function mixHex(a: string, b: string, ratioOfA: number): [number, number, number] {
  const [ar, ag, ab] = hexToRgbArr(a)
  const [br, bg, bb] = hexToRgbArr(b)
  const t = Math.max(0, Math.min(1, ratioOfA))
  return [
    Math.round(ar * t + br * (1 - t)),
    Math.round(ag * t + bg * (1 - t)),
    Math.round(ab * t + bb * (1 - t)),
  ]
}

const WHITE = '#FFFFFF'
const BLACK = '#000000'

/** 从 accent 派生 brand 9 档(50/100/.../900),返回每档的 "r g b" 三元组 */
function deriveBrandScale(accent: string): Record<string, string> {
  return {
    50:  rgbArrToTriplet(mixHex(accent, WHITE, 0.08)),
    100: rgbArrToTriplet(mixHex(accent, WHITE, 0.16)),
    200: rgbArrToTriplet(mixHex(accent, WHITE, 0.28)),
    300: rgbArrToTriplet(mixHex(accent, WHITE, 0.42)),
    400: rgbArrToTriplet(mixHex(accent, WHITE, 0.65)),
    500: rgbArrToTriplet(hexToRgbArr(accent)),
    600: rgbArrToTriplet(mixHex(accent, BLACK, 0.85)),
    700: rgbArrToTriplet(mixHex(accent, BLACK, 0.70)),
    800: rgbArrToTriplet(mixHex(accent, BLACK, 0.55)),
    900: rgbArrToTriplet(mixHex(accent, BLACK, 0.40)),
  }
}

/**
 * 从 surface + ink + contrast 派生 surface 11 档(0/50/.../900)
 * 0   = surface(最浅)
 * 700 = ink(最深)
 * 400/500 受 contrast 影响(高对比 → 深)
 */
function deriveSurfaceScale(
  surface: string,
  ink: string,
  contrast: number,
): Record<string, string> {
  // contrast 0..100 → adjust 二级文字浓度
  // surface % 越小越接近 ink
  const c400Ratio = 0.60 - contrast * 0.004 // 0.60 → 0.20
  const c500Ratio = 0.40 - contrast * 0.004 // 0.40 → 0.00(全 ink)
  return {
    0:   rgbArrToTriplet(hexToRgbArr(surface)),
    50:  rgbArrToTriplet(mixHex(surface, ink, 0.96)),
    100: rgbArrToTriplet(mixHex(surface, ink, 0.90)),
    200: rgbArrToTriplet(mixHex(surface, ink, 0.75)),
    300: rgbArrToTriplet(mixHex(surface, ink, 0.55)),
    400: rgbArrToTriplet(mixHex(surface, ink, Math.max(0.10, c400Ratio))),
    500: rgbArrToTriplet(mixHex(surface, ink, Math.max(0.05, c500Ratio))),
    600: rgbArrToTriplet(mixHex(surface, ink, 0.10)),
    700: rgbArrToTriplet(hexToRgbArr(ink)),
    800: rgbArrToTriplet(mixHex(ink, BLACK, 0.92)),
    900: rgbArrToTriplet(mixHex(ink, BLACK, 0.85)),
  }
}

/** 从 surface + ink 派生 sidebar 4 档(50/100/200/300) */
function deriveSidebarScale(surface: string, ink: string): Record<string, string> {
  return {
    50:  rgbArrToTriplet(mixHex(surface, ink, 0.95)),
    100: rgbArrToTriplet(mixHex(surface, ink, 0.90)),
    200: rgbArrToTriplet(mixHex(surface, ink, 0.85)),
    300: rgbArrToTriplet(mixHex(surface, ink, 0.80)),
  }
}

/* ════════════════════════════════════════════════════════
 * applyTheme — 把 theme 应用到 :root CSS variables
 *
 * variant 决定当前用 light 还是 dark variant 的颜色
 * uiZoom / chatDensity / reducedMotion 这种全局态不分 variant
 * ════════════════════════════════════════════════════════ */
export function applyTheme(theme: OpenPipalTheme, variant: ThemeVariantKey): void {
  const v = theme[variant]
  const root = document.documentElement
  const style = root.style

  // 主题种子色
  style.setProperty('--sw-accent', v.accent)
  style.setProperty('--sw-surface', v.surface)
  style.setProperty('--sw-ink', v.ink)
  style.setProperty('--sw-contrast', String(v.contrast))
  style.setProperty('--sw-sidebar-opaque', v.sidebarOpaque ? '1' : '0')

  // ════ 派生 RGB 三元组(给 Tailwind 的 rgb(var(...) / <alpha-value>) 用)════
  const brand = deriveBrandScale(v.accent)
  const surface = deriveSurfaceScale(v.surface, v.ink, v.contrast)
  const sidebar = deriveSidebarScale(v.surface, v.ink)

  for (const [step, triplet] of Object.entries(brand)) {
    style.setProperty(`--sw-brand-${step}-rgb`, triplet)
  }
  for (const [step, triplet] of Object.entries(surface)) {
    style.setProperty(`--sw-surface-${step}-rgb`, triplet)
  }
  for (const [step, triplet] of Object.entries(sidebar)) {
    style.setProperty(`--sw-sidebar-${step}-rgb`, triplet)
  }

  // 单值 RGB 三元组(供直接 rgb() 使用)
  style.setProperty('--sw-accent-rgb', rgbArrToTriplet(hexToRgbArr(v.accent)))
  style.setProperty('--sw-surface-rgb', rgbArrToTriplet(hexToRgbArr(v.surface)))
  style.setProperty('--sw-ink-rgb', rgbArrToTriplet(hexToRgbArr(v.ink)))

  // 字体(加 fallback 链)
  if (v.fonts.ui) {
    style.setProperty(
      '--sw-font-ui',
      `"${v.fonts.ui}", "PingFang SC", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`,
    )
  }
  if (v.fonts.mono) {
    style.setProperty(
      '--sw-font-mono',
      `"${v.fonts.mono}", "Fira Code", Menlo, Consolas, monospace`,
    )
  }

  // 语义色(只有显式声明才覆盖,否则保持 tokens.css 默认派生)
  applySemanticColor(style, '--sw-success', v.semantic.success)
  applySemanticColor(style, '--sw-danger', v.semantic.danger)
  applySemanticColor(style, '--sw-warning', v.semantic.warning)
  applySemanticColor(style, '--sw-info', v.semantic.info)
  applySemanticColor(style, '--sw-diff-added', v.semantic.diffAdded)
  applySemanticColor(style, '--sw-diff-removed', v.semantic.diffRemoved)
  applySemanticColor(style, '--sw-tag-skill', v.semantic.skill)

  // 全局态(不分 variant)
  style.setProperty('--sw-ui-zoom', String(theme.uiZoom))
  const density = CHAT_DENSITY_TOKENS[theme.chatDensity]
  // UI 缩放负责整个界面；阅读密度再把文本型内容的基准对齐到 14 / 15 / 16px。
  // 分开保存让聊天正文不会被 density 重复放大。
  style.setProperty('--sw-content-scale', String(density.contentScale))
  style.setProperty('--sw-ui-text-scale', String(theme.uiZoom * density.contentScale))
  style.setProperty('--sw-chat-body-base', density.body)
  style.setProperty('--sw-chat-reasoning-base', density.reasoning)
  style.setProperty('--sw-chat-label-base', density.label)
  style.setProperty('--sw-chat-meta-base', density.meta)
  style.setProperty('--sw-chat-small-base', density.small)
  style.setProperty('--sw-chat-leading', density.leading)
  style.setProperty('--sw-msg-gap-y', density.messageGap)
  style.setProperty('--sw-chat-user-padding-y', density.userPaddingY)
  style.setProperty('--sw-chat-user-padding-x', density.userPaddingX)
  root.setAttribute('data-sw-chat-density', theme.chatDensity)

  // 切换 .dark class(让 tokens.css 里的 .dark 块生效)
  if (variant === 'dark') {
    root.classList.add('dark')
  } else {
    root.classList.remove('dark')
  }

  // 减少动效(prefers-reduced-motion 仅响应系统,这里加 data 属性给 CSS 自定义规则用)
  if (theme.reducedMotion === 'always') {
    root.setAttribute('data-sw-reduced-motion', 'always')
  } else if (theme.reducedMotion === 'never') {
    root.setAttribute('data-sw-reduced-motion', 'never')
  } else {
    root.removeAttribute('data-sw-reduced-motion')
  }
}

function applySemanticColor(
  style: CSSStyleDeclaration,
  varName: string,
  value: string | undefined,
): void {
  if (value && isHexColor(value)) {
    style.setProperty(varName, value)
  } else {
    style.removeProperty(varName)
  }
}

/* ════════════════════════════════════════════════════════
 * 序列化 — "openpipal-theme-v1:{json}"  (对照 Codex codex-theme-v1)
 * ════════════════════════════════════════════════════════ */
export function serializeTheme(theme: OpenPipalTheme): string {
  return STRING_PREFIX + JSON.stringify(theme)
}

/* ════════════════════════════════════════════════════════
 * 解析字符串 — 校验失败返回 null
 *
 * 支持两种格式:
 *   1. "openpipal-theme-v1:{...}"  (完整字符串)
 *   2. 纯 JSON 字符串            (容错,如果用户只粘贴 JSON)
 * ════════════════════════════════════════════════════════ */
export function parseThemeString(input: string): OpenPipalTheme | null {
  if (!input || typeof input !== 'string') return null
  const trimmed = input.trim()
  const jsonPart = trimmed.startsWith(STRING_PREFIX)
    ? trimmed.slice(STRING_PREFIX.length)
    : trimmed
  try {
    const obj = withLegacyThemeDefaults(JSON.parse(jsonPart))
    return validateTheme(obj) ? obj : null
  } catch {
    return null
  }
}

/* ════════════════════════════════════════════════════════
 * 校验(替代 zod,避免新依赖)
 * ════════════════════════════════════════════════════════ */
export function validateTheme(obj: unknown): obj is OpenPipalTheme {
  if (typeof obj !== 'object' || obj === null) return false
  const t = obj as Partial<OpenPipalTheme>
  if (t.schema !== SCHEMA) return false
  if (!validateVariant(t.light)) return false
  if (!validateVariant(t.dark)) return false
  if (typeof t.uiZoom !== 'number' || t.uiZoom < 0.5 || t.uiZoom > 2) return false
  if (!isChatDensity(t.chatDensity)) return false
  if (!isReducedMotion(t.reducedMotion)) return false
  return true
}

/**
 * chatDensity 是在 openpipal-theme-v1 发布后新增的 UI 偏好。保留同一 schema，
 * 让已保存/已分享的旧主题在升级后自动使用新的“舒适”默认值。
 */
function withLegacyThemeDefaults(obj: unknown): unknown {
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return obj
  if (Object.prototype.hasOwnProperty.call(obj, 'chatDensity')) return obj
  return { ...obj, chatDensity: DEFAULT_THEME.chatDensity }
}

function validateVariant(v: unknown): v is OpenPipalThemeVariant {
  if (typeof v !== 'object' || v === null) return false
  const x = v as Partial<OpenPipalThemeVariant>
  if (!isHexColor(x.accent) || !isHexColor(x.surface) || !isHexColor(x.ink)) return false
  if (typeof x.contrast !== 'number' || x.contrast < 0 || x.contrast > 100) return false
  if (typeof x.fonts !== 'object' || x.fonts === null) return false
  if (typeof x.fonts.ui !== 'string' || typeof x.fonts.mono !== 'string') return false
  if (typeof x.sidebarOpaque !== 'boolean') return false
  if (typeof x.semantic !== 'object' || x.semantic === null) return false
  return true
}

function isHexColor(s: unknown): s is string {
  return typeof s === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(s)
}

function isReducedMotion(s: unknown): s is OpenPipalTheme['reducedMotion'] {
  return s === 'system' || s === 'always' || s === 'never'
}

function isChatDensity(s: unknown): s is ChatDensity {
  return s === 'compact' || s === 'comfortable' || s === 'relaxed'
}

/* ════════════════════════════════════════════════════════
 * 工具:合并 partial variant patch
 * ════════════════════════════════════════════════════════ */
export function mergeVariant(
  base: OpenPipalThemeVariant,
  patch: Partial<OpenPipalThemeVariant>,
): OpenPipalThemeVariant {
  return {
    ...base,
    ...patch,
    fonts: { ...base.fonts, ...(patch.fonts ?? {}) },
    semantic: { ...base.semantic, ...(patch.semantic ?? {}) },
  }
}

/* ════════════════════════════════════════════════════════
 * 工具:resolve variant from ThemeMode
 * 给 themeStore 用,把 appStore.theme ('system'|'light'|'dark') 解析成实际 variant
 * ════════════════════════════════════════════════════════ */
export function resolveVariant(mode: 'system' | 'light' | 'dark'): ThemeVariantKey {
  if (mode === 'system') {
    return typeof window !== 'undefined' &&
      window.matchMedia &&
      window.matchMedia('(prefers-color-scheme: dark)').matches
      ? 'dark'
      : 'light'
  }
  return mode
}
