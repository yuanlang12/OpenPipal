import { Minus, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { detectRendererPlatform, showsCustomWindowControls } from '../lib/platform'

/**
 * Windows 的窗口按钮（— / ×）。窗口是 frame:false，系统不画按钮；macOS 用户靠 Cmd+W 与托盘，
 * Windows 用户找不到右上角的 × 会以为程序关不掉。× 与 macOS 的关闭行为一致：收进托盘，不退出。
 * 只在 win32 渲染；按钮本体 no-drag，否则点击会被当成拖动标题栏。
 */
export function WindowControls() {
  const { t } = useTranslation()
  if (!showsCustomWindowControls(detectRendererPlatform())) return null
  const base = 'w-11 self-stretch flex items-center justify-center transition-colors text-surface-500 dark:text-surface-300'
  return (
    <div
      className="flex items-stretch self-stretch shrink-0 ml-1"
      style={{ WebkitAppRegion: 'no-drag' } as any}
      data-testid="window-controls"
    >
      <button
        type="button"
        onClick={() => { void window.api.minimizeWindow?.() }}
        aria-label={t('shell.window.minimize')}
        title={t('shell.window.minimize')}
        className={`${base} hover:bg-surface-100 dark:hover:bg-white/10`}
      >
        <Minus className="w-3.5 h-3.5" />
      </button>
      <button
        type="button"
        onClick={() => { void window.api.hideWindow?.() }}
        aria-label={t('shell.window.close')}
        title={t('shell.window.close')}
        className={`${base} hover:bg-[#c42b1c] hover:text-white`}
      >
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  )
}
