/**
 * Theme Store — 管理用户自定义主题(token 配色 + 字体 + 对比度)
 *
 * 注意:light/dark 切换由 appStore.theme 决定,这里只管"两套 variant 各自的配色"。
 * appStore.theme 变化时,App 顶层会调用 setVariant() 让 themeStore 应用对应 variant。
 *
 * 持久化:localStorage,key = "openpipal-theme-v1"(同时也是序列化 prefix,巧合方便)
 * 不走 IPC / config.json — 主题是 UI 偏好,直接 renderer 本地存即可。
 */
import { create } from 'zustand'
import {
  DEFAULT_THEME,
  applyTheme,
  serializeTheme,
  parseThemeString,
  mergeVariant,
} from '../lib/theme'
import type {
  OpenPipalTheme,
  OpenPipalThemeVariant,
  ThemeVariantKey,
} from '../types/theme'

// v3:默认外观升级到官方 daylight glass —— action accent 从 sage 绿换成墨,
// 画布从 parchment 暖白换成冷白。bump key 让旧 v2(sage)持久化失效,
// 否则老用户会被自己存下来的绿色主题盖掉新默认值。
const STORAGE_KEY = 'openpipal-theme-v3'

interface ThemeState {
  theme: OpenPipalTheme
  /** 当前生效的 variant — 由 App 顶层根据 appStore.theme + matchMedia 推导 */
  variant: ThemeVariantKey
}

interface ThemeActions {
  /** 切换当前生效 variant(由 App 顶层调用) */
  setVariant: (v: ThemeVariantKey) => void
  /** 整体替换 theme(导入 / reset) */
  setTheme: (theme: OpenPipalTheme) => void
  /** 局部更新某个 variant 的配置 */
  updateVariant: (
    variant: ThemeVariantKey,
    patch: Partial<OpenPipalThemeVariant>,
  ) => void
  /** 设置全局 UI 缩放 */
  setUiZoom: (zoom: number) => void
  /** 设置对话阅读密度 */
  setChatDensity: (density: OpenPipalTheme['chatDensity']) => void
  /** 设置 reducedMotion 偏好 */
  setReducedMotion: (mode: OpenPipalTheme['reducedMotion']) => void
  /** 重置为默认主题 */
  resetToDefault: () => void
  /** 导入主题字符串,返回 true=成功 / false=校验失败 */
  importFromString: (input: string) => boolean
  /** 导出当前 theme 为字符串(可分享) */
  exportToString: () => string
}

function loadFromStorage(): OpenPipalTheme {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return DEFAULT_THEME
    const parsed = parseThemeString(raw)
    return parsed ?? DEFAULT_THEME
  } catch {
    return DEFAULT_THEME
  }
}

function saveToStorage(theme: OpenPipalTheme): void {
  try {
    localStorage.setItem(STORAGE_KEY, serializeTheme(theme))
  } catch {
    // localStorage 满 / 隐私模式 — 静默失败,主题仍在内存中
  }
}

export const useThemeStore = create<ThemeState & ThemeActions>((set, get) => ({
  theme: loadFromStorage(),
  variant: 'light',

  setVariant: (variant) => {
    if (get().variant === variant) return
    set({ variant })
    applyTheme(get().theme, variant)
  },

  setTheme: (theme) => {
    set({ theme })
    saveToStorage(theme)
    applyTheme(theme, get().variant)
  },

  updateVariant: (variant, patch) => {
    const cur = get().theme
    const next: OpenPipalTheme = {
      ...cur,
      [variant]: mergeVariant(cur[variant], patch),
    }
    set({ theme: next })
    saveToStorage(next)
    if (variant === get().variant) {
      applyTheme(next, variant)
    }
  },

  setUiZoom: (zoom) => {
    const clamped = Math.max(0.8, Math.min(1.5, zoom))
    const next = { ...get().theme, uiZoom: clamped }
    set({ theme: next })
    saveToStorage(next)
    applyTheme(next, get().variant)
  },

  setChatDensity: (chatDensity) => {
    const next = { ...get().theme, chatDensity }
    set({ theme: next })
    saveToStorage(next)
    applyTheme(next, get().variant)
  },

  setReducedMotion: (mode) => {
    const next = { ...get().theme, reducedMotion: mode }
    set({ theme: next })
    saveToStorage(next)
    applyTheme(next, get().variant)
  },

  resetToDefault: () => {
    set({ theme: DEFAULT_THEME })
    saveToStorage(DEFAULT_THEME)
    applyTheme(DEFAULT_THEME, get().variant)
  },

  importFromString: (input) => {
    const theme = parseThemeString(input)
    if (!theme) return false
    set({ theme })
    saveToStorage(theme)
    applyTheme(theme, get().variant)
    return true
  },

  exportToString: () => serializeTheme(get().theme),
}))

/**
 * 启动时立即应用一次 theme(让 :root 拿到正确的 CSS variables)
 * 在 main.tsx 入口调用,在 createRoot 之前。
 */
export function initThemeOnLoad(): void {
  const { theme, variant } = useThemeStore.getState()
  applyTheme(theme, variant)
}
