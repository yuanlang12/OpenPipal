import { useState, useRef, useEffect } from 'react'
import { ChevronRight, ChevronLeft, RotateCcw } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useChatStore } from '../../stores/chatStore'
import { displayModelEntryName, displayModelGroupLabel } from '../../utils/modelDisplay'

/**
 * 模型 + 思考深度合一控件（对话页 InputBar / 欢迎页 / 角色 preflow 三个输入面共用）。
 * 胶囊显示「模型名 · 档位」，点开两级菜单：主面板是"模型/思考深度"两行（右侧带当前值），
 * 点行进入子面板选择（子面板头部可返回）——对齐 Claude 客户端的合并控件形态。
 *
 * 三个输入面的模型选择语义不同（对话页与欢迎页会话钉住 / preflow 本地暂存），
 * 通过 onSelectModel 回调注入；思考状态统一走会话配置（thinkingEnabled/thinkingLevel）。
 */

export type ThinkingLevel = 'low' | 'medium' | 'high' | 'max'

/** 认不出模型时的保守档位（与旧行为一致）；真实档位由主进程下发 */
const DEFAULT_LEVELS: ThinkingLevel[] = ['low', 'medium', 'high']

export interface ModelControlItem {
  id: string
  name: string
  model: string
  active: boolean
  supportsThinking?: boolean
  supportsEffortDial?: boolean
  thinkingAlwaysOn?: boolean
  thinkingLevels?: ThinkingLevel[]
  providerName?: string
  builtin?: boolean
}

export function ModelControl({
  models,
  displayModel,
  supportsThinking,
  supportsDial,
  alwaysOn = false,
  levels = DEFAULT_LEVELS,
  selectedId,
  resetRow,
  notice,
  onSelectModel,
  className = '',
  triggerTestId,
  menuTestId
}: {
  models: ModelControlItem[]
  /** 胶囊上显示的模型名（各输入面自己算：会话专属/全局/本地暂存） */
  displayModel: string
  supportsThinking: boolean
  supportsDial: boolean
  /** 思考关不掉（GLM-5.3、grok-4 系）：不画"不思考"那一行，胶囊上也不显示"关" */
  alwaysOn?: boolean
  /** 这个模型真正有哪几档（主进程按 Pi 档位表算）。缺省三档 = 改动前的行为 */
  levels?: ThinkingLevel[]
  /** 模型子面板里打 ✓ 的目标；null/undefined 时回落各项的 active（全局默认） */
  selectedId?: string | null
  /** 主面板底部的重置行（如对话页"跟随全局默认"）；点击回调 onSelectModel(null) */
  resetRow?: { label: string } | null
  /** 菜单顶部提示条（如"专属预设已删除，已回退全局默认"） */
  notice?: string
  onSelectModel: (id: string | null) => void
  className?: string
  /** e2e 测试锚点（preflow 面板沿用既有 testid 约定） */
  triggerTestId?: string
  menuTestId?: string
}) {
  const { t } = useTranslation()
  const conversationConfig = useChatStore(s => s.conversationConfig)
  const setConversationThinking = useChatStore(s => s.setConversationThinking)
  const setConversationThinkingLevel = useChatStore(s => s.setConversationThinkingLevel)
  const [open, setOpen] = useState(false)
  const [panel, setPanel] = useState<'main' | 'model' | 'thinking'>('main')
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])
  useEffect(() => { if (!open) setPanel('main') }, [open])

  // 关不掉思考的模型上，会话里存的那个"关"不算数——请求侧已由 resolveThinkingOffLevel
  // 落到最低档，界面这边同步显示成"开着"，免得写着关、气泡照冒。
  const thinkingOn = alwaysOn || conversationConfig?.thinkingEnabled !== false
  const stored = conversationConfig?.thinkingLevel || 'low'
  // 换模型后旧档位可能不在新模型的清单里（比如从有"中"的模型换到 GLM-5.3）——
  // 显示上落到清单里最接近的一档，发请求那侧由 Pi 的 clampThinkingLevel 兜同一件事。
  const thinkingLevel = levels.includes(stored) ? stored : (levels[0] || 'low')
  const thinkingValue = !supportsThinking
    ? ''
    : !thinkingOn
      ? t('chat.modelControl.states.off')
      : supportsDial
        ? t(`chat.modelControl.levels.${thinkingLevel}`)
        : t('chat.modelControl.states.on')
  const modelGroups = Array.from(new Set(models.map(model => model.providerName || '')))

  const itemCls = (selected: boolean) =>
    `w-full text-left px-3 py-1.5 text-[12px] flex items-center gap-2 transition-colors ${
      selected ? 'text-brand-600 dark:text-brand-400 bg-brand-50 dark:bg-brand-900/20' : 'text-surface-600 hover:bg-surface-50'
    }`

  const backRow = (title: string) => (
    <button onClick={() => setPanel('main')} className="w-full text-left px-3 py-1.5 text-[11px] flex items-center gap-1 text-surface-400 hover:text-surface-600 border-b border-surface-100">
      <ChevronLeft className="w-3 h-3" />
      {title}
    </button>
  )

  return (
    <div className={`relative min-w-0 ${className}`} ref={rootRef}>
      <button
        onClick={() => setOpen(!open)}
        data-testid={triggerTestId}
        title={t('chat.modelControl.title')}
        className={`flex items-center gap-1 px-2 py-1 rounded-md text-[11px] transition-colors min-w-0 max-w-full ${
          supportsThinking && thinkingOn
            ? 'text-brand-600 dark:text-brand-400 bg-brand-50 dark:bg-brand-900/20 hover:bg-brand-100 dark:hover:bg-brand-900/30'
            : 'text-surface-400 hover:text-surface-600'
        }`}
      >
        <span className="max-w-[140px] min-w-0 truncate">{displayModel}</span>
        {thinkingValue && thinkingOn && <span className="shrink-0">· {thinkingValue}</span>}
      </button>

      {open && (
        <div data-testid={menuTestId} className="absolute bottom-full right-0 mb-1 w-[min(18rem,calc(100vw-2rem))] op-menu py-1 z-50 animate-fade-in">
          {notice && panel === 'main' && (
            <div className="px-3 py-1.5 text-[11px] text-amber-600 dark:text-amber-400 border-b border-surface-100">{notice}</div>
          )}

          {panel === 'main' && (
            <>
              <button onClick={() => setPanel('model')} className={itemCls(false)}>
                <span className="shrink-0">{t('chat.modelControl.model')}</span>
                <span className="flex-1 text-right text-surface-400 truncate">{displayModel}</span>
                <ChevronRight className="w-3 h-3 shrink-0 text-surface-300" />
              </button>
              {supportsThinking && !(alwaysOn && !supportsDial) && (
                <button onClick={() => setPanel('thinking')} className={itemCls(false)}>
                  <span className="shrink-0">{t('chat.modelControl.thinkingDepth')}</span>
                  <span className="flex-1 text-right text-surface-400">{thinkingValue}</span>
                  <ChevronRight className="w-3 h-3 shrink-0 text-surface-300" />
                </button>
              )}
              {resetRow && (
                <button
                  onClick={() => { onSelectModel(null); setOpen(false) }}
                  className="w-full text-left px-3 py-1.5 text-[12px] flex items-center gap-2 text-surface-500 hover:bg-surface-50 border-t border-surface-100 mt-1 pt-2"
                >
                  <RotateCcw className="w-3 h-3 shrink-0" />
                  <span className="flex-1 truncate">{resetRow.label}</span>
                </button>
              )}
            </>
          )}

          {panel === 'model' && (
            <div className="max-h-72 overflow-y-auto">
              {backRow(t('chat.modelControl.model'))}
              {modelGroups.map(group => {
                const groupIsBuiltin = models.find(m => (m.providerName || '') === group)?.builtin
                return (
                  <div key={group || '__ungrouped__'}>
                    <div className="px-3 pt-1.5 pb-0.5 text-[10px] text-surface-400 select-none break-words">{displayModelGroupLabel(group, groupIsBuiltin, t)}</div>
                    {models.filter(m => (m.providerName || '') === group).map(m => {
                      const selected = selectedId ? m.id === selectedId : m.active
                      return (
                        <button key={m.id} onClick={() => { onSelectModel(m.id); setOpen(false) }} className={`${itemCls(selected)} pl-5`}>
                          <span className="truncate flex-1">{displayModelEntryName(m, t)}</span>
                          {m.active && <span className="text-[10px] text-surface-400 shrink-0">{t('chat.modelControl.globalDefault')}</span>}
                          {selected && <span className="text-brand-500 shrink-0">✓</span>}
                        </button>
                      )
                    })}
                  </div>
                )
              })}
            </div>
          )}

          {panel === 'thinking' && (
            <>
              {backRow(t('chat.modelControl.thinkingDepth'))}
              {!alwaysOn && (
                <button onClick={() => { setConversationThinking(false); setOpen(false) }} className={itemCls(!thinkingOn)}>
                  <span className="flex-1">{t('chat.modelControl.noThinking')}</span>
                  {!thinkingOn && <span className="text-brand-500 shrink-0">✓</span>}
                </button>
              )}
              {supportsDial ? (
                levels.map(level => (
                  <button key={level} onClick={() => { setConversationThinkingLevel(level); setOpen(false) }} className={itemCls(thinkingOn && thinkingLevel === level)}>
                    <span className="flex-1">{t(`chat.modelControl.levels.${level}`)}</span>
                    {thinkingOn && thinkingLevel === level && <span className="text-brand-500 shrink-0">✓</span>}
                  </button>
                ))
              ) : (
                <button onClick={() => { setConversationThinking(true); setOpen(false) }} className={itemCls(thinkingOn)}>
                  <span className="flex-1">{t('chat.modelControl.enableThinking')}</span>
                  {thinkingOn && <span className="text-brand-500 shrink-0">✓</span>}
                </button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}
