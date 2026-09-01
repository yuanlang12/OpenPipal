import { useEffect, useRef, useState } from 'react'
import { Eye, ShieldCheck, Unlock } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useChatStore } from '../../stores/chatStore'

/**
 * 权限档位控件 —— 只在编码助手的输入框里出现。
 *
 * 为什么不做成全局设置：日常用户（老师、学生）不该被逼着理解"工具风险分级"这个概念，
 * 而写代码的人本来就在按任务切粒度——查个 bug 用只读，重构一整块用完全允许。
 * 所以它跟着会话走、不跨会话继承（换个话题重新从"自动审核"开始）。
 *
 * 胶囊常驻显示当前档位：这是个会改变 agent 能干什么的开关，藏起来等于没有。
 * 真正的收窄发生在主进程（工具 schema + 授权层，见 pi-security.ts），这里只是选择器——
 * 界面被绕过也不影响安全，反过来界面也不能替用户放宽主进程拦住的东西。
 */

export type PermissionTier = 'readonly' | 'auto' | 'full'

const TIERS: Array<{ id: PermissionTier; Icon: typeof Eye }> = [
  { id: 'readonly', Icon: Eye },
  { id: 'auto', Icon: ShieldCheck },
  { id: 'full', Icon: Unlock }
]

/** 默认档（auto）保持安静；两个非默认档要看得见——尤其"完全允许"是放宽，用琥珀色提醒 */
const TRIGGER_CLS: Record<PermissionTier, string> = {
  // surface 令牌自己管明暗（暗色下阶不翻转，写 dark:*-surface-700 会刷出正文色）
  readonly: 'text-surface-600 bg-surface-100 hover:bg-surface-200',
  auto: 'text-surface-400 hover:text-surface-600',
  full: 'text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/20 hover:bg-amber-100 dark:hover:bg-amber-900/30'
}

export function PermissionTierControl({ className = '' }: { className?: string }) {
  const { t } = useTranslation()
  const conversationConfig = useChatStore(s => s.conversationConfig)
  const setTier = useChatStore(s => s.setConversationPermissionTier)
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  const current: PermissionTier = conversationConfig?.permissionTier || 'auto'
  const CurrentIcon = TIERS.find(x => x.id === current)!.Icon

  return (
    <div className={`relative min-w-0 ${className}`} ref={rootRef}>
      <button
        onClick={() => setOpen(!open)}
        data-testid="permission-tier-trigger"
        title={t('chat.permissionTier.title')}
        className={`flex items-center gap-1 px-2 py-1 rounded-md text-[11px] transition-colors min-w-0 max-w-full ${TRIGGER_CLS[current]}`}
      >
        <CurrentIcon className="w-3 h-3 shrink-0" />
        <span className="truncate">{t(`chat.permissionTier.tiers.${current}.label`)}</span>
      </button>

      {open && (
        <div
          data-testid="permission-tier-menu"
          // data-floating-open：告诉祖先"这里挂了一个向上弹的浮层，请抬高层叠顺序"。
          // WorkingDirBar 认的是这个标记，不是 testid——测试属性被改名不该动到界面。
          // 以后 trailing 里再放别的浮层（模型选择、分支选择），照挂这个属性即可。
          data-floating-open
          className="absolute bottom-full right-0 mb-1 w-[min(17rem,calc(100vw-2rem))] op-menu py-1 z-50 animate-fade-in"
        >
          <div className="px-3 pt-1.5 pb-1 text-[10px] text-surface-400 select-none">{t('chat.permissionTier.title')}</div>
          {TIERS.map(({ id, Icon }) => {
            const selected = id === current
            return (
              <button
                key={id}
                data-testid={`permission-tier-${id}`}
                onClick={() => { setTier(id); setOpen(false) }}
                className={`w-full text-left px-3 py-1.5 flex items-start gap-2 transition-colors ${
                  selected ? 'bg-brand-50 dark:bg-brand-900/20' : 'hover:bg-surface-50'
                }`}
              >
                <Icon className={`w-3.5 h-3.5 mt-0.5 shrink-0 ${selected ? 'text-brand-600 dark:text-brand-400' : 'text-surface-400'}`} />
                <span className="flex-1 min-w-0">
                  <span className={`block text-[12px] ${selected ? 'text-brand-600 dark:text-brand-400' : 'text-surface-600'}`}>
                    {t(`chat.permissionTier.tiers.${id}.label`)}
                  </span>
                  {/* 说明常驻而不是 hover 才出：这三档的差别是"它能不能动我的文件"，
                      靠名字猜不出来，猜错的代价又不对称 */}
                  <span className="block text-[10px] leading-snug text-surface-400 mt-0.5">
                    {t(`chat.permissionTier.tiers.${id}.desc`)}
                  </span>
                </span>
                {selected && <span className="text-brand-500 shrink-0 text-[11px] mt-0.5">✓</span>}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
