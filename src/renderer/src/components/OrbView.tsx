import { useCallback } from 'react'
import { useLocalSTT } from '../hooks/useLocalSTT'
import { useChatStore } from '../stores/chatStore'
import { useAppStore } from '../stores/appStore'

/**
 * OrbView — 悬浮球模式的主视图
 *
 * 渲染条件：useTargetStatus 返回 isFullscreen=true（ClassIn 等应用全屏/最大化时）
 * 窗口尺寸：72×72（由 main 进程 window-tracker calculateOrbBounds 控制）
 * 窗口透明：main 进程 transparent:true + frame:false，方形区域自然透出桌面
 *
 * 状态机（Phase 5）：优先级从高到低
 *   recording    → 红色脉动：正在录音
 *   transcribing → 冷灰蓝：whisper 转写中
 *   thinking     → 品牌深橙 + 快呼吸：AI 正在思考/调工具（chatStore.isStreaming）
 *   error        → 暗红警告
 *   idle         → 品牌橙缓呼吸：待命
 */
type OrbVisualState = 'idle' | 'recording' | 'transcribing' | 'thinking' | 'error'

export function OrbView() {
  const sendMessage = useChatStore((s) => s.sendMessage)
  const isStreaming = useChatStore((s) => s.isStreaming)
  const roleName = useAppStore((s) => s.currentRole?.name || 'learner')

  const onTranscript = useCallback(
    (text: string) => {
      console.log('[OrbView] 转写结果:', text)
      // 直接走现有 chat 管线 — 和键盘输入等价
      sendMessage(text, roleName)
    },
    [sendMessage, roleName]
  )

  const { state: sttState, errorMsg, toggle } = useLocalSTT(onTranscript)

  // 合并多个状态源为单一的视觉状态（优先级：recording > transcribing > error > thinking > idle）
  // thinking 让位给 transcribing——转写进行中即使 isStreaming 也先显示灰色（用户已知还在转写）
  const visual: OrbVisualState =
    sttState === 'recording' ? 'recording' :
    sttState === 'transcribing' ? 'transcribing' :
    sttState === 'error' ? 'error' :
    isStreaming ? 'thinking' : 'idle'

  return (
    <div
      className="h-screen w-screen flex items-center justify-center select-none bg-transparent"
      style={{ WebkitAppRegion: 'drag' } as any}
      title={errorMsg || visual}
    >
      <div
        onClick={toggle}
        className={[
          'relative w-[60px] h-[60px] rounded-full cursor-pointer',
          'transition-all duration-300 hover:scale-110',
          // recording 用 pulse-soft（较快），thinking 用 orb-breathe（较慢）——节奏本身是信息
          visual === 'recording' ? 'animate-pulse-soft' : 'animate-orb-breathe'
        ].join(' ')}
        style={{
          WebkitAppRegion: 'no-drag',
          background: orbGradient(visual),
          boxShadow: orbShadow(visual)
        } as any}
      >
        {/* 球底反光面 */}
        <div
          className="absolute inset-x-3 bottom-1.5 h-3 rounded-full opacity-60 pointer-events-none"
          style={{
            background: 'radial-gradient(ellipse at 50% 100%, rgba(255,255,255,0.55) 0%, transparent 70%)',
            filter: 'blur(2px)'
          }}
        />
      </div>
    </div>
  )
}

/** 不同状态下的径向渐变色 —— 全部落在官方色板内。
 *  orb 是产品里唯一的渐变物件,也是 sage 少数几个正式露面的地方:
 *  待命 = sage(品牌),干活 = clay(agent 活动),等待 = slate(info),
 *  录音/出错 = clay-red(danger)。之前的橙和紫是改版前的遗留,不在色板里。 */
function orbGradient(state: OrbVisualState): string {
  switch (state) {
    case 'recording':
      // danger clay-red：正在录音(紧迫感)
      return 'radial-gradient(circle at 30% 22%, #E8BFAE 0%, #B25A3E 38%, #5E2C18 100%)'
    case 'transcribing':
      // info slate：等待 whisper 返回
      return 'radial-gradient(circle at 30% 22%, #B7C6D1 0%, #5B7388 45%, #26333D 100%)'
    case 'thinking':
      // clay：agent 正在思考/调工具 —— 官方把 agent 活动归给 clay
      return 'radial-gradient(circle at 30% 22%, #EBC8AC 0%, #B26A3F 35%, #4E2814 100%)'
    case 'error':
      // 更深的 clay-red
      return 'radial-gradient(circle at 30% 22%, #DDAF9C 0%, #96432A 50%, #3A180D 100%)'
    case 'idle':
    default:
      // 品牌 sage 待命
      return 'radial-gradient(circle at 30% 22%, #C8D4B0 0%, #A8BB87 22%, #6F864F 60%, #424F30 100%)'
  }
}

/** 不同状态下的外发光 */
function orbShadow(state: OrbVisualState): string {
  const base = [
    '0 0 0 1px rgba(255,255,255,0.32) inset',
    '0 -1px 2px rgba(255,255,255,0.25) inset',
    '0 2px 6px rgba(0,0,0,0.3)'
  ]
  switch (state) {
    case 'recording':
      return [...base, '0 8px 24px rgba(178, 90, 62, 0.55)', '0 0 52px rgba(217, 165, 126, 0.42)'].join(', ')
    case 'transcribing':
      return [...base, '0 8px 24px rgba(91, 115, 136, 0.48)', '0 0 42px rgba(143, 168, 188, 0.32)'].join(', ')
    case 'thinking':
      // clay 光晕——比 sage 醒目,又比 danger 温和
      return [...base, '0 8px 24px rgba(178, 106, 63, 0.55)', '0 0 48px rgba(217, 165, 126, 0.45)'].join(', ')
    case 'error':
      return [...base, '0 8px 24px rgba(150, 67, 42, 0.5)', '0 0 42px rgba(178, 90, 62, 0.35)'].join(', ')
    case 'idle':
    default:
      // 品牌光晕 = sage,和 --glow-brand 同一组值
      return [...base, '0 8px 24px rgba(111, 134, 79, 0.35)', '0 0 42px rgba(111, 134, 79, 0.22)'].join(', ')
  }
}
