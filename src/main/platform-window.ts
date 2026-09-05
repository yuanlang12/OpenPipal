/**
 * 主窗口外观里随平台变化的那一小块，其余 BrowserWindow 选项在 index.ts。
 *
 * macOS：透明无边框 + NSVisualEffectView 毛玻璃。backdrop-filter 只能采样页面自己的像素，
 * 采不到桌面——想让 chrome 真的磨砂透出背后的桌面/前台应用，只有挂 vibrancy 这一条路。
 * visualEffectState:'active' 让材质在窗口失焦时依然保持点亮：OpenPipal 常年贴在别的应用
 * 旁边，失焦是常态，不能一没焦点就糊成一块死灰。
 *
 * Windows / Linux：不透明主题底色（2026-09-04 所有者定）。Windows 11 的 acrylic/mica 看着像
 * 对应物，但系统会在窗口失焦时把它们变成实色，而 OpenPipal 贴在别的应用旁边时多数时间是
 * 失焦的，玻璃只会在点进来那一刻出现——不值得为它多一条渲染路径。四角由系统画
 * （Win11 圆角 / Win10 直角），渲染层的 .platform-win32 样式去掉壳自己的圆角与内描边。
 */
import type { BrowserWindowConstructorOptions } from 'electron'

/**
 * 不透明底色 = 渲染层 DEFAULT_THEME 的 surface 种子（lib/theme.ts：浅 #FFFFFF / 深 #161D22）。
 * 主进程不认渲染层的主题存储（localStorage），建窗时按系统深浅先猜一个，渲染层主题定下来后
 * 经 window:set-background 对齐——否则深色主题下窗口拉伸、首屏都会闪白边。
 */
export const WINDOW_BACKGROUND_LIGHT = '#FFFFFF'
export const WINDOW_BACKGROUND_DARK = '#161D22'
/** @deprecated 历史名字，等于浅色底；新代码用 windowBackgroundColor */
export const OPAQUE_WINDOW_BACKGROUND = WINDOW_BACKGROUND_LIGHT

export type WindowThemeVariant = 'light' | 'dark'

export function windowBackgroundColor(variant: WindowThemeVariant): string {
  return variant === 'dark' ? WINDOW_BACKGROUND_DARK : WINDOW_BACKGROUND_LIGHT
}

export type PlatformWindowOptions = Pick<
  BrowserWindowConstructorOptions,
  'transparent' | 'vibrancy' | 'visualEffectState' | 'backgroundColor'
>

export function platformWindowOptions(
  platform: NodeJS.Platform = process.platform,
  prefersDark = false
): PlatformWindowOptions {
  if (platform === 'darwin') {
    return {
      transparent: true,
      vibrancy: 'under-window',
      visualEffectState: 'active',
      backgroundColor: '#00000000'
    }
  }
  return { transparent: false, backgroundColor: windowBackgroundColor(prefersDark ? 'dark' : 'light') }
}

/**
 * 托盘图标文件名（resources/tray/ 下）。
 * macOS 用 Template 图：纯黑 + 透明，文件名以 Template 结尾，系统按菜单栏深浅自动反色。
 * Windows 不做模板反色，纯黑图在深色任务栏上直接看不见——用彩色多尺寸 .ico
 * （scripts/render-windows-icons.mjs 从 icon.icns 生成）。
 */
export function trayIconFile(platform: NodeJS.Platform = process.platform): string {
  return platform === 'darwin' ? 'openpipalTemplate.png' : 'openpipal.ico'
}
