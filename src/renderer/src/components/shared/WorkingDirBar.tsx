import { FolderOpen, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useChatStore } from '../../stores/chatStore'

interface WorkingDirBarProps {
  /** 贴在输入框的哪一边：欢迎页输入框在中间偏上，贴底；对话页输入框停在底部，贴顶 */
  placement: 'above' | 'below'
  /** 对齐输入框用：调用方把输入框那侧的宽度约束与左内边距原样传进来 */
  className?: string
}

/**
 * 工作目录条 —— 一小片贴着输入框边缘的标签，像从输入框底下抽出来的一角。
 *
 * 两个页面输入框位置不同（欢迎页居中、对话页停底），但"在哪个目录里对话"是同一件事，
 * 所以 UI 和行为只有这一份；placement 只决定往哪边贴、哪两个角是圆的。
 * 靠负外边距压进输入框 8px + 调用方给输入框 z-10，让它读起来是被压在下面而不是并排。
 */
export function WorkingDirBar({ placement, className = '' }: WorkingDirBarProps): JSX.Element {
  const { t } = useTranslation()
  const workingDir = useChatStore(s => s.conversationConfig?.workingDir || '')
  const setConversationWorkingDir = useChatStore(s => s.setConversationWorkingDir)

  const pick = async (): Promise<void> => {
    const dir = await window.api.selectDirectory?.()
    if (dir) setConversationWorkingDir(dir)
  }

  const above = placement === 'above'
  const label = workingDir ? workingDir.split('/').pop() || workingDir : t('chat.input.chooseWorkingDirectory')

  return (
    // px-3：比输入框窄一点，露出来的那一层才看得出是压在下面的另一块
    <div className={`relative z-0 flex px-3 ${className}`}>
      <div
        data-testid="working-dir-bar"
        className={`op-dir-bar flex flex-1 min-w-0 items-center ${
          above ? 'rounded-t-lg pt-1.5 pb-4 -mb-2.5' : 'rounded-b-lg pb-1.5 pt-4 -mt-2.5'
        }`}
      >
        <button
          onClick={pick}
          title={workingDir || t('chat.input.chooseWorkingDirectory')}
          className="flex flex-1 min-w-0 items-center gap-1.5 px-3 text-left text-[11px] text-surface-500 hover:text-surface-700 transition-colors"
        >
          <FolderOpen className="w-3.5 h-3.5 shrink-0" />
          <span className="truncate">{label}</span>
        </button>
        {workingDir && (
          <button
            data-testid="working-dir-clear"
            onClick={() => setConversationWorkingDir('')}
            aria-label={t('welcome.input.removeDirectory')}
            className="pl-1 pr-3 text-surface-300 hover:text-surface-600 transition-colors"
          >
            <X className="w-3 h-3" />
          </button>
        )}
      </div>
    </div>
  )
}
