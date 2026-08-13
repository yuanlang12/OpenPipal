import { Phone, Mic, Volume2, Loader2 } from 'lucide-react'
import type { VoiceSessionState } from '../types'

interface VoiceCallStripProps {
  sessionState: VoiceSessionState
  duration: number
  inputLevel: number // 0-1，麦克风采集音量
  outputLevel: number // 0-1，AI 输出音量
  isUserSpeaking: boolean
  isAISpeaking: boolean
  onHangup: () => void
}

function formatDuration(s: number): string {
  const m = Math.floor(s / 60)
  const sec = s % 60
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
}

/** 音量条 —— 5 格，按 level (0-1) 点亮对应格子 */
function LevelBars({ level, active, color }: { level: number; active: boolean; color: string }): JSX.Element {
  const bars = 5
  const lit = Math.ceil(Math.min(1, Math.max(0, level)) * bars)
  return (
    <div className="flex items-end gap-[2px] h-3" data-testid="voice-strip-levels">
      {Array.from({ length: bars }).map((_, i) => (
        <div
          key={i}
          className={`w-[2px] rounded-sm transition-all ${active && i < lit ? color : 'bg-surface-200'}`}
          style={{ height: `${(i + 1) * 2 + 2}px` }}
        />
      ))}
    </div>
  )
}

export function VoiceCallStrip({
  sessionState,
  duration,
  inputLevel,
  outputLevel,
  isUserSpeaking,
  isAISpeaking,
  onHangup
}: VoiceCallStripProps): JSX.Element {
  const isConnecting = sessionState === 'connecting'
  const isConnected = sessionState === 'connected'
  const isError = sessionState === 'error'

  return (
    <div
      data-testid="voice-call-strip"
      className={`h-9 shrink-0 flex items-center px-3 gap-3 border-b text-[12px] ${
        isError
          ? 'bg-rose-50 dark:bg-rose-950/40 border-rose-200 dark:border-rose-800'
          : 'bg-brand-50 dark:bg-brand-900/30 border-brand-200 dark:border-brand-800'
      }`}
    >
      {/* 状态点 */}
      <div className="flex items-center gap-1.5">
        {isConnecting && (
          <Loader2 className="w-3 h-3 text-brand-500 animate-spin" />
        )}
        {isConnected && (
          <span
            className={`w-2 h-2 rounded-full bg-emerald-500 ${isUserSpeaking || isAISpeaking ? 'animate-pulse' : ''}`}
            data-testid="voice-strip-status-dot"
          />
        )}
        {isError && (
          <span className="w-2 h-2 rounded-full bg-rose-500" />
        )}
        <span
          className={`font-medium ${
            isError
              ? 'text-rose-700 dark:text-rose-300'
              : 'text-brand-700 dark:text-brand-300'
          }`}
          data-testid="voice-strip-state-label"
        >
          {isConnecting && '连接中…'}
          {isConnected && '通话中'}
          {isError && '连接错误'}
        </span>
      </div>

      {/* 时长 */}
      {isConnected && (
        <span
          className="font-mono tabular-nums text-surface-500"
          data-testid="voice-strip-duration"
        >
          {formatDuration(duration)}
        </span>
      )}

      {/* 麦克风音量条 */}
      {isConnected && (
        <div className="flex items-center gap-1.5">
          <Mic className={`w-3 h-3 ${isUserSpeaking ? 'text-brand-600 dark:text-brand-400' : 'text-surface-400'}`} />
          <LevelBars
            level={inputLevel}
            active={isConnected}
            color="bg-brand-500 dark:bg-brand-400"
          />
        </div>
      )}

      {/* AI 说话指示 */}
      {isConnected && isAISpeaking && (
        <div
          className="flex items-center gap-1.5 text-brand-600 dark:text-brand-400"
          data-testid="voice-strip-ai-speaking"
        >
          <Volume2 className="w-3 h-3 animate-pulse" />
          <LevelBars
            level={outputLevel}
            active={isAISpeaking}
            color="bg-brand-400 dark:bg-brand-300"
          />
          <span className="text-[11px]">AI 说话中</span>
        </div>
      )}

      {/* 右侧 spacer */}
      <div className="flex-1" />

      {/* 挂断按钮 */}
      <button
        onClick={onHangup}
        data-testid="voice-strip-hangup"
        className="flex items-center gap-1 px-2 py-1 rounded-md bg-rose-500 hover:bg-rose-600 text-white text-[11px] font-medium transition-colors"
        title="挂断通话"
      >
        <Phone className="w-3 h-3 rotate-[135deg]" />
        挂断
      </button>
    </div>
  )
}
