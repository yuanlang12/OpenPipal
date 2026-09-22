import { useState, useRef, useEffect } from 'react'
import { ChevronRight, ChevronLeft, ChevronDown, RotateCcw, Zap } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useChatStore } from '../../stores/chatStore'
import { displayModelEntryName, displayModelGroupLabel } from '../../utils/modelDisplay'

/**
 * 模型 + 思考深度合一控件（对话页 InputBar / 欢迎页 / 角色 preflow 三个输入面共用）。
 * 胶囊显示「模型名 · 档位」，点开一张小卡：顶行是当前档位（大字）+ 右上角重置键，
 * 第二行是模型名（点它进模型列表，列表头部可返回），第三行是思考深度滑杆——拖动或点刻度即生效、浮层不关。
 *
 * 三个输入面的模型选择语义不同（对话页与欢迎页会话钉住 / preflow 本地暂存），
 * 通过 onSelectModel 回调注入；思考状态统一走会话配置（thinkingEnabled/thinkingLevel）。
 */

export type ThinkingLevel = 'low' | 'medium' | 'high' | 'max'

/** 认不出模型时的保守档位（与旧行为一致）；真实档位由主进程下发 */
const DEFAULT_LEVELS: ThinkingLevel[] = ['low', 'medium', 'high']

/** 滑杆上的一格：关得掉思考的模型最左多一格 off；调不了深度的模型只有 on 一格 */
type ThinkingStop = 'off' | 'on' | ThinkingLevel

/**
 * 分档滑杆。真正接鼠标和键盘的是一个透明的原生 range（拖、点、方向键都白得），上面盖的轨道 / 填充 / 刻度 / 滑块只管画。
 * 原生滑块宽度在 openpipal-ds.css 的 .sw-range 里钉成和这里同一个 THUMB——两边几何对不上，点哪儿和停哪儿就会差半格。
 */
const THUMB = 28
function StepSlider({ count, index, label, valueText, onChange }: {
  count: number
  index: number
  label: string
  valueText: string
  onChange: (index: number) => void
}) {
  const at = (i: number): string => `calc(${THUMB / 2}px + (100% - ${THUMB}px) * ${i / (count - 1)})`
  return (
    <div className="relative h-7 mt-2.5">
      <input
        type="range" min={0} max={count - 1} step={1} value={index}
        onChange={e => onChange(Number(e.target.value))}
        aria-label={label}
        aria-valuetext={valueText}
        data-testid="thinking-slider"
        className="sw-range peer"
      />
      <div className="pointer-events-none absolute inset-x-0 top-1/2 -translate-y-1/2 h-6 rounded-full bg-surface-100 dark:bg-surface-200" />
      <div
        className="pointer-events-none absolute left-0 top-1/2 -translate-y-1/2 h-6 rounded-full bg-brand-500 transition-[width] duration-150 motion-reduce:transition-none"
        style={{ width: `calc(${THUMB}px + (100% - ${THUMB}px) * ${index / (count - 1)})` }}
      />
      {Array.from({ length: count }, (_, i) => i !== index && (
        <span
          key={i}
          className={`pointer-events-none absolute top-1/2 w-1 h-1 -translate-x-1/2 -translate-y-1/2 rounded-full ${i < index ? 'bg-ink-on-accent opacity-50' : 'bg-surface-300'}`}
          style={{ left: at(i) }}
        />
      ))}
      {/* 滑块与填充永远反色（on-accent 压 accent）：暗色下填充近白，白滑块会化在里面 */}
      <span
        className="pointer-events-none absolute top-1/2 w-7 h-7 -translate-x-1/2 -translate-y-1/2 rounded-full bg-ink-on-accent shadow-md ring-1 ring-black/10 dark:ring-white/20 transition-[left] duration-150 motion-reduce:transition-none peer-focus-visible:ring-2 peer-focus-visible:ring-brand-400"
        style={{ left: at(index) }}
      />
    </div>
  )
}

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
  const [panel, setPanel] = useState<'main' | 'model'>('main')
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
  const stops: ThinkingStop[] = !supportsThinking ? [] : [...(alwaysOn ? [] : ['off' as const]), ...(supportsDial ? levels : ['on' as const])]
  const currentStop: ThinkingStop = !thinkingOn ? 'off' : supportsDial ? thinkingLevel : 'on'
  const applyStop = (stop: ThinkingStop): void => {
    if (stop === 'off' || stop === 'on') setConversationThinking(stop === 'on')
    else setConversationThinkingLevel(stop)
  }
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

  // 不支持思考的模型没有档位可显示，模型名就顶到第一行中间
  const modelRow = (
    <button
      onClick={() => setPanel('model')}
      data-testid="model-control-model-row"
      className="mx-auto justify-self-center flex items-center gap-0.5 max-w-full min-w-0 px-2 py-0.5 rounded-md text-[12px] text-surface-500 hover:text-surface-700 hover:bg-surface-100 transition-colors"
    >
      <span className="truncate">{displayModel}</span>
      <ChevronRight className="w-3 h-3 shrink-0 text-surface-300" />
    </button>
  )

  return (
    <div className={`relative min-w-0 ${className}`} ref={rootRef}>
      {/* 平时不带底色，和左边的 + 一个待遇；高度与工具栏其余控件统一 h-8 */}
      <button
        onClick={() => setOpen(!open)}
        data-testid={triggerTestId}
        title={t('chat.modelControl.title')}
        className={`flex items-center gap-1 h-8 px-2 rounded-lg text-[12px] transition-colors min-w-0 max-w-full text-surface-500 hover:text-surface-700 hover:bg-surface-100 ${
          open ? 'bg-surface-100 text-surface-700' : ''
        }`}
      >
        <span className="max-w-[140px] min-w-0 truncate">{displayModel}</span>
        {thinkingValue && thinkingOn && <span className="shrink-0">· {thinkingValue}</span>}
        <ChevronDown className="w-3 h-3 shrink-0 text-surface-300" />
      </button>

      {open && (
        <div data-testid={menuTestId} className="absolute bottom-full right-0 mb-1 w-[min(18rem,calc(100vw-2rem))] op-menu py-1 z-50 animate-fade-in">
          {notice && panel === 'main' && (
            <div className="px-3 py-1.5 text-[11px] text-amber-600 dark:text-amber-400 border-b border-surface-100">{notice}</div>
          )}

          {panel === 'main' && (
            <div className="px-3 pt-2 pb-2.5">
              <div className="grid grid-cols-[1.5rem_minmax(0,1fr)_1.5rem] items-center">
                {supportsThinking
                  ? <Zap className={`w-3.5 h-3.5 ${thinkingOn ? 'text-brand-600 dark:text-brand-400' : 'text-surface-300'}`} fill="currentColor" />
                  : <span />}
                {supportsThinking
                  ? <span data-testid="model-control-level" className={`text-center text-[15px] font-medium ${thinkingOn ? 'text-brand-600 dark:text-brand-400' : 'text-surface-400'}`}>{thinkingValue}</span>
                  : modelRow}
                {resetRow ? (
                  <button
                    onClick={() => { onSelectModel(null); setOpen(false) }}
                    data-testid="model-control-reset"
                    title={resetRow.label}
                    aria-label={resetRow.label}
                    className="justify-self-end w-6 h-6 rounded-md flex items-center justify-center text-surface-400 hover:text-surface-600 hover:bg-surface-100 transition-colors"
                  >
                    <RotateCcw className="w-3.5 h-3.5" />
                  </button>
                ) : <span />}
              </div>
              {supportsThinking && modelRow}
              {stops.length > 1 && (
                <StepSlider
                  count={stops.length}
                  index={Math.max(0, stops.indexOf(currentStop))}
                  label={t('chat.modelControl.thinkingDepth')}
                  valueText={thinkingValue}
                  onChange={i => applyStop(stops[i])}
                />
              )}
            </div>
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
        </div>
      )}
    </div>
  )
}
