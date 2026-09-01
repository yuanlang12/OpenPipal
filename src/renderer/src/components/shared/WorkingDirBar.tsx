import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { BookOpenCheck, FolderOpen, History, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useChatStore } from '../../stores/chatStore'

/** 工作目录里被识别到的项目入口文档（AGENTS.md / CLAUDE.md）；越靠后越具体 */
interface ProjectRule {
  path: string
  truncated: boolean
}

interface WorkingDirBarProps {
  /** 贴在输入框的哪一边：欢迎页输入框在中间偏上，贴底；对话页输入框停在底部，贴顶 */
  placement: 'above' | 'below'
  /** 对齐输入框用：调用方把输入框那侧的宽度约束与左内边距原样传进来 */
  className?: string
  /**
   * 挂在目录名右边的东西（前置页拿它挂权限档位）。
   * 对话页不传——那边档位在输入框工具条上，两处都画就成了同一个开关的两个入口。
   */
  trailing?: ReactNode
  /**
   * 列出最近用过的目录。只有前置页需要：那一页的问题就是"在哪个仓库里干活"，
   * 而答案九成是上次那几个之一。对话页已经在干活了，再列一遍只是噪音。
   */
  recents?: boolean
}

/** 只留最后两层父目录：路径尾巴才是信息量，头部截断会把仓库名截掉 */
function shortParent(dir: string): string {
  const segs = dir.split('/').filter(Boolean).slice(0, -1)
  return segs.length > 2 ? `…/${segs.slice(-2).join('/')}` : `/${segs.join('/')}`
}

/**
 * 工作目录条 —— 一小片贴着输入框边缘的标签，像从输入框底下抽出来的一角。
 *
 * 两个页面输入框位置不同（欢迎页居中、对话页停底），但"在哪个目录里对话"是同一件事，
 * 所以 UI 和行为只有这一份；placement 只决定往哪边贴、哪两个角是圆的。
 * 靠负外边距压进输入框 8px + 调用方给输入框 z-10，让它读起来是被压在下面而不是并排。
 */
export function WorkingDirBar({ placement, className = '', trailing, recents }: WorkingDirBarProps): JSX.Element {
  const { t } = useTranslation()
  const workingDir = useChatStore(s => s.conversationConfig?.workingDir || '')
  const setConversationWorkingDir = useChatStore(s => s.setConversationWorkingDir)
  const conversations = useChatStore(s => s.conversations)
  const [rejected, setRejected] = useState<string | null>(null)
  // 这个目录里有没有 AGENTS.md / CLAUDE.md。不给信号的话，"助手知不知道这个项目的规矩"
  // 对用户完全不可见——它表现变了，用户不知道为什么变。
  const [projectRules, setProjectRules] = useState<ProjectRule[]>([])

  useEffect(() => {
    if (!workingDir) {
      setProjectRules([])
      return
    }
    let stale = false
    void window.api.describeProjectContext?.(workingDir).then((summary: { files?: ProjectRule[] }) => {
      if (!stale) setProjectRules(summary?.files ?? [])
    }).catch(() => {
      if (!stale) setProjectRules([])
    })
    return () => { stale = true }
  }, [workingDir])

  /**
   * 只校验、不落全局配置：这里定的是"这条会话在哪个目录里干活"。
   * 不校验的话用户能选中一个安全层不放行的目录，界面照常显示，然后每个
   * 文件工具都被硬拒且无声——那正是这条的来由。最近列表走同一条路：
   * 那些目录可能已经被删了、移走了，或者今天已经不在允许根里。
   */
  const applyDir = async (dir: string): Promise<void> => {
    const verdict = await window.api.validateWorkingDir?.(dir)
    if (verdict && !verdict.ok) {
      setRejected(
        t(`settings.apps.workingDirectory.rejected.${verdict.code || 'unknown'}`, {
          path: verdict.resolved || dir,
          defaultValue: verdict.reason || ''
        })
      )
      return
    }
    setRejected(null)
    setConversationWorkingDir(dir)
  }

  const pick = async (): Promise<void> => {
    const dir = await window.api.selectDirectory?.()
    if (dir) await applyDir(dir)
  }

  // 最近目录从已有会话里推导：listConversations 本来就按 updatedAt 降序、
  // 且 summary 自带 config。不另建"最近列表"存储——那会多一份要维护、要清理、
  // 还会和会话删除对不上的状态。
  const recentDirs = useMemo(() => {
    if (!recents) return []
    const seen = new Set<string>()
    const out: string[] = []
    for (const conv of conversations) {
      const dir = conv.config?.workingDir
      if (!dir || dir === workingDir || seen.has(dir)) continue
      seen.add(dir)
      out.push(dir)
      if (out.length === 5) break
    }
    return out
  }, [recents, conversations, workingDir])

  const above = placement === 'above'
  const label = workingDir ? workingDir.split('/').pop() || workingDir : t('chat.input.chooseWorkingDirectory')
  const ruleNames = projectRules.map(f => f.path.split('/').pop() || f.path)
  // 多份时只报最具体的那一份（离工作目录最近的在最后），完整清单进 tooltip
  const primaryRule = ruleNames.length ? ruleNames[ruleNames.length - 1] : ''
  const ruleHint = [
    t('chat.input.projectRulesLoadedHint', { names: ruleNames.join(' + ') }),
    ...projectRules
      .filter(f => f.truncated)
      .map(f => t('chat.input.projectRulesTruncated', { name: f.path.split('/').pop() || f.path })),
    ...projectRules.map(f => f.path)
  ].join('\n')

  return (
    // px-3：比输入框窄一点，露出来的那一层才看得出是压在下面的另一块。
    //
    // z 分两态，别改成常驻高层：
    //   **静止时 z-0** —— 这一条刻意用 `-mb-2.5`/`-mt-2.5` 塞进输入框底下 10px，底色更深、
    //     压进去那一边不做圆角，全靠被输入框盖住才成立（`glass.css` 那段注释写了这个意图）。
    //     常驻 z-20 会让它的不透明底色和阴影反过来盖住输入框边缘，三个挂载点一起变丑，
    //     而其中只有编码前置页需要抬高——2026-08-28 第一版就是这么写的，评审逮到。
    //   **菜单打开时 z-20** —— 权限档位菜单是 `absolute bottom-full` 向上弹，而输入框卡片是
    //     `relative z-10`。z-index 只在同一个层叠上下文里比较：菜单那个 `z-50` 只跟本组件内部
    //     的兄弟比，到了父层是本组件对上输入框，于是**菜单被输入框整个盖住**，用户只看得见
    //     最上面一档（真机截图报的就是这个）。`has-[]` 只在浮层真的挂上来时抬，静止态不受影响。
    //     认的是 `data-floating-open`（浮层自己挂的语义标记），不是 testid——测试属性改个名
    //     就让界面回退到被盖住的样子，那种耦合看不见也测不出来。
    <div className={`relative z-0 has-[[data-floating-open]]:z-20 flex flex-col px-3 ${className}`}>
      <div
        data-testid="working-dir-bar"
        className={`op-dir-bar flex flex-1 min-w-0 items-center ${
          above ? 'rounded-t-lg pt-1.5 pb-4 -mb-2.5' : 'rounded-b-lg pb-1.5 pt-4 -mt-2.5'
        }`}
      >
        <button
          onClick={pick}
          title={workingDir || t('chat.input.chooseWorkingDirectory')}
          // min-w：这一排最多能挂四样（目录名 / 已读徽标 / 权限档位 / 清除），窄窗下总有东西要被截。
          // 目录名截成"che…"什么信息都不剩，徽标截成"已读…"照样读得懂——所以给目录名留个下限，
          // 让徽标先让位。
          className="flex flex-1 min-w-[8rem] items-center gap-1.5 px-3 text-left text-[11px] text-surface-500 hover:text-surface-700 transition-colors"
        >
          <FolderOpen className="w-3.5 h-3.5 shrink-0" />
          <span className="truncate">{label}</span>
        </button>
        {primaryRule && (
          <span
            data-testid="working-dir-project-rules"
            title={ruleHint}
            className="flex min-w-0 shrink items-center gap-1 pl-1 text-[11px] text-surface-400"
          >
            <BookOpenCheck className="w-3 h-3 shrink-0" />
            <span className="truncate max-w-[9rem]">
              {t('chat.input.projectRulesLoaded', { name: primaryRule })}
            </span>
          </span>
        )}
        {trailing && <span className="shrink-0 pl-1">{trailing}</span>}
        {workingDir && (
          <button
            data-testid="working-dir-clear"
            onClick={() => { setRejected(null); setConversationWorkingDir('') }}
            aria-label={t('welcome.input.removeDirectory')}
            className="pl-1 pr-3 text-surface-300 hover:text-surface-600 transition-colors"
          >
            <X className="w-3 h-3" />
          </button>
        )}
      </div>
      {rejected && (
        // 必须在文档流里：绝对定位会压在滚过它的消息流上（InputBar 那层是 z-10，
        // 消息从这条下面滚过去），两层文字叠印，用户反而看不清为什么被拒。
        <p
          role="alert"
          data-testid="working-dir-rejected"
          className="mt-1 px-3 text-[11px] text-red-500 break-words"
        >
          {rejected}
        </p>
      )}
      {recentDirs.length > 0 && (
        <div data-testid="working-dir-recents" className="mt-3">
          <div className="flex items-center gap-1 px-1 pb-1 text-[10px] text-surface-400 select-none">
            <History className="w-3 h-3 shrink-0" />
            <span>{t('chat.input.recentWorkingDirs')}</span>
          </div>
          <div className="rounded-lg border border-border dark:border-surface-200 overflow-hidden">
            {recentDirs.map(dir => (
              <button
                key={dir}
                onClick={() => { void applyDir(dir) }}
                title={dir}
                data-testid="working-dir-recent-item"
                className="w-full flex items-baseline gap-2 px-3 py-1.5 text-left hover:bg-surface-50 transition-colors border-b border-border/60 dark:border-surface-200/60 last:border-b-0"
              >
                <span className="text-[12px] text-ink-secondary shrink-0">{dir.split('/').pop() || dir}</span>
                <span className="text-[10px] text-surface-400 truncate">{shortParent(dir)}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
