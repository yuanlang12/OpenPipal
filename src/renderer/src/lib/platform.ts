/**
 * 渲染层眼里的平台。桌面端 preload（@electron-toolkit/preload）把 process.platform 挂在
 * window.electron.process 上；浏览器插件里没有 preload，一律算 'web'。
 * 纯函数，参数默认取全局 window，单测里可以传假对象。
 */
export type RendererPlatform = 'darwin' | 'win32' | 'linux' | 'web'

interface PlatformHost {
  electron?: { process?: { platform?: unknown } }
  __OPENPIPAL_ENV__?: unknown
}

export function detectRendererPlatform(host: PlatformHost = window as unknown as PlatformHost): RendererPlatform {
  if (host.__OPENPIPAL_ENV__ === 'browser') return 'web'
  const platform = host.electron?.process?.platform
  if (platform === 'darwin' || platform === 'win32' || platform === 'linux') return platform
  return 'web'
}

/** 挂在 <html> 上的类名，CSS 里按 `.platform-win32 …` 写平台专属样式 */
export function platformClassName(platform: RendererPlatform): string {
  return `platform-${platform}`
}

/**
 * 要不要自绘窗口按钮。macOS 的无边框窗靠 Cmd+W / 托盘，用户习惯里也没有右上角的 ×；
 * Windows 用户找不到 × 就会以为程序关不掉。Linux 暂与 Windows 同样处理不做（等有人真用再说）。
 */
export function showsCustomWindowControls(platform: RendererPlatform): boolean {
  return platform === 'win32'
}
