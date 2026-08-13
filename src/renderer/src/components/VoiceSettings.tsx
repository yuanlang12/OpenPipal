import { useState, useEffect, useCallback, useRef } from 'react'
import { Eye, EyeOff, Check, AlertCircle, Mic, Play, Loader2 } from 'lucide-react'
import { AudioEngine } from '../services/audio-engine'
import { useTranslation } from 'react-i18next'
import { toDisplayError, renderDisplayError, type DisplayError } from '../utils/mainError'

// 音色清单 + 风格描述。gaOnly = 仅 gpt-realtime(GA)支持(preview 模型选了会被拒)。
const VOICE_META: Record<string, { label: string; descriptionKey: string; gaOnly?: boolean }> = {
  alloy:   { label: 'Alloy',   descriptionKey: 'settings.voice.voices.alloy' },
  echo:    { label: 'Echo',    descriptionKey: 'settings.voice.voices.echo' },
  shimmer: { label: 'Shimmer', descriptionKey: 'settings.voice.voices.shimmer' },
  ash:     { label: 'Ash',     descriptionKey: 'settings.voice.voices.ash' },
  ballad:  { label: 'Ballad',  descriptionKey: 'settings.voice.voices.ballad' },
  coral:   { label: 'Coral',   descriptionKey: 'settings.voice.voices.coral' },
  sage:    { label: 'Sage',    descriptionKey: 'settings.voice.voices.sage' },
  verse:   { label: 'Verse',   descriptionKey: 'settings.voice.voices.verse' },
  marin:   { label: 'Marin',   descriptionKey: 'settings.voice.voices.marin', gaOnly: true },
  cedar:   { label: 'Cedar',   descriptionKey: 'settings.voice.voices.cedar', gaOnly: true },
  // 豆包全双工 S2S-Omni 音色(仅 4 个 jupiter 音色)
  zh_female_vv_jupiter_bigtts:     { label: 'vivi',  descriptionKey: 'settings.voice.voices.vivi' },
  zh_female_xiaohe_jupiter_bigtts: { label: '小何',  descriptionKey: 'settings.voice.voices.xiaohe' },
  zh_male_yunzhou_jupiter_bigtts:  { label: '云舟',  descriptionKey: 'settings.voice.voices.yunzhou' },
  zh_male_xiaotian_jupiter_bigtts: { label: '小天',  descriptionKey: 'settings.voice.voices.xiaotian' }
}
// 全量渲染顺序(alloy 默认在前);marin/cedar 也列出,带「需 gpt-realtime」标注
const VOICE_LIST = ['alloy', 'echo', 'shimmer', 'ash', 'ballad', 'coral', 'sage', 'verse', 'marin', 'cedar']
const DOUBAO_VOICE_LIST = [
  'zh_female_vv_jupiter_bigtts',
  'zh_female_xiaohe_jupiter_bigtts',
  'zh_male_yunzhou_jupiter_bigtts',
  'zh_male_xiaotian_jupiter_bigtts'
]

interface VoiceConfig {
  provider: string
  baseUrl: string
  apiKey: string
  model: string
  deployment?: string
  apiVersion?: string
  voice?: string
}

type ConnectionStatus = 'idle' | 'testing' | 'success' | 'error'

// Provider 预设（默认 URL / placeholder）
const PROVIDER_PRESETS: Record<
  string,
  { nameKey: string; baseUrl: string; modelPlaceholder: string; voices: string[] }
> = {
  openai: {
    nameKey: 'settings.voice.providers.openai',
    baseUrl: 'https://api.openai.com/v1/realtime',
    modelPlaceholder: 'gpt-4o-realtime-preview-2024-12-17',
    voices: ['alloy', 'echo', 'shimmer', 'ash', 'coral', 'sage', 'verse', 'ballad']
  },
  azure: {
    nameKey: 'settings.voice.providers.azure',
    baseUrl: 'https://<resource>.openai.azure.com',
    modelPlaceholder: 'gpt-realtime-2',
    voices: ['alloy', 'echo', 'shimmer', 'ash', 'coral', 'sage', 'verse', 'ballad', 'marin', 'cedar']
  },
  doubao: {
    nameKey: 'settings.voice.providers.doubao',
    baseUrl: 'wss://openspeech.bytedance.com/api/v3/duplex/realtime/dialogue',
    modelPlaceholder: '1.2.6.0',
    voices: DOUBAO_VOICE_LIST
  }
}

type PreviewError =
  | { kind: 'realtimeOnly'; label: string; detail: DisplayError }
  | { kind: 'generic'; detail: DisplayError }

export function VoiceSettings() {
  const { t } = useTranslation()
  const [provider, setProvider] = useState('openai')
  const [baseUrl, setBaseUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [model, setModel] = useState('')
  const [deployment, setDeployment] = useState('')
  const [apiVersion, setApiVersion] = useState('2025-04-01-preview')
  const [voice, setVoice] = useState('alloy')
  const [showKey, setShowKey] = useState(false)
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('idle')
  const [connectionFailure, setConnectionFailure] = useState<DisplayError>({ key: 'settings.voice.errors.connectionFailed' })
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saved'>('idle')
  // 音色试听
  const [previewing, setPreviewing] = useState<string | null>(null)  // 正在试听的音色
  const [previewError, setPreviewError] = useState<PreviewError | null>(null)
  const engineRef = useRef<AudioEngine | null>(null)

  const loadCurrentConfig = useCallback(async () => {
    const cfg = await window.api.getVoiceConfig?.()
    if (!cfg) return
    setProvider(cfg.provider || 'openai')
    setBaseUrl(cfg.baseUrl || '')
    setApiKey(cfg.apiKey || '')
    setModel(cfg.model || '')
    setDeployment(cfg.deployment || '')
    setApiVersion(cfg.apiVersion || '2025-04-01-preview')
    setVoice(cfg.voice || 'alloy')
  }, [])

  useEffect(() => {
    loadCurrentConfig()
  }, [loadCurrentConfig])

  // 试听音频流:main 把 response.audio.delta 推过来,喂给 AudioEngine 播放
  useEffect(() => {
    const off = window.api.onVoicePreviewAudio?.((b64: string) => {
      if (!engineRef.current) engineRef.current = new AudioEngine()
      engineRef.current.playAudio(b64)
    })
    return () => {
      off?.()
      window.api.stopVoicePreview?.()
      engineRef.current?.destroy()
      engineRef.current = null
    }
  }, [])

  const handlePreview = async (v: string): Promise<void> => {
    setPreviewError(null)
    // 停掉上一段试听(切换音色时)
    window.api.stopVoicePreview?.()
    engineRef.current?.flushPlayback()
    if (!engineRef.current) engineRef.current = new AudioEngine()
    setPreviewing(v)
    // 用当前表单配置 + 指定 voice 试听(不改已保存的选择)
    const r = await window.api.previewVoice?.({ ...buildConfig(), voice: v }, v)
    setPreviewing(null)
    if (r && !r.ok) {
      const meta = VOICE_META[v]
      setPreviewError(
        meta?.gaOnly
          ? { kind: 'realtimeOnly', label: meta.label, detail: toDisplayError(r, 'settings.voice.errors.previewFailed') }
          : { kind: 'generic', detail: toDisplayError(r, 'settings.voice.errors.previewFailed') }
      )
    }
  }

  const handleProviderChange = (p: string): void => {
    setProvider(p)
    const preset = PROVIDER_PRESETS[p]
    // 切换 provider = 换服务 = 换端点, 重置为目标默认端点(跨服务 URL 不通用)
    if (preset) setBaseUrl(preset.baseUrl)
    // 重置音色到目标 provider 合法的默认值(如从 OpenAI 'alloy' 切豆包 → 回退到豆包音色, 防 InvalidSpeaker)
    const list = p === 'doubao' ? DOUBAO_VOICE_LIST : VOICE_LIST
    if (!list.includes(voice)) setVoice(list[0])
    setConnectionStatus('idle')
  }

  const buildConfig = (): VoiceConfig => ({
    provider,
    baseUrl: baseUrl.trim(),
    apiKey: apiKey.trim(),
    model: model.trim(),
    deployment: deployment.trim() || undefined,
    apiVersion: provider === 'azure' ? apiVersion.trim() : undefined,
    voice
  })

  const handleTest = async (): Promise<void> => {
    setConnectionStatus('testing')
    setConnectionFailure({ key: 'settings.voice.errors.connectionFailed' })
    const result = await window.api.testVoiceConnection?.(buildConfig())
    if (!result) {
      setConnectionStatus('error')
      setConnectionFailure({ key: 'settings.voice.errors.testUnsupported' })
      return
    }
    if (result.ok) {
      setConnectionStatus('success')
      setTimeout(() => setConnectionStatus((s) => (s === 'success' ? 'idle' : s)), 3000)
    } else {
      setConnectionStatus('error')
      setConnectionFailure(toDisplayError(result, 'settings.voice.errors.connectionFailed'))
    }
  }

  const handleSave = async (): Promise<void> => {
    await window.api.saveVoiceConfig?.(buildConfig())
    setSaveStatus('saved')
    setTimeout(() => setSaveStatus('idle'), 2000)
  }

  const preset = PROVIDER_PRESETS[provider] || PROVIDER_PRESETS.openai
  const isDoubao = provider === 'doubao'
  // 豆包只展示其 4 个音色; OpenAI/Azure 沿用全量列表(含 gaOnly marin/cedar)
  const voiceList = isDoubao ? DOUBAO_VOICE_LIST : VOICE_LIST

  return (
    <div className="space-y-4" data-testid="voice-settings">
      {/* Header */}
      <div className="flex items-center gap-2 pb-2 border-b border-surface-100">
        <Mic className="w-4 h-4 text-brand-500" />
        <h3 className="text-[13px] font-semibold text-surface-700">
          {t('settings.voice.title')}
        </h3>
      </div>

      <p className="text-[11px] text-surface-400 leading-relaxed">
        {t('settings.voice.description')}
      </p>

      {/* Provider 选择 */}
      <div>
        <label className="block text-[11px] font-medium text-surface-500 mb-1.5">
          {t('settings.voice.providerLabel')}
        </label>
        <select
          value={provider}
          onChange={(e) => handleProviderChange(e.target.value)}
          className="w-full px-3 py-1.5 text-[12px] rounded-md border border-surface-200 bg-surface-0 dark:bg-surface-50 text-surface-700 focus:outline-none focus:border-brand-500"
          data-testid="voice-provider-select"
        >
          {Object.entries(PROVIDER_PRESETS).map(([key, p]) => (
            <option key={key} value={key}>
              {t(p.nameKey)}
            </option>
          ))}
        </select>
      </div>

      {/* Endpoint URL */}
      <div>
        <label className="block text-[11px] font-medium text-surface-500 mb-1.5">
          {provider === 'azure' ? t('settings.voice.azureEndpointLabel') : t('settings.voice.apiUrlLabel')}
        </label>
        <input
          type="text"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          placeholder={preset.baseUrl}
          className="w-full px-3 py-1.5 text-[12px] rounded-md border border-surface-200 bg-surface-0 dark:bg-surface-50 text-surface-700 focus:outline-none focus:border-brand-500 font-mono"
          data-testid="voice-baseurl-input"
        />
        {provider === 'azure' && (
          <p className="text-[10px] text-surface-400 mt-1">
            {t('settings.voice.azureEndpointHelp')}
          </p>
        )}
      </div>

      {/* API Key */}
      <div>
        <label className="block text-[11px] font-medium text-surface-500 mb-1.5">
          {t('settings.voice.apiKeyLabel')}
        </label>
        <div className="relative">
          <input
            type={showKey ? 'text' : 'password'}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={provider === 'azure'
              ? t('settings.voice.azureKeyPlaceholder')
              : isDoubao
                ? t('settings.voice.doubaoKeyPlaceholder')
                : 'sk-...'}
            className="w-full px-3 py-1.5 pr-8 text-[12px] rounded-md border border-surface-200 bg-surface-0 dark:bg-surface-50 text-surface-700 focus:outline-none focus:border-brand-500 font-mono"
            data-testid="voice-apikey-input"
          />
          <button
            type="button"
            onClick={() => setShowKey((v) => !v)}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-surface-400 hover:text-surface-600"
            title={showKey ? t('settings.voice.hideApiKey') : t('settings.voice.showApiKey')}
          >
            {showKey ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
          </button>
        </div>
      </div>

      {/* App ID（豆包全双工握手需 X-Api-App-Id + X-Api-Key 两者；复用 deployment 字段承载） */}
      {isDoubao && (
        <div>
          <label className="block text-[11px] font-medium text-surface-500 mb-1.5">
            {t('settings.voice.appIdLabel')}
          </label>
          <input
            type="text"
            value={deployment}
            onChange={(e) => setDeployment(e.target.value)}
            placeholder={t('settings.voice.appIdPlaceholder')}
            className="w-full px-3 py-1.5 text-[12px] rounded-md border border-surface-200 bg-surface-0 dark:bg-surface-50 text-surface-700 focus:outline-none focus:border-brand-500 font-mono"
            data-testid="voice-appid-input"
          />
        </div>
      )}

      {/* Model / Deployment —— 豆包 model 固定 1.2.6.0, 不展示 */}
      {!isDoubao && (
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label className="block text-[11px] font-medium text-surface-500 mb-1.5">
            {provider === 'azure' ? t('settings.voice.azureModelLabel') : t('settings.voice.modelLabel')}
          </label>
          <input
            type="text"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder={preset.modelPlaceholder}
            className="w-full px-3 py-1.5 text-[12px] rounded-md border border-surface-200 bg-surface-0 dark:bg-surface-50 text-surface-700 focus:outline-none focus:border-brand-500 font-mono"
            data-testid="voice-model-input"
          />
        </div>
        {provider === 'azure' && (
          <div>
            <label className="block text-[11px] font-medium text-surface-500 mb-1.5">
              {t('settings.voice.deploymentLabel')}
            </label>
            <input
              type="text"
              value={deployment}
              onChange={(e) => setDeployment(e.target.value)}
              placeholder={t('settings.voice.deploymentPlaceholder')}
              className="w-full px-3 py-1.5 text-[12px] rounded-md border border-surface-200 bg-surface-0 dark:bg-surface-50 text-surface-700 focus:outline-none focus:border-brand-500 font-mono"
              data-testid="voice-deployment-input"
            />
          </div>
        )}
      </div>
      )}

      {/* api-version (Azure only) */}
      {provider === 'azure' && (
        <div>
          <label className="block text-[11px] font-medium text-surface-500 mb-1.5">
            {t('settings.voice.apiVersionLabel')}
          </label>
          <input
            type="text"
            value={apiVersion}
            onChange={(e) => setApiVersion(e.target.value)}
            placeholder="2025-04-01-preview"
            className="w-full px-3 py-1.5 text-[12px] rounded-md border border-surface-200 bg-surface-0 dark:bg-surface-50 text-surface-700 focus:outline-none focus:border-brand-500 font-mono"
            data-testid="voice-apiversion-input"
          />
        </div>
      )}

      {/* Voice 风格 —— 卡片网格 + 逐个试听 */}
      <div>
        <label className="block text-[11px] font-medium text-surface-500 mb-1.5">
          {t('settings.voice.style.label')} <span className="text-surface-300">{t('settings.voice.style.hint')}</span>
        </label>
        <div className="grid grid-cols-2 gap-2" data-testid="voice-card-grid">
          {voiceList.map((v) => {
            const meta = VOICE_META[v]
            const selected = voice === v
            const isPreviewing = previewing === v
            // 豆包试听走的是 OpenAI provider 接口, 暂不支持 → 禁用, 直接通话即可听
            const canPreview = !!apiKey && !!baseUrl && !previewing && !isDoubao
            return (
              <div
                key={v}
                data-testid={`voice-card-${v}`}
                data-selected={selected}
                className={`flex items-center gap-2 px-2.5 py-2 rounded-lg border transition-colors ${
                  selected
                    ? 'border-brand-500 bg-brand-50/60 dark:bg-brand-900/20'
                    : 'border-surface-200 hover:border-surface-300'
                }`}
              >
                <button
                  type="button"
                  onClick={() => setVoice(v)}
                  className="flex-1 min-w-0 text-left"
                  data-testid={`voice-select-${v}`}
                >
                  <div className="flex items-center gap-1.5">
                    <span className="text-[12px] font-medium text-surface-700 min-w-0 break-words">
                      {meta.label}
                    </span>
                    {selected && <Check className="w-3 h-3 text-brand-500 shrink-0" />}
                  </div>
                  <div className="mt-0.5 flex items-start gap-1 flex-wrap">
                    <span className="text-[10px] text-surface-400 min-w-0 break-words leading-tight">
                      {t(meta.descriptionKey)}
                    </span>
                    {meta.gaOnly && (
                      <span className="text-[9px] px-1 py-0.5 rounded bg-amber-50 dark:bg-amber-900/30 text-amber-600 dark:text-amber-400 shrink-0">
                        {t('settings.voice.style.realtimeRequired')}
                      </span>
                    )}
                  </div>
                </button>
                <button
                  type="button"
                  onClick={() => handlePreview(v)}
                  disabled={!canPreview}
                  title={canPreview
                    ? t('settings.voice.style.preview')
                    : isDoubao
                      ? t('settings.voice.style.previewDoubaoUnavailable')
                      : t('settings.voice.style.previewNeedsCredentials')}
                  className="shrink-0 w-7 h-7 flex items-center justify-center rounded-md border border-surface-200 text-surface-500 hover:bg-surface-100 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                  data-testid={`voice-preview-${v}`}
                >
                  {isPreviewing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
                </button>
              </div>
            )
          })}
        </div>
        {previewError && (
          <p className="mt-1.5 text-[10px] text-rose-600 dark:text-rose-400 flex items-start gap-1" data-testid="voice-preview-error">
            <AlertCircle className="w-3 h-3 shrink-0 mt-px" />
            <span className="min-w-0 break-words">
              {previewError.kind === 'realtimeOnly'
                ? t('settings.voice.errors.previewRealtimeOnly', {
                    label: previewError.label,
                    error: renderDisplayError(t, previewError.detail),
                  })
                : renderDisplayError(t, previewError.detail)}
            </span>
          </p>
        )}
      </div>

      {/* 测试连接 + 保存 */}
      <div className="flex items-center gap-2 pt-2 flex-wrap">
        <button
          onClick={handleTest}
          disabled={connectionStatus === 'testing' || !apiKey || !baseUrl}
          className="px-3 py-1.5 text-[12px] font-medium rounded-md border border-surface-200 text-surface-600 hover:bg-surface-100 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          data-testid="voice-test-btn"
        >
          {connectionStatus === 'testing' ? t('settings.voice.actions.testing') : t('settings.voice.actions.testConnection')}
        </button>
        <button
          onClick={handleSave}
          disabled={!apiKey || !baseUrl}
          className="px-3 py-1.5 text-[12px] font-medium rounded-md bg-brand-500 text-ink-on-accent hover:bg-brand-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          data-testid="voice-save-btn"
        >
          {saveStatus === 'saved' ? t('settings.voice.actions.saved') : t('settings.voice.actions.save')}
        </button>

        {connectionStatus === 'success' && (
          <span className="text-[11px] text-emerald-600 dark:text-emerald-400 flex items-center gap-1">
            <Check className="w-3 h-3" /> {t('settings.voice.status.connectionSuccess')}
          </span>
        )}
        {connectionStatus === 'error' && (
          <span className="text-[11px] text-rose-600 dark:text-rose-400 flex items-start gap-1 flex-1 min-w-0 break-words" title={renderDisplayError(t, connectionFailure)}>
            <AlertCircle className="w-3 h-3 shrink-0 mt-px" /> {renderDisplayError(t, connectionFailure)}
          </span>
        )}
      </div>

      <p className="text-[10px] text-surface-300 pt-2 border-t border-surface-100">
        {t('settings.voice.savedHint')}
      </p>
    </div>
  )
}
