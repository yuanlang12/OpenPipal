import { useState, useEffect, useRef, useCallback } from 'react'
import { Eye, EyeOff, Check, X, Plus, Trash2, Edit2, Brain, ChevronLeft, ChevronDown } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toDisplayError, renderDisplayError, type DisplayError } from '../utils/mainError'
import { displayModelEntryName } from '../utils/modelDisplay'

interface ThinkingBudgets {
  low: number
  medium: number
  high: number
}

type ThinkingBudgetMode = 'auto' | 'custom' | 'toggle'
type ThinkingBudgetDraft = Record<keyof ThinkingBudgets, string>

const DEFAULT_THINKING_BUDGET_DRAFT: ThinkingBudgetDraft = {
  low: '2048',
  medium: '8192',
  high: '32768'
}

function isThinkingBudgets(value: unknown): value is ThinkingBudgets {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const budgets = value as Record<string, unknown>
  const low = Number(budgets.low)
  const medium = Number(budgets.medium)
  const high = Number(budgets.high)
  return [low, medium, high].every(v => Number.isInteger(v) && v > 0)
    && low <= medium
    && medium <= high
}

function budgetModeOf(value: ThinkingBudgets | null | undefined): ThinkingBudgetMode {
  if (value === null) return 'toggle'
  return isThinkingBudgets(value) ? 'custom' : 'auto'
}

function budgetDraftOf(value: ThinkingBudgets | null | undefined): ThinkingBudgetDraft {
  if (!isThinkingBudgets(value)) return { ...DEFAULT_THINKING_BUDGET_DRAFT }
  return {
    low: String(value.low),
    medium: String(value.medium),
    high: String(value.high)
  }
}

function parseThinkingBudgets(value: ThinkingBudgetDraft): ThinkingBudgets | null {
  const parsed = {
    low: Number(value.low),
    medium: Number(value.medium),
    high: Number(value.high)
  }
  return isThinkingBudgets(parsed) ? parsed : null
}

function thinkingBudgetValue(
  mode: ThinkingBudgetMode,
  draft: ThinkingBudgetDraft
): ThinkingBudgets | null | undefined {
  if (mode === 'auto') return undefined
  if (mode === 'toggle') return null
  return parseThinkingBudgets(draft) || undefined
}

function ThinkingBudgetEditor({
  mode,
  draft,
  onModeChange,
  onDraftChange,
  autoLabelKey,
  testIdPrefix
}: {
  mode: ThinkingBudgetMode
  draft: ThinkingBudgetDraft
  onModeChange: (mode: ThinkingBudgetMode) => void
  onDraftChange: (draft: ThinkingBudgetDraft) => void
  autoLabelKey: string
  testIdPrefix: string
}) {
  const { t } = useTranslation()
  const setValue = (key: keyof ThinkingBudgets, value: string) => {
    onDraftChange({ ...draft, [key]: value })
  }
  const invalid = mode === 'custom' && !parseThinkingBudgets(draft)

  return (
    <div className="space-y-2">
      <select
        value={mode}
        onChange={e => onModeChange(e.target.value as ThinkingBudgetMode)}
        data-testid={`${testIdPrefix}-mode`}
        className="w-full text-[12px] text-surface-700 bg-surface-50 border border-surface-100 rounded-md px-2.5 py-1.5 outline-none focus:border-brand-400 transition-colors"
      >
        <option value="auto">{t(autoLabelKey)}</option>
        <option value="custom">{t('settings.model.thinkingBudget.modes.custom')}</option>
        <option value="toggle">{t('settings.model.thinkingBudget.modes.toggle')}</option>
      </select>
      {mode === 'custom' && (
        <>
          <div className="grid grid-cols-3 gap-2">
            {(['low', 'medium', 'high'] as const).map(level => (
              <label key={level} className="space-y-1">
                <span className="block text-[10px] text-surface-400">
                  {t(`settings.model.thinkingBudget.levels.${level}`)}
                </span>
                <input
                  type="number"
                  min="1"
                  step="1"
                  value={draft[level]}
                  onChange={e => setValue(level, e.target.value)}
                  data-testid={`${testIdPrefix}-${level}`}
                  className="w-full text-[12px] px-2 py-1.5 rounded-md border border-surface-100 bg-surface-0 dark:bg-surface-50 outline-none focus:border-brand-400"
                />
              </label>
            ))}
          </div>
          <p className={`text-[10px] ${invalid ? 'text-red-500' : 'text-surface-400'}`}>
            {invalid
              ? t('settings.model.thinkingBudget.invalid')
              : t('settings.model.thinkingBudget.help')}
          </p>
        </>
      )}
    </div>
  )
}

interface ModelConfig {
  provider: string
  baseUrl: string
  apiKey: string
  model: string
  supportsThinking?: boolean
  /** false = 纯文本模型，历史图片会被降级为占位文本（避免网关 400） */
  supportsImages?: boolean
  /** 模型上下文窗口（token），历史压缩阈值用；不填按 131072 */
  contextWindow?: number
  /**
   * 仅 provider==='custom' 时生效。undefined/'openai'（默认，行为不变）= OpenAI 兼容
   * completions 协议；'anthropic' = 第三方抄 Anthropic Messages 协议（/v1/messages）；
   * 'openai-responses' = 第三方抄 OpenAI Responses API 协议（/v1/responses）。
   */
  apiFormat?: 'openai' | 'anthropic' | 'openai-responses'
  /** OpenAI Chat Completions 下的思考参数方言；GLM 5.x 选择 zai。 */
  thinkingFormat?: 'auto' | 'openai' | 'qwen' | 'deepseek' | 'zai'
  /** undefined=继承/自动；null=仅开关；object=低中高 thinking_budget。 */
  thinkingBudgets?: ThinkingBudgets | null
  /** 评测确认需要时才配置的服务商+模型提示词补丁；当前设置页不直接编辑。 */
  systemPromptAdapter?: string
}

interface ModelPreset {
  id: string
  name: string
  model: string
  active: boolean
  providerId?: string
  providerName?: string
  builtin?: boolean
  supportsThinking?: boolean
  supportsEffortDial?: boolean
}

/** 服务商实体（主进程 listModelProviders 返回：key 已掩码，内置连接信息为空） */
interface ProviderEntity {
  id: string
  name: string
  provider: string
  baseUrl: string
  apiFormat?: 'openai' | 'anthropic' | 'openai-responses'
  thinkingFormat?: 'openai' | 'qwen' | 'deepseek' | 'zai'
  thinkingBudgets?: ThinkingBudgets | null
  builtin?: boolean
  apiKeyMasked: string
  modelCount: number
}

type ConnectionStatus = 'idle' | 'testing' | 'success' | 'error'
type ThinkingTestStatus = 'idle' | 'testing' | 'detected' | 'not_detected' | 'error'
type ContextDetectionState =
  | { kind: 'idle' }
  | { kind: 'testing' }
  | { kind: 'detected'; window: number; source: string }
  | { kind: 'unavailable' }

const PROVIDER_PRESETS: Record<string, { name: string; baseUrl: string; models: string[] }> = {
  openai: { name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo'] },
  deepseek: { name: 'DeepSeek', baseUrl: 'https://api.deepseek.com', models: ['deepseek-chat', 'deepseek-reasoner'] },
  openrouter: { name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', models: ['anthropic/claude-sonnet-4', 'google/gemini-2.5-flash'] },
  siliconflow: { name: 'SiliconFlow', baseUrl: 'https://api.siliconflow.cn/v1', models: ['Qwen/Qwen2.5-72B-Instruct'] },
  zai: { name: 'Z.AI (GLM)', baseUrl: 'https://api.z.ai/api/coding/paas/v4', models: ['glm-5.2', 'glm-5.1', 'glm-5-turbo', 'glm-4.7'] },
  custom: { name: '', baseUrl: '', models: [] }
}

const CONTEXT_WINDOW_PRESETS = [
  { value: 32_768, compact: '32K' },
  { value: 65_536, compact: '64K' },
  { value: 131_072, compact: '128K' },
  { value: 200_000, compact: '200K' },
  { value: 262_144, compact: '256K' },
  { value: 524_288, compact: '512K' },
  { value: 1_000_000, compact: '1M' }
] as const

/** Base URL 里的域名 —— 服务商卡片第一行的默认标识 */
function hostOf(baseUrl: string): string {
  // new URL('localhost:11434/v1') 不抛错但 host 为空(它把 localhost: 当成了 scheme),
  // 所以不能只靠 try/catch —— 必须显式检查解析结果,否则卡片标题会渲染成空白。
  try {
    const host = new URL(baseUrl).host
    if (host) return host
  } catch {
    // 落到下面的兜底
  }
  return baseUrl.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').split('/')[0] || baseUrl
}

/** 第一行主标识:自定义过名字就显示名字,否则显示域名。
 *  内置服务商必须走 displayModelEntryName —— 红线是内置连接信息既不可见也不可改,
 *  这里绝不能退到 hostOf(baseUrl),那等于把内置 Base URL 印在设置页上。 */
function providerLabel(
  prov: { name: string; baseUrl: string; builtin?: boolean },
  t: (key: string, params?: Record<string, unknown>) => string,
  host: string,
  named: boolean
): string {
  const localized = displayModelEntryName(prov, t, 'settings.model.provider.builtinService')
  if (prov.builtin) return localized
  return named ? localized : host
}

/** 名字没改过(等于域名/为空)时就只显示域名,改过才是「名字 + 域名」两段 */
function providerHasCustomName(prov: { name?: string; baseUrl: string; builtin?: boolean }, host: string): boolean {
  if (prov.builtin) return false
  const name = (prov.name || '').trim()
  return name.length > 0 && name !== host && name !== prov.baseUrl
}

function getContextWindowChoice(value: string): string {
  if (!value) return 'default'
  return CONTEXT_WINDOW_PRESETS.some(preset => String(preset.value) === value) ? value : 'custom'
}

export function ModelSettings() {
  const { t, i18n } = useTranslation()
  const [presets, setPresets] = useState<ModelPreset[]>([])
  const [providers, setProviders] = useState<ProviderEntity[]>([])
  const [showForm, setShowForm] = useState(false)
  // 服务商卡片折叠态。默认全收起,只把「当前在用的模型」所在那张卡自动展开 ——
  // 用户进设置最常见的目的是确认/切换现在用的是哪个,而不是通读全部配置。
  const [openProviders, setOpenProviders] = useState<Set<string>>(new Set())
  // 只在首次拿到数据时自动展开一次,之后完全交给用户 —— 否则用户手动收起后,
  // 下一次 presets 变化又会把它顶开。
  const seededOpenRef = useRef(false)
  const toggleProvider = (id: string): void => setOpenProviders(prev => {
    const next = new Set(prev)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })
  const [editingId, setEditingId] = useState<string | null>(null)
  // 服务商编辑（换 key/网关一处生效）：null = 关闭；apiKey 空串 = 保留原 key
  const [editingProvider, setEditingProvider] = useState<{
    id: string
    name: string
    baseUrl: string
    apiKey: string
    apiFormat: string
    thinkingFormat: 'auto' | 'openai' | 'qwen' | 'deepseek' | 'zai'
    thinkingBudgetMode: ThinkingBudgetMode
    thinkingBudgetDraft: ThinkingBudgetDraft
  } | null>(null)

  // 表单状态
  const [provider, setProvider] = useState('custom')
  const [baseUrl, setBaseUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [model, setModel] = useState('')
  const [apiFormat, setApiFormat] = useState<'openai' | 'anthropic' | 'openai-responses'>('openai')
  const [supportsThinking, setSupportsThinking] = useState(false)
  const [thinkingFormat, setThinkingFormat] = useState<'auto' | 'openai' | 'qwen' | 'deepseek' | 'zai'>('auto')
  const [thinkingBudgetMode, setThinkingBudgetMode] = useState<ThinkingBudgetMode>('auto')
  const [thinkingBudgetDraft, setThinkingBudgetDraft] = useState<ThinkingBudgetDraft>({ ...DEFAULT_THINKING_BUDGET_DRAFT })
  const [supportsImages, setSupportsImages] = useState(true)
  // 评测配置字段暂不在普通设置页暴露；编辑其它能力时必须原样保留，不能静默抹掉。
  const [systemPromptAdapter, setSystemPromptAdapter] = useState<string | undefined>()
  const [contextWindow, setContextWindow] = useState('')
  const [contextWindowChoice, setContextWindowChoice] = useState('default')
  const [ctxDetection, setCtxDetection] = useState<ContextDetectionState>({ kind: 'idle' })
  const [showKey, setShowKey] = useState(false)
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('idle')
  const [connectionError, setConnectionError] = useState('')
  const [connectionErrorKey, setConnectionErrorKey] = useState('settings.model.errors.connectionFailed')
  // 后端认定为"本进程自造文案"时才带 errorKey——有值即优先于 connectionError 原文展示
  // （网关原文永远走 connectionError||t(connectionErrorKey) 的既有透传路径，不受影响）
  const [connectionErrorOverride, setConnectionErrorOverride] = useState<{ key: string; params?: Record<string, string> } | null>(null)
  const [autoCorrected, setAutoCorrected] = useState(false)
  const [thinkingStatus, setThinkingStatus] = useState<ThinkingTestStatus>('idle')
  const [thinkingError, setThinkingError] = useState<DisplayError | null>(null)
  const [modelSuggestions, setModelSuggestions] = useState<string[]>([])
  const [showModelDropdown, setShowModelDropdown] = useState(false)
  const qwenThinkingSelected = thinkingFormat === 'qwen' || (thinkingFormat === 'auto' && /qwen/i.test(model))
  // Pi 原生目录已为官方 Token Plan / DashScope 的 Qwen3.8 定义 reasoning_effort。
  // 这类模型不能再套 Qwen3.7 的 token 预算编辑器，避免同一请求发两种协议字段。
  const nativeQwen38 = qwenThinkingSelected
    && /qwen3[._-]8/i.test(model)
    && /(?:token-plan\.(?:cn-beijing|ap-southeast-1)\.maas\.aliyuncs\.com|dashscope(?:-[a-z0-9]+)?\.aliyuncs\.com)/i.test(baseUrl)
  const thinkingBudgetInvalid = !nativeQwen38 && thinkingBudgetMode === 'custom' && !parseThinkingBudgets(thinkingBudgetDraft)

  const modelInputRef = useRef<HTMLInputElement>(null)
  const modelDropdownRef = useRef<HTMLDivElement>(null)

  const loadPresets = useCallback(async () => {
    const models = await window.api.getAvailableModels?.()
    if (models) setPresets(models)
    const provs = await (window.api as any).listModelProviders?.().catch(() => null)
    if (provs) setProviders(provs)
  }, [])

  useEffect(() => { loadPresets() }, [])

  useEffect(() => {
    const preset = PROVIDER_PRESETS[provider]
    if (preset) setModelSuggestions(preset.models)
  }, [provider])

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (modelDropdownRef.current && !modelDropdownRef.current.contains(e.target as Node) &&
          modelInputRef.current && !modelInputRef.current.contains(e.target as Node)) {
        setShowModelDropdown(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  const handleProviderChange = (p: string) => {
    setProvider(p)
    const preset = PROVIDER_PRESETS[p]
    if (preset && p !== 'custom') {
      setBaseUrl(preset.baseUrl)
      if (preset.models.length > 0) setModel(preset.models[0])
    }
    if (p === 'zai') {
      setSupportsThinking(true)
      setThinkingFormat('zai')
      setSupportsImages(false)
    }
    if (p !== 'custom') setApiFormat('openai')  // 字段只对 custom 有意义，切走时归位避免留着脏值
    setConnectionStatus('idle')
  }

  const buildFormModelConfig = (forceThinking?: boolean): ModelConfig => {
    const cw = parseInt(contextWindow, 10)
    const budgets = thinkingBudgetValue(thinkingBudgetMode, thinkingBudgetDraft)
    return {
      provider,
      baseUrl,
      model,
      apiKey,
      supportsThinking: forceThinking ?? supportsThinking,
      thinkingFormat,
      supportsImages,
      ...(!nativeQwen38 && budgets !== undefined ? { thinkingBudgets: budgets } : {}),
      ...(systemPromptAdapter ? { systemPromptAdapter } : {}),
      ...(cw > 0 ? { contextWindow: cw } : {}),
      ...(provider === 'custom' ? { apiFormat } : {})
    }
  }

  const handleTest = async () => {
    setConnectionStatus('testing')
    setConnectionError('')
    setConnectionErrorKey('settings.model.errors.connectionFailed')
    setConnectionErrorOverride(null)
    setAutoCorrected(false)
    const config = buildFormModelConfig()
    const result = await window.api.testConnection(config)
    if (result.ok) {
      setConnectionStatus('success')
      if (result.correctedBaseUrl) {
        setBaseUrl(result.correctedBaseUrl)
        setAutoCorrected(true)
      }
      setTimeout(() => setConnectionStatus(s => s === 'success' ? 'idle' : s), 3000)
    } else {
      setConnectionStatus('error')
      setConnectionError(result.error || '')
      setConnectionErrorOverride(result.errorKey ? { key: result.errorKey, params: result.errorParams } : null)
    }
  }

  const handleTestThinking = async () => {
    setThinkingStatus('testing')
    setThinkingError(null)
    const config = buildFormModelConfig(true)
    const result = await window.api.testThinkingSupport?.(config)
    if (!result) {
      setThinkingStatus('error')
      setThinkingError(null)
      return
    }
    if (result.detected) {
      setThinkingStatus('detected')
      setSupportsThinking(true)  // 检测成功 → 自动勾选
    } else if (result.error) {
      setThinkingStatus('error')
      setThinkingError(toDisplayError(result))
    } else {
      setThinkingStatus('not_detected')
    }
  }

  const handleDetectCtx = async () => {
    setCtxDetection({ kind: 'testing' })
    const r = await window.api.detectContextWindow?.({ provider, baseUrl, model, apiKey }).catch(() => null)
    if (r?.window) {
      const detectedWindow = String(r.window)
      setContextWindow(detectedWindow)
      setContextWindowChoice(getContextWindowChoice(detectedWindow))
      setCtxDetection({ kind: 'detected', window: r.window, source: r.source })
    } else {
      setCtxDetection({ kind: 'unavailable' })
    }
  }

  const handleSave = async () => {
    if (thinkingBudgetInvalid) return
    const config = buildFormModelConfig()
    if (editingId) {
      const name = provider === 'custom' ? model : `${model} (${provider})`
      await window.api.updateModelPreset?.(editingId, name, config)
    } else {
      const result = await window.api.saveModelConfig(config)
      if (result?.ok === false) {
        setConnectionStatus('error')
        setConnectionError(result.error || '')
        setConnectionErrorKey('settings.model.errors.saveUnsupported')
        setConnectionErrorOverride(null)
        return
      }
    }
    await loadPresets()
    setShowForm(false)
    setEditingId(null)
    resetForm()
  }

  const handleEdit = async (id: string) => {
    const preset = await window.api.getModelPresetFull?.(id)
    if (!preset) return
    const rawConfig: ModelConfig = preset.rawConfig || preset.config
    setEditingId(id)
    setProvider(preset.config.provider || 'custom')
    setBaseUrl(preset.config.baseUrl || '')
    setApiKey(preset.config.apiKey || '')
    setModel(preset.config.model || '')
    setSupportsThinking(!!preset.config.supportsThinking)
    setThinkingFormat(rawConfig.thinkingFormat || 'auto')
    setThinkingBudgetMode(budgetModeOf(rawConfig.thinkingBudgets))
    setThinkingBudgetDraft(budgetDraftOf(rawConfig.thinkingBudgets))
    setSystemPromptAdapter(rawConfig.systemPromptAdapter)
    setSupportsImages(preset.config.supportsImages !== false)
    const savedContextWindow = preset.config.contextWindow ? String(preset.config.contextWindow) : ''
    setContextWindow(savedContextWindow)
    setContextWindowChoice(getContextWindowChoice(savedContextWindow))
    setApiFormat(
      preset.config.apiFormat === 'anthropic' || preset.config.apiFormat === 'openai-responses'
        ? preset.config.apiFormat
        : 'openai'
    )
    setCtxDetection({ kind: 'idle' })
    setShowForm(true)
    setConnectionStatus('idle')
    setThinkingStatus('idle')
  }

  const handleSwitch = async (id: string) => {
    await window.api.switchModelPreset?.(id)
    await loadPresets()
  }

  const handleDelete = async (id: string) => {
    await window.api.deleteModelPreset?.(id)
    await loadPresets()
  }

  /** 在既有服务商下添加模型：预填连接字段（主进程返回明文），只填模型级字段即可 */
  const handleAddUnderProvider = async (providerId: string) => {
    const prov = await (window.api as any).getModelProviderFull?.(providerId).catch(() => null)
    if (!prov) return
    resetForm()
    setProvider(prov.provider || 'custom')
    setBaseUrl(prov.baseUrl || '')
    setApiKey(prov.apiKey || '')
    if (prov.apiFormat === 'anthropic' || prov.apiFormat === 'openai-responses') {
      setApiFormat(prov.apiFormat)
    }
    setShowForm(true)
  }

  const handleSaveProvider = async () => {
    if (!editingProvider) return
    const parsedBudgets = thinkingBudgetValue(editingProvider.thinkingBudgetMode, editingProvider.thinkingBudgetDraft)
    if (editingProvider.thinkingBudgetMode === 'custom' && !parsedBudgets) return
    await (window.api as any).updateModelProvider?.(editingProvider.id, {
      name: editingProvider.name,
      baseUrl: editingProvider.baseUrl,
      apiKey: editingProvider.apiKey, // 空串 = 主进程保留原 key
      apiFormat: editingProvider.apiFormat,
      thinkingFormat: editingProvider.thinkingFormat,
      thinkingBudgets: editingProvider.thinkingBudgetMode === 'auto' ? 'auto' : parsedBudgets
    })
    setEditingProvider(null)
    await loadPresets()
  }

  const resetForm = () => {
    setProvider('custom')
    setBaseUrl('')
    setApiKey('')
    setModel('')
    setSupportsThinking(false)
    setThinkingFormat('auto')
    setThinkingBudgetMode('auto')
    setThinkingBudgetDraft({ ...DEFAULT_THINKING_BUDGET_DRAFT })
    setSystemPromptAdapter(undefined)
    setSupportsImages(true)
    setContextWindow('')
    setContextWindowChoice('default')
    setCtxDetection({ kind: 'idle' })
    setApiFormat('openai')
    setShowKey(false)
    setConnectionStatus('idle')
    setConnectionError('')
    setConnectionErrorKey('settings.model.errors.connectionFailed')
    setConnectionErrorOverride(null)
    setThinkingStatus('idle')
    setThinkingError(null)
  }

  // 按服务商分组：服务商实体顺序在前，providerId 悬空的进"未分组"尾部
  useEffect(() => {
    if (seededOpenRef.current) return
    // 数据还没到之前不算用掉这次机会 —— effect 首次运行时 presets 还是空数组,
    // 在那里置位会让唯一一次播种被空跑消耗掉,卡片永远不会自动展开。
    if (presets.length === 0) return
    // 拿到数据后无条件置位:活动模型是「未分组」(providerId 悬空)时若早返回不置位,
    // 「只播种一次」的契约就永远不生效,之后每次 presets 变化都会重新展开用户刚收起的卡。
    seededOpenRef.current = true
    const activeProviderId = presets.find(preset => preset.active)?.providerId
    if (!activeProviderId) return
    setOpenProviders(new Set([activeProviderId]))
  }, [presets])

  const grouped = providers.map(prov => ({ prov, models: presets.filter(p => p.providerId === prov.id) }))
    .filter(g => g.models.length > 0)
  const ungrouped = presets.filter(p => !p.providerId || !providers.some(x => x.id === p.providerId))
  const locale = i18n.resolvedLanguage || i18n.language
  const contextHelp = ctxDetection.kind === 'testing'
    ? t('settings.model.context.detecting')
    : ctxDetection.kind === 'detected'
      ? t('settings.model.context.detected', {
          window: new Intl.NumberFormat(locale).format(ctxDetection.window),
          source: ctxDetection.source,
        })
      : ctxDetection.kind === 'unavailable'
        ? t('settings.model.context.unavailable')
        : t('settings.model.context.help')

  const renderPresetRow = (p: ModelPreset) => (
    <div
      key={p.id}
      className={`flex items-center gap-3 p-3 rounded-lg border transition-colors ${
        p.active
          ? 'border-brand-200 dark:border-brand-700 bg-brand-50 dark:bg-brand-900/20'
          : 'border-surface-100 hover:border-surface-200'
      }`}
    >
      <button
        onClick={() => handleSwitch(p.id)}
        className={`w-4 h-4 rounded-full border-2 shrink-0 transition-colors ${
          p.active ? 'border-brand-500 bg-brand-500' : 'border-surface-300'
        }`}
      >
        {p.active && <Check className="w-3 h-3 text-white" strokeWidth={3} />}
      </button>
      <div className="flex-1 min-w-0">
        <span className="text-[13px] font-medium text-surface-700 block truncate">{displayModelEntryName(p, t, 'settings.model.preset.builtinModel')}</span>
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="text-[11px] text-surface-400 truncate">{displayModelEntryName({ name: p.model, builtin: p.builtin }, t, 'settings.model.preset.builtinModel')}</span>
          {p.supportsThinking && (
            <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-surface-100 text-surface-500 shrink-0">
              {p.supportsEffortDial
                ? t('settings.model.preset.thinkingLevels')
                : t('settings.model.preset.thinkingToggle')}
            </span>
          )}
        </div>
      </div>
      {!p.builtin && (
        <>
          <button
            onClick={() => handleEdit(p.id)}
            data-testid={`edit-model-${p.id}`}
            className="text-surface-300 hover:text-surface-500 transition-colors p-1"
            title={t('settings.model.preset.edit')}
          >
            <Edit2 className="w-3.5 h-3.5" />
          </button>
          <button onClick={() => handleDelete(p.id)} className="text-surface-300 hover:text-red-400 transition-colors p-1" title={t('settings.model.preset.delete')}>
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </>
      )}
    </div>
  )

  const closeForm = (): void => { setShowForm(false); setEditingId(null) }

  // 新建/编辑走下级页:整块内容区换成表单,左上角返回。
  // 之前表单挂在列表最底下,服务商一多就滚不到,用户会以为根本没有新建入口。
  // 表单只在表单路由构建 —— 原来提成 const 会让这 300 行 JSX(含 57 处 t() 查表、
  // 一次 PROVIDER_PRESETS.map)在列表视图的每次渲染里白建一遍再丢掉。
  if (showForm) {
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-2">
          <button
            onClick={closeForm}
            data-testid="model-form-back"
            className="flex items-center gap-1 -ml-1 px-1.5 py-1 rounded-md text-[12px] text-surface-500 hover:text-surface-700 hover:bg-surface-50 transition-colors"
          >
            <ChevronLeft className="w-3.5 h-3.5" />
            {t('common.actions.back')}
          </button>
          <span className="text-[13px] font-medium text-surface-700">
            {editingId ? t('settings.model.form.editTitle') : t('settings.model.form.addTitle')}
          </span>
        </div>
      <div className="p-4 rounded-lg border border-surface-100 space-y-2.5">

          {/* Provider */}
          <div>
            <label className="block text-[11px] text-surface-400 mb-1">{t('settings.model.form.providerLabel')}</label>
            <select value={provider} onChange={e => handleProviderChange(e.target.value)}
              className="w-full text-[13px] text-surface-700 bg-surface-50 border border-surface-100 rounded-md px-2.5 py-1.5 outline-none focus:border-brand-400 transition-colors">
              {Object.entries(PROVIDER_PRESETS).map(([key, p]) => (
                <option key={key} value={key}>
                  {key === 'custom' ? t('settings.model.providers.customName') : p.name}
                </option>
              ))}
            </select>
          </div>

          {/* 接口格式：只有自定义 provider 才需要选——内置服务商协议是固定的 */}
          {provider === 'custom' && (
            <div>
              <label className="block text-[11px] text-surface-400 mb-1">{t('settings.model.form.apiFormatLabel')}</label>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-1.5">
                <button type="button" onClick={() => setApiFormat('openai')}
                  className={`w-full text-[12px] px-2.5 py-1.5 rounded-md border transition-colors ${
                    apiFormat === 'openai'
                      ? 'border-brand-400 bg-brand-50 dark:bg-brand-900/20 text-brand-700 dark:text-brand-300'
                      : 'border-surface-100 text-surface-500 hover:text-surface-700'
                  }`}>
                  {t('settings.model.form.openAiCompatibleDefault')}
                </button>
                <button type="button" onClick={() => setApiFormat('anthropic')}
                  className={`w-full text-[12px] px-2.5 py-1.5 rounded-md border transition-colors ${
                    apiFormat === 'anthropic'
                      ? 'border-brand-400 bg-brand-50 dark:bg-brand-900/20 text-brand-700 dark:text-brand-300'
                      : 'border-surface-100 text-surface-500 hover:text-surface-700'
                  }`}>
                  Anthropic (v1/messages)
                </button>
                <button type="button" onClick={() => setApiFormat('openai-responses')}
                  className={`w-full text-[12px] px-2.5 py-1.5 rounded-md border transition-colors ${
                    apiFormat === 'openai-responses'
                      ? 'border-brand-400 bg-brand-50 dark:bg-brand-900/20 text-brand-700 dark:text-brand-300'
                      : 'border-surface-100 text-surface-500 hover:text-surface-700'
                  }`}>
                  OpenAI Responses
                </button>
              </div>
              <span className="block text-[10.5px] text-surface-400 mt-1">
                {t('settings.model.form.apiFormatHelp')}
              </span>
            </div>
          )}

          {/* Base URL */}
          <div>
            <label className="block text-[11px] text-surface-400 mb-1">{t('settings.model.form.baseUrlLabel')}</label>
            <input type="text" value={baseUrl} onChange={e => setBaseUrl(e.target.value)}
              placeholder={provider === 'custom' && apiFormat === 'anthropic' ? 'https://your-gateway.com' : 'https://api.openai.com/v1'}
              className="w-full text-[13px] text-surface-700 bg-surface-50 border border-surface-100 rounded-md px-2.5 py-1.5 outline-none focus:border-brand-400 transition-colors" />
            <span className="block text-[10.5px] text-surface-400 mt-1">
              {provider === 'custom' && apiFormat === 'anthropic'
                ? t('settings.model.form.baseUrlHelpAnthropic')
                : provider === 'custom' && apiFormat === 'openai-responses'
                  ? t('settings.model.form.baseUrlHelpResponses')
                  : t('settings.model.form.baseUrlHelpDefault')}
            </span>
          </div>

          {/* API Key */}
          <div>
            <label className="block text-[11px] text-surface-400 mb-1">{t('settings.model.form.apiKeyLabel')}</label>
            <div className="relative">
              <input type={showKey ? 'text' : 'password'} value={apiKey} onChange={e => setApiKey(e.target.value)} placeholder="sk-..."
                className="w-full text-[13px] text-surface-700 bg-surface-50 border border-surface-100 rounded-md px-2.5 py-1.5 pr-8 outline-none focus:border-brand-400 transition-colors" />
              <button
                onClick={() => setShowKey(s => !s)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-surface-300 hover:text-surface-500 transition-colors"
                tabIndex={-1}
                title={showKey ? t('settings.model.form.hideApiKey') : t('settings.model.form.showApiKey')}
              >
                {showKey ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
              </button>
            </div>
          </div>

          {/* Model */}
          <div className="relative">
            <label className="block text-[11px] text-surface-400 mb-1">{t('settings.model.form.modelLabel')}</label>
            <input ref={modelInputRef} type="text" value={model} onChange={e => setModel(e.target.value)}
              onFocus={() => { if (modelSuggestions.length > 0) setShowModelDropdown(true) }}
              placeholder={t('settings.model.form.modelPlaceholder')}
              className="w-full text-[13px] text-surface-700 bg-surface-50 border border-surface-100 rounded-md px-2.5 py-1.5 outline-none focus:border-brand-400 transition-colors" />
            {showModelDropdown && modelSuggestions.length > 0 && (
              <div ref={modelDropdownRef} className="op-menu absolute z-10 left-0 right-0 mt-1 overflow-hidden">
                {modelSuggestions.map(m => (
                  <button key={m} onClick={() => { setModel(m); setShowModelDropdown(false) }}
                    className={`w-full text-left text-[13px] px-2.5 py-1.5 hover:bg-surface-50 dark:hover:bg-surface-100 transition-colors ${m === model ? 'text-brand-600 bg-brand-50' : 'text-surface-600'}`}>
                    {m}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* 思考能力 */}
          <div className="pt-1">
            <label className="flex items-start gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={supportsThinking}
                onChange={e => setSupportsThinking(e.target.checked)}
                className="sw-checkbox mt-0.5"
              />
              <span className="flex-1">
                <span className="flex items-center gap-1 text-[12px] text-surface-700">
                  <Brain className="w-3.5 h-3.5" />
                  {t('settings.model.form.thinking.title')}
                </span>
                <span className="block text-[10.5px] text-surface-400 mt-0.5">
                  {t('settings.model.form.thinking.description')}
                </span>
              </span>
            </label>
            {supportsThinking && (provider === 'custom' || provider === 'zai') && (
              <div className="mt-2 pl-5 space-y-2.5">
                <div>
                  <label className="block text-[10.5px] text-surface-400 mb-1">{t('settings.model.form.thinking.protocolLabel')}</label>
                  <select
                    value={thinkingFormat}
                    onChange={e => setThinkingFormat(e.target.value as typeof thinkingFormat)}
                    data-testid="model-thinking-format"
                    className="w-full text-[12px] text-surface-700 bg-surface-50 border border-surface-100 rounded-md px-2.5 py-1.5 outline-none focus:border-brand-400 transition-colors"
                  >
                    <option value="auto">{t('settings.model.form.thinking.autoOverride')}</option>
                    <option value="zai">GLM / Z.AI</option>
                    <option value="qwen">Qwen / enable_thinking</option>
                    <option value="deepseek">DeepSeek / thinking</option>
                    <option value="openai">OpenAI / reasoning_effort</option>
                  </select>
                  <span className="block text-[10px] text-surface-400 mt-1">
                    {t('settings.model.form.thinking.overrideHelp')}
                  </span>
                </div>
                {qwenThinkingSelected && (
                  <div className="rounded-md bg-surface-50 dark:bg-surface-50/40 p-2.5 space-y-1.5">
                    <span className="block text-[10.5px] font-medium text-surface-500">
                      {t('settings.model.form.thinking.qwenDepth')}
                    </span>
                    {nativeQwen38 ? (
                      <p className="text-[10px] text-surface-400">
                        {t('settings.model.form.thinking.qwen38Native')}
                      </p>
                    ) : (
                      <>
                        <ThinkingBudgetEditor
                          mode={thinkingBudgetMode}
                          draft={thinkingBudgetDraft}
                          onModeChange={setThinkingBudgetMode}
                          onDraftChange={setThinkingBudgetDraft}
                          autoLabelKey="settings.model.form.thinking.inheritAuto"
                          testIdPrefix="model-thinking-budget"
                        />
                        <p className="text-[10px] text-surface-400">
                          {t('settings.model.form.thinking.qwen37Defaults')}
                        </p>
                      </>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* 图片输入能力 */}
          <div className="pt-1">
            <label className="flex items-start gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={supportsImages}
                onChange={e => setSupportsImages(e.target.checked)}
                className="sw-checkbox mt-0.5"
              />
              <span className="flex-1">
                <span className="text-[12px] text-surface-700">
                  {t('settings.model.form.images.title')}
                </span>
                <span className="block text-[10.5px] text-surface-400 mt-0.5">
                  {t('settings.model.form.images.description')}
                </span>
              </span>
            </label>
          </div>

          {/* 上下文窗口 */}
          <div className="pt-1">
            <span className="block text-[12px] text-surface-700 mb-1">{t('settings.model.context.title')}</span>
            <div className="flex items-center gap-2">
              <select
                value={contextWindowChoice}
                onChange={e => {
                  const choice = e.target.value
                  setContextWindowChoice(choice)
                  setCtxDetection({ kind: 'idle' })
                  if (choice === 'default') {
                    setContextWindow('')
                  } else if (choice === 'custom') {
                    if (CONTEXT_WINDOW_PRESETS.some(preset => String(preset.value) === contextWindow)) {
                      setContextWindow('')
                    }
                  } else {
                    setContextWindow(choice)
                  }
                }}
                className="flex-1 text-[13px] text-surface-700 bg-surface-0 dark:bg-surface-50 border border-surface-100 rounded-md px-2.5 py-1.5 outline-none focus:border-brand-400"
              >
                <option value="default">{t('settings.model.context.automatic')}</option>
                {CONTEXT_WINDOW_PRESETS.map(preset => (
                  <option key={preset.value} value={String(preset.value)}>
                    {t('settings.model.context.presetLabel', {
                      compact: preset.compact,
                      count: new Intl.NumberFormat(locale).format(preset.value),
                    })}
                  </option>
                ))}
                <option value="custom">{t('settings.model.context.custom')}</option>
              </select>
              <button
                onClick={handleDetectCtx}
                disabled={!model}
                className="text-[12px] px-3 py-1.5 rounded-md border border-surface-100 text-surface-500 hover:text-surface-700 transition-colors disabled:opacity-40"
              >
                {t('settings.model.context.detect')}
              </button>
            </div>
            {contextWindowChoice === 'custom' && (
              <input
                type="number"
                min="1"
                value={contextWindow}
                onChange={e => setContextWindow(e.target.value)}
                placeholder={t('settings.model.context.exactPlaceholder')}
                className="w-full mt-2 text-[13px] px-2.5 py-1.5 rounded-md border border-surface-100 bg-surface-0 dark:bg-surface-50 outline-none focus:border-brand-400"
              />
            )}
            <span className="block text-[10.5px] text-surface-400 mt-1">
              {contextHelp}
            </span>
          </div>

          {/* Actions */}
          <div className="flex items-center gap-2 pt-1 flex-wrap">
            <button onClick={handleTest} disabled={!apiKey || !model || connectionStatus === 'testing'}
              className="flex items-center gap-1 text-[12px] px-3 py-1.5 rounded-md border border-surface-100 text-surface-500 hover:text-surface-700 transition-colors disabled:opacity-40">
              {connectionStatus === 'testing' ? t('settings.model.actions.testing')
                : connectionStatus === 'success'
                  ? (autoCorrected
                      ? t('settings.model.actions.successAutoCompleted')
                      : t('settings.model.actions.success'))
                : connectionStatus === 'error'
                  ? t('settings.model.actions.failed')
                  : t('settings.model.actions.testConnection')}
            </button>
            <button onClick={handleTestThinking} disabled={!apiKey || !model || thinkingStatus === 'testing'}
              className="flex items-center gap-1 text-[12px] px-3 py-1.5 rounded-md border border-surface-100 text-surface-500 hover:text-surface-700 transition-colors disabled:opacity-40"
              title={t('settings.model.actions.thinkingTitle')}>
              <Brain className="w-3 h-3" />
              {thinkingStatus === 'testing' ? t('settings.model.actions.thinkingTesting')
                : thinkingStatus === 'detected' ? t('settings.model.actions.thinkingDetected')
                : thinkingStatus === 'not_detected' ? t('settings.model.actions.thinkingNotDetected')
                : thinkingStatus === 'error' ? t('settings.model.actions.failed')
                : t('settings.model.actions.testThinking')}
            </button>
            <button
              onClick={handleSave}
              disabled={!apiKey || !model || thinkingBudgetInvalid}
              data-testid="model-save"
              className="text-[12px] px-3 py-1.5 rounded-md bg-brand-500 text-ink-on-accent hover:bg-brand-600 transition-colors disabled:opacity-40">
              {editingId ? t('settings.model.actions.update') : t('settings.model.actions.save')}
            </button>
          </div>
          {connectionStatus === 'error' && (
            <p className="text-[11px] text-red-500 break-words">
              {connectionErrorOverride
                ? t(connectionErrorOverride.key, connectionErrorOverride.params)
                : (connectionError || t(connectionErrorKey))}
            </p>
          )}
          {connectionStatus === 'success' && autoCorrected && (
            <p className="text-[11px] text-surface-400 break-words">
              {t('settings.model.status.autoCorrected', {
                baseUrl,
                action: editingId ? t('settings.model.actions.update') : t('settings.model.actions.save'),
              })}
            </p>
          )}
          {thinkingStatus === 'error' && (
            <p className="text-[11px] text-red-500 break-words">
              {thinkingError
                ? t('settings.model.status.thinkingFailed', { error: renderDisplayError(t, thinkingError) })
                : t('settings.model.errors.thinkingDetectionUnsupported')}
            </p>
          )}
          {thinkingStatus === 'not_detected' && (
            <p className="text-[11px] text-surface-400">{t('settings.model.status.thinkingNotDetectedHelp')}</p>
          )}
        </div>
  
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {/* 顶部常驻工具条 —— 新建按钮不再沉在列表最底下 */}
      <div className="flex items-center justify-between gap-2">
        <span className="text-[12px] text-surface-400">
          {t('settings.model.provider.summaryCount', { providers: grouped.length, models: presets.length })}
        </span>
        <button
          onClick={() => { resetForm(); setShowForm(true) }}
          data-testid="model-add-new"
          className="flex items-center gap-1 shrink-0 px-2.5 py-1.5 rounded-md text-[12px] font-medium bg-brand-500 text-ink-on-accent hover:bg-brand-600 transition-colors"
        >
          <Plus className="w-3.5 h-3.5" />
          {t('settings.model.provider.addProviderAndModel')}
        </button>
      </div>

      {/* 服务商卡片：默认折叠,只留名字 + 已配模型摘要;连接信息和模型行都在展开区。
          之前所有服务商的 URL / key / 模型行全部平铺,一屏放不下三个服务商。 */}
      <div className="space-y-2">
        {presets.length === 0 ? (
          <p className="text-[12px] text-surface-400 py-4 text-center">{t('settings.model.preset.empty')}</p>
        ) : (
          <>
            {grouped.map(({ prov, models }) => {
              const open = openProviders.has(prov.id)
              // 一次解析,三处复用:providerLabel / providerHasCustomName / 第二行域名
              // 原来每张卡每次渲染要 new URL() 三到四遍。
              const host = hostOf(prov.baseUrl)
              const named = providerHasCustomName(prov, host)
              return (
              <div key={prov.id} className="rounded-lg border border-surface-100 overflow-hidden">
                {/* 第一行:服务商。名字没自定义过就显示域名;自定义过则「名字 + 域名(次要)」,
                    改名走行尾那支铅笔(服务商编辑表单里的名称字段)。 */}
                <div className="flex items-center gap-2 px-3 pt-2.5">
                  <button
                    onClick={() => toggleProvider(prov.id)}
                    data-testid={`toggle-provider-${prov.id}`}
                    aria-expanded={open}
                    className="flex flex-1 min-w-0 items-center gap-2 text-left"
                  >
                    <ChevronDown className={`w-3.5 h-3.5 shrink-0 text-surface-300 transition-transform ${open ? '' : '-rotate-90'}`} />
                    <span className="text-[12px] font-medium text-surface-600 truncate">{providerLabel(prov, t, host, named)}</span>
                    {named && (
                      <span className="text-[11px] text-surface-300 truncate min-w-0 font-mono">{host}</span>
                    )}
                    {models.some(m => m.active) && (
                      <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-brand-500/[0.08] text-brand-500 shrink-0">
                        {t('settings.model.provider.inUse')}
                      </span>
                    )}
                  </button>
                  <div className="flex items-center gap-2 shrink-0">
                    {!prov.builtin && (
                      <>
                        {prov.thinkingBudgets !== undefined && (
                          <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-surface-100 text-surface-400 shrink-0">
                            {prov.thinkingBudgets === null
                              ? t('settings.model.provider.qwenToggleBadge')
                              : `Qwen ${prov.thinkingBudgets.low / 1024}K/${prov.thinkingBudgets.medium / 1024}K/${prov.thinkingBudgets.high / 1024}K`}
                          </span>
                        )}
                        <button
                          onClick={() => {
                            // 编辑表单渲染在 {open && …} 里,折叠态下点铅笔原本什么都不会发生。
                            // 打开编辑的同时把卡片展开,让动作总有可见结果。
                            setOpenProviders(prev => new Set(prev).add(prov.id))
                            setEditingProvider({
                            id: prov.id,
                            name: prov.name,
                            baseUrl: prov.baseUrl,
                            apiKey: '',
                            apiFormat: prov.apiFormat || '',
                            thinkingFormat: prov.thinkingFormat || 'auto',
                            thinkingBudgetMode: budgetModeOf(prov.thinkingBudgets),
                            thinkingBudgetDraft: budgetDraftOf(prov.thinkingBudgets)
                            })
                          }}
                          data-testid={`edit-provider-${prov.id}`}
                          className="text-surface-300 hover:text-surface-500 transition-colors p-0.5 shrink-0"
                          title={t('settings.model.provider.editTitle')}
                        >
                          <Edit2 className="w-3 h-3" />
                        </button>
                      </>
                    )}
                  </div>
                  {!prov.builtin && (
                    <button
                      onClick={() => handleAddUnderProvider(prov.id)}
                      className="flex items-center gap-1 text-[11px] text-brand-600 dark:text-brand-400 hover:text-brand-700 transition-colors shrink-0"
                      title={t('settings.model.provider.addTitle')}
                    >
                      <Plus className="w-3 h-3" />
                      {t('settings.model.provider.addModel')}
                    </button>
                  )}
                </div>
                {/* 第二行:模型标签。只在折叠时出现 —— 展开后下面就是完整的模型行,
                    再挂一排标签只是重复。缩进对齐第一行的名字,不对齐箭头。 */}
                {!open && models.length > 0 && (
                  <div className="flex flex-wrap items-center gap-1 px-3 pb-2.5 pt-1.5 pl-[34px]">
                    {models.map(m => (
                      <span
                        key={m.id}
                        className={`text-[11px] px-2 py-0.5 rounded-full truncate max-w-[220px] ${
                          m.active
                            ? 'bg-brand-500/[0.08] text-brand-500'
                            : 'bg-surface-100 text-surface-500'
                        }`}
                      >
                        {displayModelEntryName(m, t, 'settings.model.preset.builtinModel')}
                      </span>
                    ))}
                  </div>
                )}
                {open && <div className="pb-0.5" />}
                {open && (
                <>
                {/* 连接信息属于细节,只在展开时露出 —— 长 URL 平铺在标题行上
                    正是「一屏只放得下三个服务商」的直接原因 */}
                {!prov.builtin && (
                  <div className="px-3 pb-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-surface-300">
                    <span className="min-w-0 break-all font-mono">{prov.baseUrl}</span>
                    <span className="break-all font-mono">{prov.apiKeyMasked}</span>
                  </div>
                )}
                {/* 服务商编辑内联表单 */}
                {editingProvider?.id === prov.id && (
                  <div className="mx-3 mb-2 p-3 rounded-lg border border-brand-200 dark:border-brand-700 space-y-2">
                    <input
                      value={editingProvider.name}
                      onChange={e => setEditingProvider({ ...editingProvider, name: e.target.value })}
                      placeholder={t('settings.model.provider.namePlaceholder')}
                      className="w-full px-2.5 py-1.5 text-[12px] rounded-md border border-surface-200 bg-transparent"
                    />
                    <input
                      value={editingProvider.baseUrl}
                      onChange={e => setEditingProvider({ ...editingProvider, baseUrl: e.target.value })}
                      placeholder="Base URL"
                      className="w-full px-2.5 py-1.5 text-[12px] rounded-md border border-surface-200 bg-transparent font-mono"
                    />
                    <input
                      type="password"
                      value={editingProvider.apiKey}
                      onChange={e => setEditingProvider({ ...editingProvider, apiKey: e.target.value })}
                      placeholder={t('settings.model.provider.apiKeyKeepPlaceholder', {
                        value: prov.apiKeyMasked || t('settings.model.provider.apiKeyOriginal'),
                      })}
                      className="w-full px-2.5 py-1.5 text-[12px] rounded-md border border-surface-200 bg-transparent font-mono"
                    />
                    <div className="grid grid-cols-2 gap-2">
                      <label className="space-y-1">
                        <span className="block text-[10.5px] text-surface-400">{t('settings.model.provider.apiFormatLabel')}</span>
                        <select
                          value={editingProvider.apiFormat || 'openai'}
                          onChange={e => setEditingProvider({ ...editingProvider, apiFormat: e.target.value })}
                          className="w-full px-2.5 py-1.5 text-[12px] rounded-md border border-surface-200 bg-surface-0 dark:bg-surface-50"
                        >
                          <option value="openai">OpenAI Chat Completions</option>
                          <option value="anthropic">Anthropic Messages</option>
                          <option value="openai-responses">OpenAI Responses</option>
                        </select>
                      </label>
                      <label className="space-y-1">
                        <span className="block text-[10.5px] text-surface-400">{t('settings.model.provider.defaultThinkingProtocol')}</span>
                        <select
                          value={editingProvider.thinkingFormat}
                          onChange={e => setEditingProvider({
                            ...editingProvider,
                            thinkingFormat: e.target.value as typeof editingProvider.thinkingFormat
                          })}
                          data-testid={`provider-thinking-format-${prov.id}`}
                          className="w-full px-2.5 py-1.5 text-[12px] rounded-md border border-surface-200 bg-surface-0 dark:bg-surface-50"
                        >
                          <option value="auto">{t('settings.model.provider.autoByModel')}</option>
                          <option value="qwen">Qwen</option>
                          <option value="zai">GLM / Z.AI</option>
                          <option value="deepseek">DeepSeek</option>
                          <option value="openai">OpenAI</option>
                        </select>
                      </label>
                    </div>
                    <div className="rounded-md bg-surface-50 dark:bg-surface-50/40 p-2.5 space-y-1.5">
                      <span className="block text-[10.5px] font-medium text-surface-500">
                        {t('settings.model.provider.qwenBudgetTitle')}
                      </span>
                      <ThinkingBudgetEditor
                        mode={editingProvider.thinkingBudgetMode}
                        draft={editingProvider.thinkingBudgetDraft}
                        onModeChange={thinkingBudgetMode => setEditingProvider({ ...editingProvider, thinkingBudgetMode })}
                        onDraftChange={thinkingBudgetDraft => setEditingProvider({ ...editingProvider, thinkingBudgetDraft })}
                        autoLabelKey="settings.model.provider.autoModelStudio"
                        testIdPrefix={`provider-thinking-budget-${prov.id}`}
                      />
                      <p className="text-[10px] text-surface-400">
                        {t('settings.model.provider.inheritanceHelp')}
                      </p>
                    </div>
                    <div className="flex gap-2 justify-end">
                      <button onClick={() => setEditingProvider(null)} className="px-2.5 py-1 text-[11px] text-surface-400 hover:text-surface-600">{t('settings.model.provider.cancel')}</button>
                      <button
                        onClick={handleSaveProvider}
                        disabled={editingProvider.thinkingBudgetMode === 'custom' && !parseThinkingBudgets(editingProvider.thinkingBudgetDraft)}
                        data-testid={`save-provider-${prov.id}`}
                        className="px-2.5 py-1 text-[11px] rounded-md bg-brand-500 text-ink-on-accent hover:bg-brand-600 disabled:opacity-40"
                      >
                        {t('settings.model.provider.saveApplies', { count: prov.modelCount })}
                      </button>
                    </div>
                  </div>
                )}
                <div className="px-3 pb-3 space-y-2">{models.map(renderPresetRow)}</div>
                </>
                )}
              </div>
              )
            })}
            {ungrouped.length > 0 && (
              <div className="space-y-2">
                <span className="text-[12px] font-medium text-surface-500 px-1">{t('settings.model.provider.ungrouped')}</span>
                {ungrouped.map(renderPresetRow)}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
