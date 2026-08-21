import { useState, useEffect, useRef, useCallback } from 'react'
import { Eye, EyeOff, Check, Plus, Trash2, Edit2, Brain, ChevronLeft, ChevronRight, ChevronDown, Search, RefreshCw, Box } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toDisplayError, renderDisplayError, type DisplayError } from '../utils/mainError'
import { displayModelEntryName } from '../utils/modelDisplay'
import { AnchoredMenu } from './shared/AnchoredMenu'

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

/** 目录条目：主进程直接从 Pi 的模型目录算出来（getProviders），这里不再手抄一份 */
interface CatalogModelEntry {
  id: string
  name?: string
  reasoning?: boolean
  image?: boolean
  contextWindow?: number
  /** 只有"从服务商获取"回来的条目才有：true = Pi 目录也认识它 */
  known?: boolean
}
interface CatalogProviderEntry { name: string; baseUrl: string; models: CatalogModelEntry[] }

/** 目录里没有"自定义"这一项——它不是一个服务商，是"目录里找不到时自己填" */
const CUSTOM_PROVIDER_ENTRY: CatalogProviderEntry = { name: '', baseUrl: '', models: [] }

/** 左栏"未分组"伪服务商(providerId 悬空的历史配置) */
const UNGROUPED_KEY = '__ungrouped__'

/** 下拉里最多列多少个模型：openrouter 一家就有 300+，全量渲染既慢又没法看 */
const MODEL_SUGGESTION_LIMIT = 60

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
  // 主从两栏:左栏选中的服务商(UNGROUPED_KEY = 悬空模型的伪分组)。
  // 首次拿到数据时自动选中「当前在用的模型」所在的服务商 —— 用户进设置最常见的
  // 目的是确认/切换现在用的是哪个,而不是通读全部配置。之后完全交给用户。
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const seededSelectRef = useRef(false)
  // 窄容器(侧栏形态)退化成「列表 → 点进详情」两级推进
  const [wide, setWide] = useState(true)
  const [narrowDetail, setNarrowDetail] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  // 详情栏的服务商草稿(换 key/网关一处生效):apiKey 空串 = 保留原 key。
  // 只在切换选中项/保存成功后重建,期间 presets 刷新不清用户正在改的字段。
  interface ProviderDraft {
    id: string
    name: string
    baseUrl: string
    apiKey: string
    apiFormat: string
    thinkingFormat: 'auto' | 'openai' | 'qwen' | 'deepseek' | 'zai'
    thinkingBudgetMode: ThinkingBudgetMode
    thinkingBudgetDraft: ThinkingBudgetDraft
  }
  const [draft, setDraft] = useState<ProviderDraft | null>(null)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [confirmDeleteProv, setConfirmDeleteProv] = useState(false)
  // 表单入口:从「添加服务商」进来标题叫服务商,从服务商下「添加模型」进来叫模型
  const [formEntry, setFormEntry] = useState<'provider' | 'model'>('provider')

  const draftOf = (prov: ProviderEntity): ProviderDraft => ({
    id: prov.id,
    name: prov.name,
    baseUrl: prov.baseUrl,
    apiKey: '',
    apiFormat: prov.apiFormat || '',
    thinkingFormat: prov.thinkingFormat || 'auto',
    thinkingBudgetMode: budgetModeOf(prov.thinkingBudgets),
    thinkingBudgetDraft: budgetDraftOf(prov.thinkingBudgets)
  })

  const selectProvider = (key: string, prov?: ProviderEntity): void => {
    setSelectedKey(key)
    setDraft(prov && !prov.builtin ? draftOf(prov) : null)
    setAdvancedOpen(false)
    setRenaming(false)
    setConfirmDeleteProv(false)
    setNarrowDetail(true)
    // 表单开着时点别的服务商 = 放弃表单,右栏回到详情
    setShowForm(false)
    setEditingId(null)
  }

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
  const [showModelDropdown, setShowModelDropdown] = useState(false)
  const [showProviderMenu, setShowProviderMenu] = useState(false)
  const [providerQuery, setProviderQuery] = useState('')
  // 服务商本人给的模型清单，连同"它是替哪套配置问来的"一起存。配置一变，这份答案自然
  // 就不新鲜了（派生判断，不需要 effect 去清）；迟到的响应也因为带着旧 key 而自动作废。
  const [remote, setRemote] = useState<{ key: string; models?: CatalogModelEntry[]; error?: DisplayError } | null>(null)
  const [remoteLoading, setRemoteLoading] = useState(false)
  // 服务商 + 模型目录（来自 Pi）。空对象 = 还没加载出来，此时只剩"自定义"可选，不阻塞填写。
  const [catalog, setCatalog] = useState<Record<string, CatalogProviderEntry>>({})
  // 目录服务商的地址默认只读——点开"高级"才允许改成镜像/代理
  const [endpointUnlocked, setEndpointUnlocked] = useState(false)
  const catalogEntry = provider === 'custom' ? undefined : catalog[provider]
  const endpointLocked = !!catalogEntry && !endpointUnlocked
  const remoteFresh = remote?.key === `${provider}|${baseUrl}|${apiKey}` ? remote : null
  const modelSuggestions = remoteFresh?.models ?? catalogEntry?.models ?? []
  const qwenThinkingSelected = thinkingFormat === 'qwen' || (thinkingFormat === 'auto' && /qwen/i.test(model))
  // Pi 原生目录已为官方 Token Plan / DashScope 的 Qwen3.8 定义 reasoning_effort。
  // 这类模型不能再套 Qwen3.7 的 token 预算编辑器，避免同一请求发两种协议字段。
  const nativeQwen38 = qwenThinkingSelected
    && /qwen3[._-]8/i.test(model)
    && /(?:token-plan\.(?:cn-beijing|ap-southeast-1)\.maas\.aliyuncs\.com|dashscope(?:-[a-z0-9]+)?\.aliyuncs\.com)/i.test(baseUrl)
  const thinkingBudgetInvalid = !nativeQwen38 && thinkingBudgetMode === 'custom' && !parseThinkingBudgets(thinkingBudgetDraft)

  const modelInputRef = useRef<HTMLInputElement>(null)
  const providerButtonRef = useRef<HTMLButtonElement>(null)

  const loadPresets = useCallback(async () => {
    const models = await window.api.getAvailableModels?.()
    if (models) setPresets(models)
    const provs = await (window.api as any).listModelProviders?.().catch(() => null)
    if (provs) setProviders(provs)
    // 首次两份数据都到齐后再选中(用 effect 播会踩到"模型已到、服务商还没到"的
    // 中间态,把选中项误播成「未分组」):优先活动模型所在的服务商,只播一次。
    if (!seededSelectRef.current && models && models.length > 0) {
      seededSelectRef.current = true
      const provList: ProviderEntity[] = provs || []
      const withModels = provList.filter(pr => models.some((m: ModelPreset) => m.providerId === pr.id))
      const activeProviderId = models.find((m: ModelPreset) => m.active)?.providerId
      const target = withModels.find(pr => pr.id === activeProviderId)
        ?? withModels.find(pr => !pr.builtin) ?? withModels[0]
      if (target) {
        setSelectedKey(target.id)
        setDraft(target.builtin ? null : draftOf(target))
      } else if (models.some((m: ModelPreset) => !m.providerId || !provList.some(x => x.id === m.providerId))) {
        setSelectedKey(UNGROUPED_KEY)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 目录只在挂载时取一次：它来自 Pi 的静态表，一个会话内不会变
  useEffect(() => {
    window.api.getProviders?.()
      .then((entries: Record<string, CatalogProviderEntry>) => { if (entries) setCatalog(entries) })
      .catch(() => { /* 取不到就只剩"自定义"，不挡用户填写 */ })
  }, [])

  useEffect(() => { loadPresets() }, [])

  /** 服务商按名字和 id 一起筛：用户可能记得 "opencode" 也可能记得 "OpenCode Zen" */
  const providerLabelOf = (key: string): string =>
    key === 'custom' ? t('settings.model.providers.customName') : (catalog[key]?.name || key)
  const providerQ = providerQuery.trim().toLowerCase()
  const filteredProviders = Object.entries({ ...catalog, custom: CUSTOM_PROVIDER_ENTRY })
    .filter(([key, entry]) => (key + entry.name).toLowerCase().includes(providerQ))

  /**
   * 向服务商本人要清单。/models 是 OpenAI 兼容协议的事实标准，但大量网关没实现——
   * 失败不是错误路径，退回目录 + 手填即可，所以这里只留一行提示不拦任何操作。
   */
  const handleFetchRemoteModels = async (config?: ModelConfig): Promise<void> => {
    const cfg = config ?? buildFormModelConfig()
    // key 用真正发出去的那套配置算：测试连接补过 /v1 时，答案属于补过的地址
    const key = `${cfg.provider}|${cfg.baseUrl}|${cfg.apiKey}`
    setRemoteLoading(true)
    const result = await window.api.listRemoteModels?.(cfg).catch(() => null)
    setRemoteLoading(false)
    setRemote(result?.models?.length
      ? { key, models: result.models }
      : { key, error: toDisplayError(result, 'settings.model.errors.remoteModelsFailed') })
  }

  /**
   * 输入即筛选。目录里 openrouter 一家就有 300+ 个模型，不筛没法用；
   * 已经填了完整模型名时不再列它自己（那条建议没有信息量）。
   */
  const filteredSuggestions = (() => {
    const query = model.trim().toLowerCase()
    const pool = query
      ? modelSuggestions.filter(entry => entry.id.toLowerCase().includes(query))
      : modelSuggestions
    if (pool.length === 1 && pool[0].id.toLowerCase() === query) return []
    return pool.slice(0, MODEL_SUGGESTION_LIMIT)
  })()

  /**
   * 从目录选中一个模型：能力位一并回填。
   * 这是目录路径最大的收益——填错 supportsImages 会让网关吃 400，
   * 目录里既然写着，就别再问用户一遍。
   */
  const pickCatalogModel = (entry: CatalogModelEntry): void => {
    setModel(entry.id)
    setShowModelDropdown(false)
    if (entry.reasoning !== undefined) setSupportsThinking(entry.reasoning)
    if (entry.image !== undefined) setSupportsImages(entry.image)
    if (entry.contextWindow) {
      setContextWindow(String(entry.contextWindow))
      setContextWindowChoice(getContextWindowChoice(String(entry.contextWindow)))
    }
    setConnectionStatus('idle')
  }

  const handleProviderChange = (p: string) => {
    setProvider(p)
    setEndpointUnlocked(false)
    const entry = catalog[p]
    if (entry && p !== 'custom') {
      setBaseUrl(entry.baseUrl)
      // 不再自动填第一个模型：目录里一家可能有几百个，随手挑一个既无意义又像是"已经选好了"
      setModel('')
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
      // 连通的这一刻是唯一能确定"这把 key 真的能用"的时机，顺手把清单取回来；
      // 地址被自动补 /v1 时用补过的那个问，否则又会打到错的端点上
      void handleFetchRemoteModels({
        ...config,
        ...(result.correctedBaseUrl ? { baseUrl: result.correctedBaseUrl } : {})
      })
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
    const savedProvider = preset.config.provider || 'custom'
    setProvider(savedProvider)
    setBaseUrl(preset.config.baseUrl || '')
    // 存的地址跟目录里的官方地址不一致 = 用户当初就是奔着镜像/代理去的，直接展开高级，
    // 别让它显示成一个不可改的"官方地址"
    setEndpointUnlocked(
      !!catalog[savedProvider] && (preset.config.baseUrl || '') !== catalog[savedProvider].baseUrl
    )
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
    setFormEntry('model')
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
    setFormEntry('model')
    setShowForm(true)
  }

  const handleSaveProvider = async () => {
    if (!draft) return
    const parsedBudgets = thinkingBudgetValue(draft.thinkingBudgetMode, draft.thinkingBudgetDraft)
    if (draft.thinkingBudgetMode === 'custom' && !parsedBudgets) return
    await (window.api as any).updateModelProvider?.(draft.id, {
      name: draft.name,
      baseUrl: draft.baseUrl,
      apiKey: draft.apiKey, // 空串 = 主进程保留原 key
      apiFormat: draft.apiFormat,
      thinkingFormat: draft.thinkingFormat,
      thinkingBudgets: draft.thinkingBudgetMode === 'auto' ? 'auto' : parsedBudgets
    })
    // key 已入库,草稿归位成"保留原 key";其余字段就是刚存的值,原样即是新基线
    setDraft(d => (d ? { ...d, apiKey: '' } : d))
    setRenaming(false)
    await loadPresets()
  }

  /** 服务商级删除 = 删掉它名下全部模型(没有独立的服务商删除 IPC,空壳自然消失) */
  const handleDeleteProvider = async (provId: string, modelIds: string[]) => {
    for (const id of modelIds) await window.api.deleteModelPreset?.(id)
    setConfirmDeleteProv(false)
    setSelectedKey(null)
    seededSelectRef.current = false // 让选中项按新数据重播一次
    setNarrowDetail(false)
    await loadPresets()
  }

  const resetForm = () => {
    setProvider('custom')
    setEndpointUnlocked(false)
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
    setShowProviderMenu(false)
    setShowModelDropdown(false)
  }

  // 宽窄断点:≥520px 内容宽走左右两栏,更窄退化成两级推进(侧栏形态)
  useEffect(() => {
    const el = rootRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(entries => {
      const w = entries[0]?.contentRect.width ?? 0
      setWide(w >= 520)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [showForm])

  // 按服务商分组：服务商实体顺序在前，providerId 悬空的进"未分组"尾部
  const grouped = providers.map(prov => ({ prov, models: presets.filter(p => p.providerId === prov.id) }))
    .filter(g => g.models.length > 0)
  const ungrouped = presets.filter(p => !p.providerId || !providers.some(x => x.id === p.providerId))
  const builtinGroups = grouped.filter(g => g.prov.builtin)
  const customGroups = grouped.filter(g => !g.prov.builtin)

  // 选中的服务商被删空后自动落到下一个可选项
  const selectedGroup = grouped.find(g => g.prov.id === selectedKey) ?? null
  const selectionValid = selectedGroup !== null || (selectedKey === UNGROUPED_KEY && ungrouped.length > 0)
  useEffect(() => {
    if (selectedKey === null || selectionValid) return
    const fallback = customGroups[0] ?? builtinGroups[0]
    if (fallback) selectProvider(fallback.prov.id, fallback.prov)
    else if (ungrouped.length > 0) selectProvider(UNGROUPED_KEY)
    else setSelectedKey(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectionValid, selectedKey, providers, presets])

  // 草稿与选中项对齐:seed/fallback 之外的任何路径漏设草稿时兜底
  const selectedProvId = selectedGroup?.prov.id
  useEffect(() => {
    const prov = selectedGroup?.prov
    if (prov && !prov.builtin && (!draft || draft.id !== prov.id)) setDraft(draftOf(prov))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedProvId])

  /** 草稿相对已存值的脏位:决定保存钮亮不亮、要不要给「还原」 */
  const draftDirty = (() => {
    const prov = selectedGroup?.prov
    if (!draft || !prov || prov.builtin) return false
    const budgetsChanged = draft.thinkingBudgetMode !== budgetModeOf(prov.thinkingBudgets)
      || (draft.thinkingBudgetMode === 'custom'
        && JSON.stringify(parseThinkingBudgets(draft.thinkingBudgetDraft))
          !== JSON.stringify(isThinkingBudgets(prov.thinkingBudgets) ? prov.thinkingBudgets : null))
    return draft.name !== prov.name
      || draft.baseUrl !== prov.baseUrl
      || draft.apiKey !== ''
      || (draft.apiFormat || 'openai') !== (prov.apiFormat || 'openai')
      || draft.thinkingFormat !== (prov.thinkingFormat || 'auto')
      || budgetsChanged
  })()
  const draftBudgetsInvalid = !!draft
    && draft.thinkingBudgetMode === 'custom'
    && !parseThinkingBudgets(draft.thinkingBudgetDraft)
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

  // 新建/编辑不再整页跳转:表单渲染在右栏详情区(窄窗则占满内容区),左栏还在,
  // 点别的服务商即放弃表单回详情。仍然只在表单打开时构建 —— 关着也建会让这
  // 300 行 JSX(含 57 处 t() 查表)在列表视图的每次渲染里白建一遍再丢掉。
  const formView = !showForm ? null : (
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
            {editingId
              ? t('settings.model.form.editTitle')
              : formEntry === 'provider'
                ? t('settings.model.form.addProviderTitle')
                : t('settings.model.form.addTitle')}
          </span>
        </div>
      <div className="p-4 rounded-lg border border-surface-100 space-y-2.5">

          {/* Provider */}
          <div>
            <label className="block text-[11px] text-surface-400 mb-1">{t('settings.model.form.providerLabel')}</label>
            {/* 不用原生 <select>：目录接进来后这里有 30+ 家，macOS 会把系统菜单按选中项
                对齐到触发框、整体顶出窗口顶部，且不受任何 CSS 控制 */}
            <button
              type="button"
              ref={providerButtonRef}
              data-testid="model-provider-trigger"
              aria-haspopup="listbox"
              aria-expanded={showProviderMenu}
              onClick={() => { setProviderQuery(''); setShowProviderMenu(o => !o) }}
              className="w-full flex items-center justify-between gap-2 text-[13px] text-surface-700 bg-surface-50 border border-surface-100 rounded-md px-2.5 py-1.5 outline-none hover:border-surface-200 focus:border-brand-400 transition-colors"
            >
              <span className="truncate">{providerLabelOf(provider)}</span>
              <ChevronDown className="w-3.5 h-3.5 shrink-0 text-surface-400" />
            </button>
            {/* 条件挂载而不是把 open 交给浮层自己判：children 是普通 props，
                菜单关着时也会被整个求值一遍再扔掉 */}
            {showProviderMenu && (
            <AnchoredMenu
              anchorRef={providerButtonRef}
              open
              onClose={() => setShowProviderMenu(false)}
              testId="model-provider-menu"
            >
              <div className="sticky top-0 bg-surface-0 dark:bg-surface-50 p-1.5 border-b border-surface-100">
                <div className="relative">
                  <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-surface-300" />
                  <input
                    autoFocus
                    value={providerQuery}
                    onChange={e => setProviderQuery(e.target.value)}
                    placeholder={t('settings.model.form.providerSearchPlaceholder')}
                    data-testid="model-provider-search"
                    className="w-full text-[12px] text-surface-700 bg-surface-50 dark:bg-surface-100 border border-surface-100 rounded-md pl-6 pr-2 py-1 outline-none focus:border-brand-400"
                  />
                </div>
              </div>
              {filteredProviders.map(([key, p]) => (
                <button
                  key={key}
                  type="button"
                  role="option"
                  data-menu-item
                  aria-selected={key === provider}
                  data-testid={`model-provider-option-${key}`}
                  onClick={() => { handleProviderChange(key); setShowProviderMenu(false) }}
                  className={`w-full text-left px-2.5 py-1.5 hover:bg-surface-50 dark:hover:bg-surface-100 transition-colors ${key === provider ? 'bg-brand-50 dark:bg-brand-900/20' : ''}`}
                >
                  <span className={`block text-[13px] truncate ${key === provider ? 'text-brand-600' : 'text-surface-600'}`}>
                    {providerLabelOf(key)}
                  </span>
                  <span className="block text-[10px] text-surface-400 truncate">
                    {key === 'custom' ? t('settings.model.form.providerCustomHint') : `${p.models.length} · ${hostOf(p.baseUrl)}`}
                  </span>
                </button>
              ))}
            </AnchoredMenu>
            )}
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
              readOnly={endpointLocked}
              data-testid="model-base-url"
              placeholder={provider === 'custom' && apiFormat === 'anthropic' ? 'https://your-gateway.com' : 'https://api.openai.com/v1'}
              className={`w-full text-[13px] border border-surface-100 rounded-md px-2.5 py-1.5 outline-none transition-colors ${
                endpointLocked
                  ? 'text-surface-400 bg-surface-100/60 cursor-default'
                  : 'text-surface-700 bg-surface-50 focus:border-brand-400'
              }`} />
            {catalogEntry ? (
              <div className="flex items-center gap-2 mt-1">
                <span className="text-[10.5px] text-surface-400">
                  {endpointUnlocked
                    ? t('settings.model.form.endpointOverridden')
                    : t('settings.model.form.endpointFromCatalog')}
                </span>
                <button
                  type="button"
                  data-testid="model-endpoint-advanced"
                  onClick={() => {
                    // 收进"高级"：镜像/代理是少数场景，但不给入口的话这类用户只能退回自定义、
                    // 白白丢掉目录里的协议与能力位
                    if (endpointUnlocked) setBaseUrl(catalogEntry.baseUrl)
                    setEndpointUnlocked(u => !u)
                  }}
                  className="text-[10.5px] text-brand-600 hover:text-brand-700 transition-colors"
                >
                  {endpointUnlocked ? t('settings.model.form.endpointRestore') : t('settings.model.form.endpointEdit')}
                </button>
              </div>
            ) : (
              <span className="block text-[10.5px] text-surface-400 mt-1">
                {apiFormat === 'anthropic'
                  ? t('settings.model.form.baseUrlHelpAnthropic')
                  : apiFormat === 'openai-responses'
                    ? t('settings.model.form.baseUrlHelpResponses')
                    : t('settings.model.form.baseUrlHelpDefault')}
              </span>
            )}
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
          <div>
            <label className="block text-[11px] text-surface-400 mb-1">{t('settings.model.form.modelLabel')}</label>
            <input ref={modelInputRef} type="text" value={model} onChange={e => setModel(e.target.value)}
              onFocus={() => { if (modelSuggestions.length > 0) setShowModelDropdown(true) }}
              onClick={() => { if (modelSuggestions.length > 0) setShowModelDropdown(true) }}
              placeholder={t('settings.model.form.modelPlaceholder')}
              className="w-full text-[13px] text-surface-700 bg-surface-50 border border-surface-100 rounded-md px-2.5 py-1.5 outline-none focus:border-brand-400 transition-colors" />
            {showModelDropdown && filteredSuggestions.length > 0 && (
            <AnchoredMenu
              anchorRef={modelInputRef}
              open
              onClose={() => setShowModelDropdown(false)}
              testId="model-suggestions"
            >
              {filteredSuggestions.map(entry => (
                <button key={entry.id} type="button" onClick={() => pickCatalogModel(entry)}
                  role="option" data-menu-item aria-selected={entry.id === model}
                  data-testid={`model-suggestion-${entry.id}`}
                  className={`w-full text-left px-2.5 py-1.5 hover:bg-surface-50 dark:hover:bg-surface-100 transition-colors ${entry.id === model ? 'bg-brand-50' : ''}`}>
                  <span className={`block text-[13px] truncate ${entry.id === model ? 'text-brand-600' : 'text-surface-600'}`}>{entry.id}</span>
                  {(entry.contextWindow || entry.reasoning || entry.known === false) && (
                    <span className="block text-[10px] text-surface-400 mt-0.5">
                      {[
                        entry.contextWindow ? `${Math.round(entry.contextWindow / 1000)}K` : null,
                        entry.reasoning ? t('settings.model.form.capabilityThinking') : null,
                        entry.image ? t('settings.model.form.capabilityImage') : null,
                        entry.known === false ? t('settings.model.form.modelUnknownBadge') : null
                      ].filter(Boolean).join(' · ')}
                    </span>
                  )}
                </button>
              ))}
            </AnchoredMenu>
            )}
            <div className="flex items-center gap-2 mt-1">
              {modelSuggestions.length > 0 && (
                <span className="text-[10.5px] text-surface-400">
                  {remoteFresh?.models
                    ? t('settings.model.form.modelRemoteHint', { count: modelSuggestions.length })
                    : t('settings.model.form.modelSearchHint', { count: modelSuggestions.length })}
                </span>
              )}
              {/* 手动入口：改了 key / 地址想重新问一次，不必先走一遍测试连接 */}
              <button
                type="button"
                data-testid="model-fetch-remote"
                disabled={!baseUrl.trim() || remoteLoading}
                onClick={() => handleFetchRemoteModels()}
                className="flex items-center gap-1 text-[10.5px] text-brand-600 hover:text-brand-700 disabled:text-surface-300 transition-colors"
              >
                <RefreshCw className={`w-3 h-3 ${remoteLoading ? 'animate-spin' : ''}`} />
                {remoteLoading
                  ? t('settings.model.form.modelFetching')
                  : t('settings.model.form.modelFetchRemote')}
              </button>
            </div>
            {remoteFresh?.error && (
              <span className="block text-[10.5px] text-surface-400 mt-1" data-testid="model-fetch-remote-error">
                {renderDisplayError(t, remoteFresh.error)}
              </span>
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

  // ── 主从两栏:左栏服务商列表 ──────────────────────────────────────────
  const activeIn = (models: ModelPreset[]): boolean => models.some(m => m.active)

  const railRow = (key: string, label: string, models: ModelPreset[], prov?: ProviderEntity): JSX.Element => (
    <button
      key={key}
      onClick={() => selectProvider(key, prov)}
      data-testid={`select-provider-${key}`}
      aria-current={selectedKey === key ? 'true' : undefined}
      className={`w-full rounded-md px-2 py-2 transition-colors ${
        selectedKey === key && wide
          ? 'bg-surface-100'
          : 'hover:bg-surface-50 dark:hover:bg-surface-100/60'
      }`}
    >
      <span className="flex flex-1 min-w-0 items-center gap-2 text-left">
        <Box className="w-3.5 h-3.5 shrink-0 text-surface-400" />
        <span className="text-[12.5px] font-medium text-surface-600 truncate">{label}</span>
        <span className="ml-auto flex items-center gap-1.5 shrink-0">
          {/* 绿点 = 当前在用的模型住在这家 */}
          {activeIn(models) && <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />}
          {!wide && <ChevronRight className="w-3.5 h-3.5 text-surface-300" />}
        </span>
      </span>
    </button>
  )

  const rail = (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex-1 min-h-0 overflow-y-auto p-1.5 space-y-3">
        {builtinGroups.length > 0 && (
          <div>
            <div className="px-2 pb-1 text-[10px] font-medium uppercase tracking-wider text-surface-300">
              {t('settings.model.provider.builtinGroup')}
            </div>
            <div className="space-y-0.5">
              {builtinGroups.map(g => {
                const host = hostOf(g.prov.baseUrl)
                return railRow(g.prov.id, providerLabel(g.prov, t, host, providerHasCustomName(g.prov, host)), g.models, g.prov)
              })}
            </div>
          </div>
        )}
        <div>
          <div className="px-2 pb-1 text-[10px] font-medium uppercase tracking-wider text-surface-300">
            {t('settings.model.provider.customGroup')}
          </div>
          <div className="space-y-0.5">
            {customGroups.map(g => {
              const host = hostOf(g.prov.baseUrl)
              return railRow(g.prov.id, providerLabel(g.prov, t, host, providerHasCustomName(g.prov, host)), g.models, g.prov)
            })}
            {ungrouped.length > 0 && railRow(UNGROUPED_KEY, t('settings.model.provider.ungrouped'), ungrouped)}
            {customGroups.length === 0 && ungrouped.length === 0 && (
              <p className="px-2 py-1 text-[11px] text-surface-300">{t('settings.model.preset.empty')}</p>
            )}
          </div>
        </div>
      </div>
      <div className="p-1.5 border-t border-surface-100">
        <button
          onClick={() => { resetForm(); setFormEntry('provider'); setShowForm(true) }}
          data-testid="model-add-new"
          className="w-full flex items-center justify-center gap-1 rounded-md border border-dashed border-surface-200 py-1.5 text-[12px] text-surface-500 hover:text-brand-600 hover:border-brand-300 transition-colors"
        >
          <Plus className="w-3.5 h-3.5" />
          {t('settings.model.provider.addProvider')}
        </button>
      </div>
    </div>
  )

  // ── 右栏:选中服务商的详情 ─────────────────────────────────────────────
  const detail = ((): JSX.Element | null => {
    if (selectedKey === UNGROUPED_KEY) {
      return (
        <div>
          <h3 className="text-[15px] font-semibold text-surface-800">{t('settings.model.provider.ungrouped')}</h3>
          <div className="mt-4 space-y-2">{ungrouped.map(renderPresetRow)}</div>
        </div>
      )
    }
    if (!selectedGroup) return null
    const { prov, models } = selectedGroup
    const host = hostOf(prov.baseUrl)
    const named = providerHasCustomName(prov, host)
    const label = providerLabel(prov, t, host, named)
    const inUse = activeIn(models)
    const inUsePill = (
      <span className="text-[10px] px-2 py-0.5 rounded-full bg-brand-500/[0.08] text-brand-500 shrink-0">
        {t('settings.model.provider.inUse')}
      </span>
    )

    // 红线:内置服务商的连接信息既不可见也不可改 —— 详情栏只列模型
    if (prov.builtin) {
      return (
        <div>
          <div className="flex items-center gap-2 min-w-0">
            <h3 className="text-[15px] font-semibold text-surface-800 truncate">{label}</h3>
            {inUse && inUsePill}
          </div>
          <p className="mt-1 text-[11px] text-surface-400">{t('settings.model.provider.builtinManaged')}</p>
          <div className="mt-4">
            <div className="mb-2 text-[11px] text-surface-400">{t('settings.model.provider.modelsLabel')}</div>
            <div className="space-y-2">{models.map(renderPresetRow)}</div>
          </div>
        </div>
      )
    }
    if (!draft || draft.id !== prov.id) return null // 切换瞬间的空档,effect 马上补上草稿

    return (
      <div>
        {/* 头:名称(铅笔改名) + 使用中 + 删除(两击确认) */}
        <div className="flex items-center gap-2 min-w-0">
          {renaming ? (
            <input
              autoFocus
              value={draft.name}
              onChange={e => setDraft({ ...draft, name: e.target.value })}
              onKeyDown={e => { if (e.key === 'Enter') setRenaming(false) }}
              placeholder={t('settings.model.provider.namePlaceholder')}
              data-testid={`rename-provider-${prov.id}`}
              className="flex-1 min-w-0 text-[15px] font-semibold text-surface-800 bg-surface-50 border border-surface-200 rounded-md px-2 py-1 outline-none focus:border-brand-400"
            />
          ) : (
            <h3 className="text-[15px] font-semibold text-surface-800 truncate">{draft.name.trim() || label}</h3>
          )}
          <button
            onClick={() => setRenaming(r => !r)}
            className="text-surface-300 hover:text-surface-500 transition-colors p-0.5 shrink-0"
            title={t('settings.model.provider.editTitle')}
          >
            <Edit2 className="w-3.5 h-3.5" />
          </button>
          {inUse && inUsePill}
          <button
            onClick={() => {
              if (!confirmDeleteProv) { setConfirmDeleteProv(true); return }
              void handleDeleteProvider(prov.id, models.map(m => m.id))
            }}
            onBlur={() => setConfirmDeleteProv(false)}
            data-testid={`delete-provider-${prov.id}`}
            className={`ml-auto shrink-0 flex items-center gap-1 p-1 rounded-md transition-colors ${
              confirmDeleteProv ? 'text-red-500 bg-red-500/10' : 'text-surface-300 hover:text-red-400'
            }`}
            title={t('settings.model.provider.deleteTitle')}
          >
            <Trash2 className="w-3.5 h-3.5" />
            {confirmDeleteProv && (
              <span className="text-[10.5px]">{t('settings.model.provider.deleteConfirm', { count: models.length })}</span>
            )}
          </button>
        </div>
        <p className="mt-0.5 text-[11px] text-surface-400 font-mono truncate">{host}</p>

        {/* 连接信息:常驻可编辑,改了保存钮才亮 */}
        <div className="mt-4 space-y-3">
          <div>
            <label className="block text-[11px] text-surface-400 mb-1">Base URL</label>
            <input
              value={draft.baseUrl}
              onChange={e => setDraft({ ...draft, baseUrl: e.target.value })}
              data-testid={`provider-base-url-${prov.id}`}
              className="w-full text-[12.5px] font-mono text-surface-700 bg-surface-50 border border-surface-100 rounded-md px-2.5 py-1.5 outline-none focus:border-brand-400 transition-colors"
            />
          </div>
          <div>
            <label className="block text-[11px] text-surface-400 mb-1">{t('settings.model.provider.apiFormatLabel')}</label>
            <select
              value={draft.apiFormat || 'openai'}
              onChange={e => setDraft({ ...draft, apiFormat: e.target.value })}
              className="w-full text-[12.5px] text-surface-700 bg-surface-50 border border-surface-100 rounded-md px-2.5 py-1.5 outline-none focus:border-brand-400"
            >
              <option value="openai">OpenAI Chat Completions</option>
              <option value="anthropic">Anthropic Messages</option>
              <option value="openai-responses">OpenAI Responses</option>
            </select>
          </div>
          <div>
            <label className="block text-[11px] text-surface-400 mb-1">{t('settings.model.form.apiKeyLabel')}</label>
            <input
              type="password"
              value={draft.apiKey}
              onChange={e => setDraft({ ...draft, apiKey: e.target.value })}
              placeholder={t('settings.model.provider.apiKeyKeepPlaceholder', {
                value: prov.apiKeyMasked || t('settings.model.provider.apiKeyOriginal'),
              })}
              data-testid={`provider-api-key-${prov.id}`}
              className="w-full text-[12.5px] font-mono text-surface-700 bg-surface-50 border border-surface-100 rounded-md px-2.5 py-1.5 outline-none focus:border-brand-400 transition-colors"
            />
          </div>

          {/* 高级:思考协议与预算(testid 沿用 edit-provider-*,既有回归不动) */}
          <div>
            <button
              type="button"
              onClick={() => setAdvancedOpen(o => !o)}
              data-testid={`edit-provider-${prov.id}`}
              aria-expanded={advancedOpen}
              className="flex items-center gap-1 text-[11.5px] text-surface-500 hover:text-surface-700 transition-colors"
            >
              <ChevronDown className={`w-3.5 h-3.5 transition-transform ${advancedOpen ? '' : '-rotate-90'}`} />
              {t('settings.model.provider.advancedToggle')}
              {prov.thinkingBudgets !== undefined && (
                <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-surface-100 text-surface-400">
                  {prov.thinkingBudgets === null
                    ? t('settings.model.provider.qwenToggleBadge')
                    : `Qwen ${prov.thinkingBudgets.low / 1024}K/${prov.thinkingBudgets.medium / 1024}K/${prov.thinkingBudgets.high / 1024}K`}
                </span>
              )}
            </button>
            {advancedOpen && (
              <div className="mt-2 space-y-2">
                <label className="block space-y-1">
                  <span className="block text-[10.5px] text-surface-400">{t('settings.model.provider.defaultThinkingProtocol')}</span>
                  <select
                    value={draft.thinkingFormat}
                    onChange={e => setDraft({ ...draft, thinkingFormat: e.target.value as ProviderDraft['thinkingFormat'] })}
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
                <div className="rounded-md bg-surface-50 dark:bg-surface-50/40 p-2.5 space-y-1.5">
                  <span className="block text-[10.5px] font-medium text-surface-500">
                    {t('settings.model.provider.qwenBudgetTitle')}
                  </span>
                  <ThinkingBudgetEditor
                    mode={draft.thinkingBudgetMode}
                    draft={draft.thinkingBudgetDraft}
                    onModeChange={thinkingBudgetMode => setDraft({ ...draft, thinkingBudgetMode })}
                    onDraftChange={thinkingBudgetDraft => setDraft({ ...draft, thinkingBudgetDraft })}
                    autoLabelKey="settings.model.provider.autoModelStudio"
                    testIdPrefix={`provider-thinking-budget-${prov.id}`}
                  />
                  <p className="text-[10px] text-surface-400">
                    {t('settings.model.provider.inheritanceHelp')}
                  </p>
                </div>
              </div>
            )}
          </div>

          {/* 保存条:常驻,没改动时置灰;有改动多给一个「还原」 */}
          <div className="flex items-center justify-end gap-2">
            {draftDirty && (
              <button
                onClick={() => { setDraft(draftOf(prov)); setRenaming(false) }}
                className="px-2.5 py-1 text-[11px] text-surface-400 hover:text-surface-600 transition-colors"
              >
                {t('settings.model.provider.revert')}
              </button>
            )}
            <button
              onClick={handleSaveProvider}
              disabled={!draftDirty || draftBudgetsInvalid}
              data-testid={`save-provider-${prov.id}`}
              className="px-2.5 py-1 text-[11px] rounded-md bg-brand-500 text-ink-on-accent hover:bg-brand-600 disabled:opacity-40 transition-colors"
            >
              {t('settings.model.provider.saveApplies', { count: prov.modelCount })}
            </button>
          </div>
        </div>

        {/* 模型列表 */}
        <div className="mt-5">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[11px] text-surface-400">{t('settings.model.provider.modelsLabel')}</span>
            <button
              onClick={() => handleAddUnderProvider(prov.id)}
              className="flex items-center gap-1 text-[11px] text-brand-600 dark:text-brand-400 hover:text-brand-700 transition-colors"
              title={t('settings.model.provider.addTitle')}
            >
              <Plus className="w-3 h-3" />
              {t('settings.model.provider.addModel')}
            </button>
          </div>
          <div className="space-y-2">{models.map(renderPresetRow)}</div>
        </div>
      </div>
    )
  })()

  return (
    <div ref={rootRef} className="h-full min-h-0 flex flex-col">
      {presets.length === 0 ? (
        showForm ? (
          <div className="flex-1 min-h-0 overflow-y-auto">{formView}</div>
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center gap-3">
            <p className="text-[12px] text-surface-400">{t('settings.model.preset.empty')}</p>
            <button
              onClick={() => { resetForm(); setFormEntry('provider'); setShowForm(true) }}
              data-testid="model-add-new"
              className="flex items-center gap-1 px-3 py-1.5 rounded-md text-[12px] font-medium bg-brand-500 text-ink-on-accent hover:bg-brand-600 transition-colors"
            >
              <Plus className="w-3.5 h-3.5" />
              {t('settings.model.provider.addProviderAndModel')}
            </button>
          </div>
        )
      ) : wide ? (
        <div className="flex-1 min-h-0 flex rounded-xl border border-surface-100 overflow-hidden">
          <aside className="w-48 shrink-0 border-r border-surface-100 bg-surface-50/60 dark:bg-surface-50/30 min-h-0">
            {rail}
          </aside>
          <section className="flex-1 min-w-0 overflow-y-auto p-4">{showForm ? formView : detail}</section>
        </div>
      ) : showForm ? (
        <div className="flex-1 min-h-0 overflow-y-auto">{formView}</div>
      ) : narrowDetail && selectionValid ? (
        <div className="flex-1 min-h-0 overflow-y-auto">
          <button
            onClick={() => setNarrowDetail(false)}
            data-testid="model-detail-back"
            className="flex items-center gap-1 -ml-1 mb-3 px-1.5 py-1 rounded-md text-[12px] text-surface-500 hover:text-surface-700 hover:bg-surface-50 transition-colors"
          >
            <ChevronLeft className="w-3.5 h-3.5" />
            {t('common.actions.back')}
          </button>
          {detail}
        </div>
      ) : (
        <div className="flex-1 min-h-0 rounded-xl border border-surface-100 overflow-hidden">{rail}</div>
      )}
    </div>
  )
}
