import { Mic, Phone, Loader2, Volume2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { VoiceSessionState } from '../types'

interface VoiceCallInlineProps {
  sessionState: VoiceSessionState
  duration: number
  isAISpeaking: boolean
  inputLevel: number
  voiceAvailable: boolean
  /** 开始通话（空闲态点击） */
  onStart?: () => void
  /** 挂断（通话态点击 ✕） */
  onHangup: () => void
}

function fmt(s: number): string {
  const m = Math.floor(s / 60)
  const sec = s % 60
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
}

/** 3 格音量条 */
function MiniLevel({ level, active, color }: { level: number; active: boolean; color: string }): JSX.Element {
  const lit = Math.ceil(Math.min(1, Math.max(0, level)) * 3)
  return (
    <div className="flex items-end gap-[1.5px] h-2.5">
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          className={`w-[2px] rounded-sm transition-all ${active && i < lit ? color : 'bg-surface-300/50'}`}
          style={{ height: `${(i + 1) * 2 + 1}px` }}
        />
      ))}
    </div>
  )
}

/**
 * 输入框内联语音控件 —— 替代顶部全宽 VoiceCallStrip。
 * 空闲：麦克风图标；通话中：原地变成紧凑通话控件(状态点+计时+音量+挂断)。
 * InputBar 和 WelcomePage 共用，避免重复实现。
 */
export function VoiceCallInline({
  sessionState,
  duration,
  isAISpeaking,
  inputLevel,
  voiceAvailable,
  onStart,
  onHangup
}: VoiceCallInlineProps): JSX.Element | null {
  const { t } = useTranslation()
  if (!voiceAvailable) return null

  // ── 空闲：麦克风按钮 ──
  if (sessionState === 'idle') {
    return (
      <button
        onClick={onStart}
        data-testid="voice-inline-start"
        title={t('chat.voiceInline.start')}
        aria-label={t('chat.voiceInline.start')}
        className="flex items-center justify-center w-7 h-7 rounded-md text-surface-400 hover:text-brand-600 hover:bg-brand-50 dark:hover:bg-brand-900/20 transition-colors"
      >
        <Mic className="w-4 h-4" />
      </button>
    )
  }

  const isConnecting = sessionState === 'connecting'
  const isError = sessionState === 'error'

  // ── 通话中：紧凑内联控件 ──
  return (
    <div
      data-testid="voice-inline-active"
      className={`flex items-center gap-1.5 h-7 pl-2 pr-1 rounded-full border ${
        isError
          ? 'border-rose-200 dark:border-rose-800 bg-rose-50 dark:bg-rose-950/40'
          : 'border-brand-200 dark:border-brand-800 bg-brand-50 dark:bg-brand-900/30'
      }`}
    >
      {/* 状态点 / 连接中转圈 */}
      {isConnecting ? (
        <Loader2 className="w-3 h-3 text-brand-500 animate-spin" />
      ) : isError ? (
        <span className="w-1.5 h-1.5 rounded-full bg-rose-500" />
      ) : (
        <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
      )}

      {/* 计时 / 状态文字 */}
      {isConnecting ? (
        <span className="text-[11px] text-brand-600 dark:text-brand-400">{t('chat.voiceInline.connecting')}</span>
      ) : isError ? (
        <span className="text-[11px] text-rose-600 dark:text-rose-400">{t('chat.voiceInline.error')}</span>
      ) : (
        <span className="text-[11px] font-mono tabular-nums text-brand-700 dark:text-brand-300">{fmt(duration)}</span>
      )}

      {/* AI 说话 / 麦克风音量指示 */}
      {!isConnecting && !isError && (
        isAISpeaking ? (
          <Volume2 className="w-3 h-3 text-brand-500 animate-pulse" />
        ) : (
          <MiniLevel level={inputLevel} active color="bg-brand-500 dark:bg-brand-400" />
        )
      )}

      {/* 挂断 */}
      <button
        onClick={onHangup}
        data-testid="voice-inline-hangup"
        title={t('chat.voiceInline.hangup')}
        aria-label={t('chat.voiceInline.hangup')}
        className="flex items-center justify-center w-5 h-5 rounded-full bg-rose-500 hover:bg-rose-600 text-white transition-colors"
      >
        <Phone className="w-2.5 h-2.5 rotate-[135deg]" />
      </button>
    </div>
  )
}
