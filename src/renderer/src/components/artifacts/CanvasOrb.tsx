import { useEffect, useRef, useState } from 'react'
import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'
import type { CanvasEngine } from '../../utils/canvasEngine'
import { useChatStore } from '../../stores/chatStore'
import { useAppStore } from '../../stores/appStore'
import { exportCanvasSnapshot } from '../../utils/canvasSnapshot'

/**
 * CanvasOrb (N4):画布右下角"AI 状态点 + 主动求助"双职能组件。
 *
 * 默认态:8px 灰圆 + 慢呼吸——低存在感,符合文档 3.4.1 设计("AI 状态指示点")。
 * 点击后:展开 3 个芯片按钮(让我看看 / 给我一点想法 / 我做得对吗)。
 * 点击芯片:发送可见 user 消息 + 当前画布快照 → AI 走正常 chat 路径回复反向问题。
 *
 * 与 useCaveStateMachine 的被动观察互补:Orb 是学生主动权的兜底——
 * 即便 AI 判断失误错过了卡顿,学生也能随时召唤 AI 出来说一句话。
 *
 * 不复用桌面端 OrbView.tsx,因为那是 Electron 透明窗口形态;
 * 这里是嵌入在画布右下角的 DOM 元素,定位/事件模型完全不同。
 */

interface CanvasOrbProps {
  getEngine: () => CanvasEngine | null
}

const CHIP_IDS = ['look', 'idea', 'check'] as const

export function getCanvasOrbCommands(t: TFunction): Array<{ id: string; label: string; message: string }> {
  return CHIP_IDS.map(id => ({
    id,
    label: t(`artifacts.canvasOrb.commands.${id}.label`),
    message: t(`artifacts.canvasOrb.commands.${id}.message`),
  }))
}

export function CanvasOrb({ getEngine }: CanvasOrbProps): JSX.Element {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const roleName = useAppStore(s => s.currentRole?.name || 'learner')
  const sendMessage = useChatStore(s => s.sendMessage)
  const isStreaming = useChatStore(s => s.isStreaming)
  const commands = getCanvasOrbCommands(t)

  // 点击容器外区域 → 收起芯片
  useEffect(() => {
    if (!expanded) return
    const onClick = (e: MouseEvent): void => {
      if (!containerRef.current?.contains(e.target as Node)) setExpanded(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [expanded])

  const handleChip = async (message: string): Promise<void> => {
    setExpanded(false)
    if (isStreaming) return  // AI 正在响应中不重复发起
    const engine = getEngine()
    const imageBase64 = engine ? await exportCanvasSnapshot(engine) : null
    void sendMessage(
      message,
      roleName,
      imageBase64 ? [imageBase64] : undefined
      // 注意:不传 messageKind → 默认 'user',走可见 chat 路径(与 task-trigger 观察消息相反)
    )
  }

  return (
    <div
      ref={containerRef}
      className="pointer-events-none absolute inset-x-5 bottom-20 z-[60] flex flex-col-reverse items-end gap-2"
    >
      {expanded && (
        <div id="canvas-orb-commands" className="pointer-events-auto flex max-w-full flex-wrap justify-end gap-1.5">
          {commands.map(command => (
            <button
              type="button"
              key={command.id}
              onClick={() => handleChip(command.message)}
              disabled={isStreaming}
              className="max-w-full break-words px-3 py-1.5 rounded-full bg-white dark:bg-surface-50 shadow-md hover:bg-surface-50 disabled:opacity-50 disabled:cursor-not-allowed text-xs text-surface-700 border border-surface-200 transition-colors"
            >
              {command.label}
            </button>
          ))}
        </div>
      )}
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="pointer-events-auto group flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-full transition-colors hover:bg-surface-100"
        title={t('artifacts.canvasOrb.openTitle')}
        aria-label={t('artifacts.canvasOrb.helpLabel')}
        aria-expanded={expanded}
        aria-controls="canvas-orb-commands"
      >
        <span className="h-2 w-2 rounded-full bg-surface-400 group-hover:bg-surface-600 animate-pulse transition-colors" />
      </button>
    </div>
  )
}
