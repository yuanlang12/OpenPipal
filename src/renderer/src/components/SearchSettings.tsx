import { useState, useEffect, useCallback } from 'react'
import { Eye, EyeOff, Check, AlertCircle, Search } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toDisplayError, renderDisplayError, type DisplayError } from '../utils/mainError'

type ConnectionStatus = 'idle' | 'testing' | 'success' | 'error'

// v1 只有 Tavily。留成清单是为了下一个服务商进来时不用改结构。
const PROVIDERS: { key: 'tavily'; nameKey: string }[] = [
  { key: 'tavily', nameKey: 'settings.search.providers.tavily' }
]

export function SearchSettings() {
  const { t } = useTranslation()
  // 输入框永远从空开始:主进程只下发掩码,回填掩码等于把「••••••」当成真 key 提交。
  // 空串 = 保留已保存的值(与模型/服务商编辑同一约定)。
  const [apiKey, setApiKey] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [builtin, setBuiltin] = useState(false)
  const [configured, setConfigured] = useState(false)
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('idle')
  const [connectionFailure, setConnectionFailure] = useState<DisplayError>({ key: 'settings.search.errors.connectionFailed' })
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saved'>('idle')

  const loadCurrentConfig = useCallback(async () => {
    const cfg = await window.api.getSearchConfig?.()
    if (!cfg) return
    setBuiltin(!!cfg.builtin)
    setConfigured(!!cfg.configured)
  }, [])

  useEffect(() => {
    loadCurrentConfig()
  }, [loadCurrentConfig])

  // 已保存了自己的 key(生效配置有 key 且不是内置回退)
  const isCustom = configured && !builtin

  const handleTest = async (): Promise<void> => {
    setConnectionStatus('testing')
    const result = await window.api.testSearchConnection?.(apiKey.trim() || undefined)
    if (!result) {
      setConnectionStatus('error')
      setConnectionFailure({ key: 'settings.search.errors.testUnsupported' })
      return
    }
    if (result.ok) {
      setConnectionStatus('success')
      setTimeout(() => setConnectionStatus((s) => (s === 'success' ? 'idle' : s)), 3000)
    } else {
      setConnectionStatus('error')
      setConnectionFailure(toDisplayError(result, 'settings.search.errors.connectionFailed'))
    }
  }

  const handleSave = async (): Promise<void> => {
    const result = await window.api.saveSearchConfig?.({ provider: 'tavily', apiKey: apiKey.trim() })
    if (result && result.ok === false) {
      setConnectionStatus('error')
      setConnectionFailure(toDisplayError(result, 'settings.search.errors.connectionFailed'))
      return
    }
    setApiKey('')
    setSaveStatus('saved')
    setTimeout(() => setSaveStatus('idle'), 2000)
    await loadCurrentConfig()
  }

  const handleRestoreBuiltin = async (): Promise<void> => {
    const result = await window.api.clearSearchConfig?.()
    if (result && result.ok === false) {
      setConnectionStatus('error')
      setConnectionFailure(toDisplayError(result, 'settings.search.errors.connectionFailed'))
      return
    }
    setApiKey('')
    setConnectionStatus('idle')
    await loadCurrentConfig()
  }

  return (
    <div className="space-y-4" data-testid="search-settings">
      {/* Header */}
      <div className="flex items-center gap-2 pb-2 border-b border-surface-100">
        <Search className="w-4 h-4 text-brand-500" />
        <h3 className="text-[13px] font-semibold text-surface-700">
          {t('settings.search.title')}
        </h3>
      </div>

      <p className="text-[11px] text-surface-400 leading-relaxed">
        {t('settings.search.description')}
      </p>

      {/* 当前生效来源 */}
      <div
        className={`flex items-start gap-1.5 px-3 py-2 rounded-md text-[11px] ${
          configured
            ? 'bg-surface-50 text-surface-500'
            : 'bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-400'
        }`}
        data-testid="search-source"
        data-source={configured ? (builtin ? 'builtin' : 'custom') : 'missing'}
      >
        {configured
          ? <Check className="w-3 h-3 shrink-0 mt-0.5" />
          : <AlertCircle className="w-3 h-3 shrink-0 mt-0.5" />}
        <span className="min-w-0 break-words">
          {configured
            ? builtin
              ? t('settings.search.source.builtin')
              : t('settings.search.source.custom')
            : t('settings.search.source.missing')}
        </span>
      </div>

      {/* Provider 选择（v1 只有 Tavily） */}
      <div>
        <label className="block text-[11px] font-medium text-surface-500 mb-1.5">
          {t('settings.search.providerLabel')}
        </label>
        <select
          defaultValue="tavily"
          className="w-full px-3 py-1.5 text-[12px] rounded-md border border-surface-200 bg-surface-0 dark:bg-surface-50 text-surface-700 focus:outline-none focus:border-brand-500"
          data-testid="search-provider-select"
        >
          {PROVIDERS.map((p) => (
            <option key={p.key} value={p.key}>
              {t(p.nameKey)}
            </option>
          ))}
        </select>
      </div>

      {/* API Key */}
      <div>
        <label className="block text-[11px] font-medium text-surface-500 mb-1.5">
          {t('settings.search.apiKeyLabel')}
        </label>
        <div className="relative">
          <input
            type={showKey ? 'text' : 'password'}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={isCustom
              ? t('settings.search.apiKeyKeepPlaceholder')
              : t('settings.search.apiKeyPlaceholder')}
            className="w-full px-3 py-1.5 pr-8 text-[12px] rounded-md border border-surface-200 bg-surface-0 dark:bg-surface-50 text-surface-700 focus:outline-none focus:border-brand-500 font-mono"
            data-testid="search-apikey-input"
          />
          <button
            type="button"
            onClick={() => setShowKey((v) => !v)}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-surface-400 hover:text-surface-600"
            title={showKey ? t('settings.search.hideApiKey') : t('settings.search.showApiKey')}
          >
            {showKey ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
          </button>
        </div>
        <p className="text-[10px] text-surface-400 mt-1">
          {t('settings.search.apiKeyHint')}
        </p>
      </div>

      {/* 测试连接 + 保存 + 恢复内置 */}
      <div className="flex items-center gap-2 pt-2 flex-wrap">
        <button
          onClick={handleTest}
          disabled={connectionStatus === 'testing' || (!apiKey.trim() && !configured)}
          className="px-3 py-1.5 text-[12px] font-medium rounded-md border border-surface-200 text-surface-600 hover:bg-surface-100 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          data-testid="search-test-btn"
        >
          {connectionStatus === 'testing' ? t('settings.search.actions.testing') : t('settings.search.actions.testConnection')}
        </button>
        <button
          onClick={handleSave}
          disabled={!apiKey.trim()}
          className="px-3 py-1.5 text-[12px] font-medium rounded-md bg-brand-500 text-ink-on-accent hover:bg-brand-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          data-testid="search-save-btn"
        >
          {saveStatus === 'saved' ? t('settings.search.actions.saved') : t('settings.search.actions.save')}
        </button>
        {isCustom && (
          <button
            onClick={handleRestoreBuiltin}
            className="px-3 py-1.5 text-[12px] font-medium rounded-md border border-surface-200 text-surface-600 hover:bg-surface-100 transition-colors"
            data-testid="search-restore-btn"
          >
            {t('settings.search.actions.restoreBuiltin')}
          </button>
        )}

        {connectionStatus === 'success' && (
          <span className="text-[11px] text-emerald-600 dark:text-emerald-400 flex items-center gap-1">
            <Check className="w-3 h-3" /> {t('settings.search.status.connectionSuccess')}
          </span>
        )}
        {connectionStatus === 'error' && (
          <span className="text-[11px] text-rose-600 dark:text-rose-400 flex items-start gap-1 flex-1 min-w-0 break-words" title={renderDisplayError(t, connectionFailure)}>
            <AlertCircle className="w-3 h-3 shrink-0 mt-px" /> {renderDisplayError(t, connectionFailure)}
          </span>
        )}
      </div>

      <p className="text-[10px] text-surface-300 pt-2 border-t border-surface-100">
        {t('settings.search.savedHint')}
      </p>
    </div>
  )
}
