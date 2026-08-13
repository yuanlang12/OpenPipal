/**
 * VoiceCallOverlay — 实时语音通话覆盖层
 *
 * 全屏覆盖在聊天面板之上，显示：
 * - 通话状态和时长
 * - 实时转录文本
 * - 音量指示动画
 * - 挂断按钮
 */

import { useRef, useEffect } from 'react'
import { Mic, Volume2, PhoneOff } from 'lucide-react'
import type { VoiceTranscriptItem, VoiceSessionState } from '../types'

interface VoiceCallOverlayProps {
  sessionState: VoiceSessionState
  transcripts: VoiceTranscriptItem[]
  isUserSpeaking: boolean
  isAISpeaking: boolean
  duration: number
  inputLevel: number
  outputLevel: number
  onHangup: () => void
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
}

export function VoiceCallOverlay({
  sessionState,
  transcripts,
  isUserSpeaking,
  isAISpeaking,
  duration,
  inputLevel,
  outputLevel,
  onHangup
}: VoiceCallOverlayProps) {
  const scrollRef = useRef<HTMLDivElement>(null)

  // 自动滚动到底部
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [transcripts])

  const isConnecting = sessionState === 'connecting'
  const isConnected = sessionState === 'connected'
  const isError = sessionState === 'error'

  // 音量级别归一化（0-1 → 用于动画）
  const micLevel = Math.min(inputLevel * 8, 1) // 放大显示
  const speakerLevel = Math.min(outputLevel * 8, 1)

  return (
    <div className="absolute inset-0 z-50 flex flex-col bg-gradient-to-b from-surface-800 to-surface-900 text-white">
      {/* 顶部状态栏 */}
      <div className="flex items-center justify-between px-4 py-3">
        <div className="flex items-center gap-2">
          {/* 状态指示灯 */}
          <div
            className={`w-2 h-2 rounded-full ${
              isConnecting
                ? 'bg-yellow-400 animate-pulse'
                : isConnected
                  ? 'bg-green-400'
                  : isError
                    ? 'bg-red-400'
                    : 'bg-surface-400'
            }`}
          />
          <span className="text-xs text-surface-300">
            {isConnecting && '连接中...'}
            {isConnected && '实时对话中'}
            {isError && '连接失败'}
          </span>
        </div>
        <span className="text-xs font-mono text-surface-400">{formatDuration(duration)}</span>
      </div>

      {/* 转录内容区 */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-2 space-y-3">
        {transcripts.length === 0 && isConnected && (
          <div className="flex items-center justify-center h-full">
            <p className="text-surface-400 text-sm">开始说话吧...</p>
          </div>
        )}
        {transcripts.map((item) => (
          <div
            key={item.itemId}
            className={`flex ${item.role === 'user' ? 'justify-end' : 'justify-start'}`}
          >
            <div
              className={`max-w-[85%] rounded-xl px-3 py-2 text-[13px] leading-relaxed ${
                item.role === 'user'
                  ? 'bg-brand-600/80 text-ink-on-accent'
                  : 'bg-surface-700/80 text-surface-100'
              } ${!item.isFinal ? 'opacity-70' : ''}`}
            >
              {item.transcript || (
                <span className="text-surface-400 italic">...</span>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* 底部控制区 */}
      <div className="px-4 py-4 flex flex-col items-center gap-4">
        {/* 声波/音量可视化 */}
        <div className="flex items-center gap-3">
          {/* 麦克风音量 */}
          <div className="flex items-center gap-1.5">
            <Mic className={`w-4 h-4 ${isUserSpeaking ? 'text-brand-400' : 'text-surface-500'}`} />
            <div className="flex items-end gap-[2px] h-4">
              {[0.3, 0.6, 1, 0.7, 0.4].map((weight, i) => (
                <div
                  key={i}
                  className="w-[3px] rounded-full bg-brand-400 transition-all duration-100"
                  style={{
                    height: `${Math.max(3, micLevel * weight * 16)}px`,
                    opacity: isUserSpeaking ? 0.5 + micLevel * weight * 0.5 : 0.2
                  }}
                />
              ))}
            </div>
          </div>

          <div className="w-px h-4 bg-surface-600" />

          {/* 扬声器音量 */}
          <div className="flex items-center gap-1.5">
            <div className="flex items-end gap-[2px] h-4">
              {[0.4, 0.7, 1, 0.6, 0.3].map((weight, i) => (
                <div
                  key={i}
                  className="w-[3px] rounded-full bg-purple-400 transition-all duration-100"
                  style={{
                    height: `${Math.max(3, speakerLevel * weight * 16)}px`,
                    opacity: isAISpeaking ? 0.5 + speakerLevel * weight * 0.5 : 0.2
                  }}
                />
              ))}
            </div>
            <Volume2 className={`w-4 h-4 ${isAISpeaking ? 'text-purple-400' : 'text-surface-500'}`} />
          </div>
        </div>

        {/* 挂断按钮 */}
        <button
          onClick={onHangup}
          className="w-14 h-14 rounded-full bg-red-500 hover:bg-red-600 active:scale-95 transition-all flex items-center justify-center shadow-lg shadow-red-500/30"
        >
          <PhoneOff className="w-6 h-6 text-white" />
        </button>
      </div>
    </div>
  )
}
