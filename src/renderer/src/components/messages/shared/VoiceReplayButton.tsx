import { useState, useRef } from 'react'
import { Play, Loader2, Square } from 'lucide-react'
import { useTranslation } from 'react-i18next'

// 全局单例:同一时刻只允许一个回放在播。新回放开始前先停掉上一个。
let activeStop: (() => void) | null = null

/**
 * 回听某段语音 —— 从磁盘读回 WAV(voice:read-audio),转 Blob 用 <audio> 播。
 * idle ▶ → loading ⟳ → playing ◼(再点停)。播完自动回 idle。
 */
export function VoiceReplayButton({ audioPath }: { audioPath: string }): JSX.Element {
  const { t } = useTranslation()
  const [state, setState] = useState<'idle' | 'loading' | 'playing'>('idle')
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const urlRef = useRef<string | null>(null)

  const cleanup = (): void => {
    if (audioRef.current) {
      audioRef.current.onended = null
      audioRef.current.pause()
      audioRef.current = null
    }
    if (urlRef.current) {
      URL.revokeObjectURL(urlRef.current)
      urlRef.current = null
    }
  }

  const handleClick = async (): Promise<void> => {
    if (state === 'playing') {
      cleanup(); setState('idle'); activeStop = null
      return
    }
    if (state === 'loading') return
    setState('loading')
    const r = await window.api.readVoiceAudio?.(audioPath)
    if (!r?.base64) { setState('idle'); return }
    // 开播前先停掉其它正在播的回放(全局只允许一个)
    if (activeStop) { activeStop(); activeStop = null }
    const bytes = Uint8Array.from(atob(r.base64), (c) => c.charCodeAt(0))
    const url = URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }))
    urlRef.current = url
    const audio = new Audio(url)
    audioRef.current = audio
    const stop = (): void => { cleanup(); setState('idle') }
    activeStop = stop
    audio.onended = () => { stop(); if (activeStop === stop) activeStop = null }
    audio.onerror = () => { stop(); if (activeStop === stop) activeStop = null }
    try {
      await audio.play()
      setState('playing')
    } catch {
      stop()
      if (activeStop === stop) activeStop = null
    }
  }

  return (
    <button
      onClick={handleClick}
      className="flex items-center gap-1 text-chat-meta text-surface-400 hover:text-brand-600 dark:hover:text-brand-400 transition-colors px-1.5 py-0.5 rounded hover:bg-brand-50 dark:hover:bg-brand-900/30"
      data-testid="voice-replay-btn"
      title={t('chat.voiceReplay.title')}
    >
      {state === 'loading' ? (
        <Loader2 className="w-3 h-3 animate-spin" />
      ) : state === 'playing' ? (
        <Square className="w-3 h-3" />
      ) : (
        <Play className="w-3 h-3" />
      )}
      <span>{t('chat.voiceReplay.action')}</span>
    </button>
  )
}
