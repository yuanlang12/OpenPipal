import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Puzzle, Wrench, Zap, Plus, Trash2, Loader2, CheckCircle, XCircle, Server, Terminal, FolderOpen, GitBranch, AlertTriangle } from 'lucide-react'
import { SkillsHub } from './SkillsHub'
import { resolveCliToolDisplay } from '../i18n/cliToolDisplay'
import { toDisplayError, type DisplayError } from '../utils/mainError'

// 概念口径:「插件」=Agent Plugins 标准包(技能+工具的集合);「工具」=MCP 服务器+CLI;「技能」=SKILL.md
type HubTab = 'plugins' | 'skills' | 'tools'

const TABS: { key: HubTab; labelKey: string; icon: React.ReactNode }[] = [
  { key: 'plugins', labelKey: 'toolsHub.tabs.plugins', icon: <Puzzle className="w-4 h-4" /> },
  { key: 'skills', labelKey: 'toolsHub.tabs.skills', icon: <Zap className="w-4 h-4" /> },
  { key: 'tools', labelKey: 'toolsHub.tabs.tools', icon: <Wrench className="w-4 h-4" /> },
]

export function ToolsHub() {
  const { t } = useTranslation()
  const [activeTab, setActiveTab] = useState<HubTab>('plugins')

  return (
    <div className="flex flex-col h-full">
      <div className="shrink-0 pt-6 px-4 sm:px-8 pb-0">
        <h1 className="text-xl font-bold text-surface-700">{t('toolsHub.title')}</h1>
        <p className="text-[13px] text-surface-400 mt-0.5">
          {t('toolsHub.subtitle')}
        </p>
        <div role="tablist" aria-label={t('toolsHub.tabListLabel')} className="flex gap-0 mt-4 border-b border-surface-100 overflow-x-auto">
          {TABS.map(tab => (
            <button
              role="tab"
              aria-selected={activeTab === tab.key}
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`flex items-center gap-2 px-4 py-2.5 text-[13px] font-medium border-b-2 -mb-px transition-colors ${
                activeTab === tab.key
                  ? 'border-brand-500 text-brand-600 dark:text-brand-400'
                  : 'border-transparent text-surface-400 hover:text-surface-600'
              }`}
            >
              {tab.icon}
              {t(tab.labelKey)}
            </button>
          ))}
        </div>
      </div>
      <div className="flex-1 overflow-y-auto">
        {activeTab === 'plugins' && <PluginsTab />}
        {activeTab === 'tools' && <McpToolsTab />}
        {activeTab === 'skills' && <div className="px-4 sm:px-8 py-4"><SkillsHub /></div>}
      </div>
    </div>
  )
}

// ---- types ----

interface McpServerStatus {
  name: string
  // 二选一:stdio(command)或 remote(url)
  config: {
    command?: string
    args?: string[]
    env?: Record<string, string>
    url?: string
    headers?: Record<string, string>
    oauth?: boolean
  }
  connected: boolean
  toolCount: number
  builtIn: boolean
  error?: string
  oauthState?: 'authorized' | 'needs-auth'
  /** 由 Agent Plugins 插件提供时为插件名 */
  pluginName?: string
}

interface CliToolInfo {
  name: string
  command: string
  description: string
  category: string
  builtIn: boolean
  installed?: boolean
  version?: string
}

interface EnvRow { key: string; value: string }

// ---- McpToolsTab:MCP 服务器 + CLI 工具管理(曾用名 PluginsTab,"插件"一词已让位给 Agent Plugins 标准包) ----

function McpToolsTab() {
  const { t } = useTranslation()
  const [servers, setServers] = useState<McpServerStatus[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)

  // form state
  const [formType, setFormType] = useState<'npm' | 'custom' | 'remote'>('npm')
  const [formName, setFormName] = useState('')
  const [formPackage, setFormPackage] = useState('')
  const [formCommand, setFormCommand] = useState('')
  const [formArgs, setFormArgs] = useState('')
  const [formEnv, setFormEnv] = useState<EnvRow[]>([])
  const [formUrl, setFormUrl] = useState('')
  const [formHeaders, setFormHeaders] = useState<EnvRow[]>([])
  const [formOAuth, setFormOAuth] = useState(false)
  const [authorizingName, setAuthorizingName] = useState<string | null>(null)
  const [testResult, setTestResult] = useState<{ ok: boolean; toolCount?: number; error?: string } | null>(null)
  const [isTesting, setIsTesting] = useState(false)
  const [isSaving, setIsSaving] = useState(false)

  const load = useCallback(async () => {
    setIsLoading(true)
    const result = await window.api.listMcpServers()
    setServers(result)
    setIsLoading(false)
  }, [])

  useEffect(() => {
    load()
    // 窗口解锁后 MCP 连接在后台并行进行，之前"mount 时查一次"的假设(连接必然先于窗口)不再成立——
    // 订阅渐进就绪推送，每个 server 连接完成(成败都算)就刷新列表
    if (!window.api?.onMcpServersUpdated) return
    const unsub = window.api.onMcpServersUpdated((status: McpServerStatus[]) => setServers(status))
    return unsub
  }, [load])

  // 从 npm 包名推导服务器名
  const deriveName = (pkg: string) => pkg.split('/').pop()?.replace(/[^a-z0-9-]/gi, '-') || ''

  const handlePackageChange = (pkg: string) => {
    setFormPackage(pkg)
    if (!formName || formName === deriveName(formPackage)) {
      setFormName(deriveName(pkg))
    }
    setTestResult(null)
  }

  const buildConfig = () => {
    if (formType === 'remote') {
      const headers: Record<string, string> = {}
      for (const row of formHeaders) {
        if (row.key.trim()) headers[row.key.trim()] = row.value
      }
      const cfg: any = { url: formUrl.trim(), headers }
      if (formOAuth) cfg.oauth = true
      return cfg
    }
    const env: Record<string, string> = {}
    for (const row of formEnv) {
      if (row.key.trim()) env[row.key.trim()] = row.value
    }
    if (formType === 'npm') {
      return { command: 'npx', args: ['-y', formPackage.trim()], env }
    }
    return { command: formCommand.trim(), args: formArgs.trim() ? formArgs.trim().split(/\s+/) : [], env }
  }

  const handleTest = async () => {
    setIsTesting(true)
    setTestResult(null)
    const result = await window.api.testMcpServer(buildConfig())
    setTestResult(result)
    setIsTesting(false)
  }

  const handleSave = async () => {
    const name = formName.trim()
    if (!name) return
    setIsSaving(true)
    await window.api.addMcpServer(name, buildConfig())
    setIsSaving(false)
    resetForm()
    await load()
  }

  const handleDelete = async (name: string) => {
    await window.api.removeMcpServer(name)
    setConfirmDelete(null)
    await load()
  }

  const resetForm = () => {
    setShowForm(false)
    setFormType('npm')
    setFormName('')
    setFormPackage('')
    setFormCommand('')
    setFormArgs('')
    setFormEnv([])
    setFormUrl('')
    setFormHeaders([])
    setFormOAuth(false)
    setTestResult(null)
  }

  const handleAuthorize = async (name: string) => {
    setAuthorizingName(name)
    const r = await window.api.authorizeMcpServer?.(name)
    setAuthorizingName(null)
    if (r?.error) alert(t('toolsHub.mcp.authorizationFailed', { error: r.errorKey ? t(r.errorKey, r.errorParams) : r.error }))
    await load()
  }

  const handleRevoke = async (name: string) => {
    await window.api.revokeMcpServerAuth?.(name)
    setConfirmDelete(null)
    await load()
  }

  const hasRequiredInput = (
    formType === 'npm' ? !!formPackage.trim() :
    formType === 'custom' ? !!formCommand.trim() :
    !!formUrl.trim()
  )
  const canSave = !!formName.trim() && hasRequiredInput && !isSaving

  return (
    <div className="px-4 sm:px-8 py-6 space-y-6">
      {/* MCP 服务器区块 */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <Server className="w-4 h-4 text-surface-400" />
            <span className="text-[13px] font-semibold text-surface-600">{t('toolsHub.mcp.title')}</span>
          </div>
          {!showForm && (
            <button
              onClick={() => setShowForm(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[12px] font-medium bg-brand-500 text-ink-on-accent hover:bg-brand-600 transition-colors"
            >
              <Plus className="w-3.5 h-3.5" /> {t('common.actions.add')}
            </button>
          )}
        </div>

        {/* 服务器列表 */}
        {isLoading ? (
          <div className="flex items-center gap-2 py-4 text-surface-300">
            <Loader2 className="w-4 h-4 animate-spin" />
            <span className="text-[12px]">{t('common.status.loading')}</span>
          </div>
        ) : servers.length === 0 && !showForm ? (
          <div className="py-6 text-center border border-dashed border-surface-200 rounded-lg">
            <p className="text-[12px] text-surface-400">{t('toolsHub.mcp.empty')}</p>
            <p className="text-[11px] text-surface-300 mt-0.5">{t('toolsHub.mcp.emptyHint')}</p>
          </div>
        ) : (
          <div className="space-y-1">
            {servers.map(s => (
              <div key={s.name} className="flex flex-wrap items-center gap-3 px-3 py-2.5 rounded-lg bg-surface-50 dark:bg-surface-50/50 border border-surface-100">
                {/* 状态点 */}
                <span className={`w-2 h-2 rounded-full shrink-0 ${
                  s.connected ? 'bg-green-400' :
                  s.oauthState === 'needs-auth' ? 'bg-amber-400' : 'bg-red-400'
                }`} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-[13px] font-medium text-surface-700 truncate" title={s.name}>{s.name}</span>
                    {s.builtIn && <span className="text-[10px] px-1.5 py-0.5 rounded bg-surface-100 text-surface-400">{t('toolsHub.badges.builtIn')}</span>}
                    {s.pluginName && <span className="text-[10px] px-1.5 py-0.5 rounded bg-brand-50 dark:bg-brand-900/30 text-brand-600 dark:text-brand-300 truncate max-w-full" title={t('toolsHub.mcp.providedByPluginTitle', { name: s.pluginName })}>{t('toolsHub.badges.pluginWithName', { name: s.pluginName })}</span>}
                    {s.config.url && <span className="text-[10px] px-1.5 py-0.5 rounded bg-surface-100 text-surface-400">{t('toolsHub.badges.remote')}</span>}
                    {s.config.oauth && <span className="text-[10px] px-1.5 py-0.5 rounded bg-brand-50 dark:bg-brand-900/30 text-brand-600 dark:text-brand-300">OAuth</span>}
                  </div>
                  <span className="block text-[11px] text-surface-400 break-all">
                    {s.connected ? t('toolsHub.counts.tools', { count: s.toolCount }) :
                     s.oauthState === 'needs-auth' ? t('toolsHub.mcp.needsAuthorization') :
                     (s.error || t('toolsHub.mcp.connectionFailed'))}
                  </span>
                </div>
                {/* OAuth 操作按钮 */}
                {s.config.oauth && !s.connected && (
                  <button
                    onClick={() => handleAuthorize(s.name)}
                    disabled={authorizingName === s.name}
                    className="shrink-0 px-2.5 py-1 text-[11px] font-medium rounded-md bg-brand-500 hover:bg-brand-600 text-ink-on-accent disabled:opacity-50 transition-colors"
                  >
                    {authorizingName === s.name ? t('toolsHub.mcp.waitingForBrowser') : t('toolsHub.mcp.authorize')}
                  </button>
                )}
                {s.config.oauth && s.connected && (
                  <button
                    onClick={() => handleRevoke(s.name)}
                    className="shrink-0 px-2.5 py-1 text-[11px] font-medium rounded-md border border-surface-200 text-surface-500 hover:bg-surface-100 transition-colors"
                    title={t('toolsHub.mcp.revokeTitle')}
                  >
                    {t('toolsHub.mcp.revoke')}
                  </button>
                )}
                {/* 删除按钮(插件提供的 server 生命周期随插件走,这里不给删除入口) */}
                {!s.builtIn && !s.pluginName && (
                  confirmDelete === s.name ? (
                    <div className="flex items-center gap-2 shrink-0">
                      <span className="text-[11px] text-surface-400">{t('common.confirmDelete')}</span>
                      <button onClick={() => handleDelete(s.name)} className="text-[11px] text-red-500 hover:text-red-600 font-medium">{t('common.actions.delete')}</button>
                      <button onClick={() => setConfirmDelete(null)} className="text-[11px] text-surface-400 hover:text-surface-600">{t('common.actions.cancel')}</button>
                    </div>
                  ) : (
                    <button
                      onClick={() => { setConfirmDelete(s.name); setTimeout(() => setConfirmDelete(null), 4000) }}
                      aria-label={t('toolsHub.mcp.deleteServer', { name: s.name })}
                      className="shrink-0 p-1 text-surface-300 hover:text-red-400 transition-colors"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  )
                )}
              </div>
            ))}
          </div>
        )}

        {/* 添加表单 */}
        {showForm && (
          <div className="mt-3 p-4 border border-surface-200 rounded-lg bg-surface-50 dark:bg-surface-50/30 space-y-3">
            {/* 类型选择 */}
            <div className="flex gap-4">
              {(['npm', 'custom', 'remote'] as const).map(type => (
                <label key={type} className="flex items-center gap-2 cursor-pointer">
                  <input type="radio" checked={formType === type} onChange={() => { setFormType(type); setTestResult(null) }}
                    className="accent-brand-500" />
                  <span className="text-[12px] text-surface-600">
                    {type === 'npm' ? t('toolsHub.mcp.types.npm') : type === 'custom' ? t('toolsHub.mcp.types.custom') : t('toolsHub.mcp.types.remote')}
                  </span>
                </label>
              ))}
            </div>

            {formType === 'npm' ? (
              <div>
                <label className="block text-[11px] font-medium text-surface-500 mb-1">{t('toolsHub.mcp.packageName')}</label>
                <input
                  value={formPackage}
                  onChange={e => handlePackageChange(e.target.value)}
                  placeholder={t('toolsHub.mcp.packagePlaceholder')}
                  className="w-full px-3 py-1.5 text-[12px] rounded-md border border-surface-200 bg-white dark:bg-surface-0 text-surface-700 focus:outline-none focus:border-brand-400 focus:ring-1 focus:ring-brand-100"
                />
                <p className="text-[10px] text-surface-300 mt-1">{t('toolsHub.mcp.packageRunHint')}</p>
              </div>
            ) : formType === 'custom' ? (
              <div className="space-y-2">
                <div>
                  <label className="block text-[11px] font-medium text-surface-500 mb-1">{t('toolsHub.mcp.command')}</label>
                  <input value={formCommand} onChange={e => { setFormCommand(e.target.value); setTestResult(null) }}
                    placeholder={t('toolsHub.mcp.commandPlaceholder')}
                    className="w-full px-3 py-1.5 text-[12px] rounded-md border border-surface-200 bg-white dark:bg-surface-0 text-surface-700 focus:outline-none focus:border-brand-400 focus:ring-1 focus:ring-brand-100" />
                </div>
                <div>
                  <label className="block text-[11px] font-medium text-surface-500 mb-1">{t('toolsHub.mcp.arguments')}</label>
                  <input value={formArgs} onChange={e => setFormArgs(e.target.value)}
                    placeholder={t('toolsHub.mcp.argumentsPlaceholder')}
                    className="w-full px-3 py-1.5 text-[12px] rounded-md border border-surface-200 bg-white dark:bg-surface-0 text-surface-700 focus:outline-none focus:border-brand-400 focus:ring-1 focus:ring-brand-100" />
                </div>
              </div>
            ) : (
              <div className="space-y-2">
                <div>
                  <label className="block text-[11px] font-medium text-surface-500 mb-1">{t('toolsHub.mcp.serverUrl')}</label>
                  <input value={formUrl} onChange={e => { setFormUrl(e.target.value); setTestResult(null) }}
                    placeholder={t('toolsHub.mcp.serverUrlPlaceholder')}
                    className="w-full px-3 py-1.5 text-[12px] rounded-md border border-surface-200 bg-white dark:bg-surface-0 text-surface-700 focus:outline-none focus:border-brand-400 focus:ring-1 focus:ring-brand-100" />
                  <p className="text-[10px] text-surface-300 mt-1 break-words">{t('toolsHub.mcp.remoteHint')}</p>
                </div>
                <label className="flex items-start gap-2 cursor-pointer p-2 rounded-md border border-surface-200 hover:bg-surface-50 dark:hover:bg-surface-50/30">
                  <input type="checkbox" checked={formOAuth} onChange={e => { setFormOAuth(e.target.checked); setTestResult(null) }}
                    className="sw-checkbox mt-0.5" />
                  <div className="flex-1">
                    <div className="text-[12px] text-surface-600 font-medium">{t('toolsHub.mcp.useOAuth')}</div>
                    <p className="text-[10px] text-surface-300 mt-0.5">{t('toolsHub.mcp.oauthHint')}</p>
                  </div>
                </label>
              </div>
            )}

            {/* 服务器名称 */}
            <div>
              <label className="block text-[11px] font-medium text-surface-500 mb-1">{t('toolsHub.mcp.serverName')}</label>
              <input value={formName} onChange={e => setFormName(e.target.value)}
                placeholder={t('toolsHub.mcp.serverNamePlaceholder')}
                className="w-full px-3 py-1.5 text-[12px] rounded-md border border-surface-200 bg-white dark:bg-surface-0 text-surface-700 focus:outline-none focus:border-brand-400 focus:ring-1 focus:ring-brand-100" />
            </div>

            {/* 环境变量(stdio) / Headers(remote) */}
            {formType !== 'remote' ? (
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-[11px] font-medium text-surface-500">{t('toolsHub.mcp.environmentVariables')}</label>
                  <button onClick={() => setFormEnv(prev => [...prev, { key: '', value: '' }])}
                    className="text-[10px] text-brand-500 hover:text-brand-600">+ {t('common.actions.add')}</button>
                </div>
                {formEnv.map((row, i) => (
                  <div key={i} className="flex flex-col sm:flex-row gap-2 mb-1.5">
                    <input value={row.key} onChange={e => setFormEnv(prev => prev.map((r, j) => j === i ? { ...r, key: e.target.value } : r))}
                      placeholder="KEY"
                      className="w-full min-w-0 flex-1 px-2 py-1 text-[11px] rounded border border-surface-200 bg-white dark:bg-surface-0 text-surface-600 focus:outline-none focus:border-brand-400" />
                    <input value={row.value} onChange={e => setFormEnv(prev => prev.map((r, j) => j === i ? { ...r, value: e.target.value } : r))}
                      placeholder="VALUE"
                      className="w-full min-w-0 flex-1 px-2 py-1 text-[11px] rounded border border-surface-200 bg-white dark:bg-surface-0 text-surface-600 focus:outline-none focus:border-brand-400" />
                    <button aria-label={t('toolsHub.mcp.removeEnvironmentRow')} onClick={() => setFormEnv(prev => prev.filter((_, j) => j !== i))} className="self-end sm:self-center text-surface-300 hover:text-red-400">
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-[11px] font-medium text-surface-500">{t('toolsHub.mcp.httpHeaders')}</label>
                  <button onClick={() => setFormHeaders(prev => [...prev, { key: '', value: '' }])}
                    className="text-[10px] text-brand-500 hover:text-brand-600">+ {t('common.actions.add')}</button>
                </div>
                {formHeaders.map((row, i) => (
                  <div key={i} className="flex flex-col sm:flex-row gap-2 mb-1.5">
                    <input value={row.key} onChange={e => setFormHeaders(prev => prev.map((r, j) => j === i ? { ...r, key: e.target.value } : r))}
                      placeholder="Authorization"
                      className="w-full min-w-0 flex-1 px-2 py-1 text-[11px] rounded border border-surface-200 bg-white dark:bg-surface-0 text-surface-600 focus:outline-none focus:border-brand-400" />
                    <input value={row.value} onChange={e => setFormHeaders(prev => prev.map((r, j) => j === i ? { ...r, value: e.target.value } : r))}
                      placeholder="Bearer ${TOKEN_VAR}"
                      className="w-full min-w-0 flex-1 px-2 py-1 text-[11px] rounded border border-surface-200 bg-white dark:bg-surface-0 text-surface-600 focus:outline-none focus:border-brand-400" />
                    <button aria-label={t('toolsHub.mcp.removeHeaderRow')} onClick={() => setFormHeaders(prev => prev.filter((_, j) => j !== i))} className="self-end sm:self-center text-surface-300 hover:text-red-400">
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
                {formHeaders.length === 0 && (
                  <p className="text-[10px] text-surface-300 break-words">{t('toolsHub.mcp.noHeadersHint')}</p>
                )}
              </div>
            )}

            {/* 测试结果 */}
            {testResult && (
              <div className={`flex min-w-0 items-center gap-2 text-[12px] break-all ${testResult.ok ? 'text-green-600' : 'text-red-500'}`}>
                {testResult.ok
                  ? <><CheckCircle className="w-3.5 h-3.5 shrink-0" /> {t('toolsHub.mcp.testSucceeded', { count: testResult.toolCount })}</>
                  : <><XCircle className="w-3.5 h-3.5 shrink-0" /> {testResult.error
                    ? t('toolsHub.mcp.testFailed', { error: testResult.error })
                    : t('toolsHub.mcp.connectionFailed')}
                  </>
                }
              </div>
            )}

            {/* 操作按钮 */}
            <div className="flex items-center gap-2 pt-1">
              <button onClick={handleTest} disabled={isTesting || !hasRequiredInput}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[12px] font-medium border border-surface-200 text-surface-600 hover:bg-surface-100 disabled:opacity-40 transition-colors">
                {isTesting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
                {t('toolsHub.mcp.testConnection')}
              </button>
              <button onClick={handleSave} disabled={!canSave}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[12px] font-medium bg-brand-500 text-ink-on-accent hover:bg-brand-600 disabled:opacity-40 transition-colors">
                {isSaving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
                {t('common.actions.save')}
              </button>
              <button onClick={resetForm} className="px-3 py-1.5 rounded-md text-[12px] text-surface-400 hover:text-surface-600 transition-colors">
                {t('common.actions.cancel')}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* CLI 工具区块 */}
      <CliSection />
    </div>
  )
}

// ---- CliSection ----

function CliSection() {
  const { t } = useTranslation()
  const [tools, setTools] = useState<CliToolInfo[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)

  const [formCommand, setFormCommand] = useState('')
  const [formName, setFormName] = useState('')
  const [formDesc, setFormDesc] = useState('')
  const [isValidating, setIsValidating] = useState(false)
  const [isInstalled, setIsInstalled] = useState<boolean | null>(null)
  const [isSaving, setIsSaving] = useState(false)

  const load = useCallback(async () => {
    setIsLoading(true)
    const result = await window.api.listCliTools()
    setTools(result)
    setIsLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  const handleCommandChange = (cmd: string) => {
    setFormCommand(cmd)
    setIsInstalled(null)
    if (cmd.trim()) {
      setIsValidating(true)
      window.api.validateCliTool(cmd.trim()).then((ok: boolean) => {
        setIsInstalled(ok)
        setIsValidating(false)
      })
    }
  }

  const handleSave = async () => {
    if (!formCommand.trim() || !formName.trim()) return
    setIsSaving(true)
    await window.api.addCliTool({ name: formName.trim(), command: formCommand.trim(), description: formDesc.trim() })
    setIsSaving(false)
    setShowForm(false)
    setFormCommand(''); setFormName(''); setFormDesc(''); setIsInstalled(null)
    await load()
  }

  const handleDelete = async (command: string) => {
    await window.api.removeCliTool(command)
    setConfirmDelete(null)
    await load()
  }

  // Resolve product-owned copy during render so changing locale updates the
  // list immediately. Runtime protocol fields and custom metadata stay raw.
  const displayTools = tools.map(tool => ({
    ...tool,
    display: resolveCliToolDisplay(tool, key => t(key)),
  }))
  const installedTools = displayTools.filter(tool => tool.installed)
  const notInstalledTools = displayTools.filter(tool => !tool.installed)

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Terminal className="w-4 h-4 text-surface-400" />
          <span className="text-[13px] font-semibold text-surface-600">{t('toolsHub.cli.title')}</span>
          <span className="text-[11px] text-surface-300">{t('toolsHub.cli.installedCount', { count: installedTools.length })}</span>
        </div>
        {!showForm && (
          <button onClick={() => setShowForm(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[12px] font-medium bg-brand-500 text-ink-on-accent hover:bg-brand-600 transition-colors">
            <Plus className="w-3.5 h-3.5" /> {t('common.actions.add')}
          </button>
        )}
      </div>

      {isLoading ? (
        <div className="flex items-center gap-2 py-4 text-surface-300">
          <Loader2 className="w-4 h-4 animate-spin" /> <span className="text-[12px]">{t('toolsHub.cli.scanning')}</span>
        </div>
      ) : (
        <div className="space-y-1">
          {installedTools.map(tool => (
            <div key={tool.command} className="flex flex-wrap items-center gap-3 px-3 py-2 rounded-lg bg-surface-50 dark:bg-surface-50/50 border border-surface-100">
              <span className="w-2 h-2 rounded-full shrink-0 bg-green-400" />
              <div className="flex-1 min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <code className="text-[12px] font-mono text-surface-700 truncate" title={tool.command}>{tool.command}</code>
                  <span className="min-w-0 max-w-full text-[11px] text-surface-400 truncate" title={tool.display.name}>{tool.display.name}</span>
                  {tool.builtIn && <span className="text-[10px] px-1.5 py-0.5 rounded bg-surface-100 text-surface-400">{t('toolsHub.badges.builtIn')}</span>}
                </div>
                <span className="block text-[11px] text-surface-400 break-words">{tool.display.description}</span>
              </div>
              {!tool.builtIn && (
                confirmDelete === tool.command ? (
                  <div className="flex items-center gap-2 shrink-0">
                    <button onClick={() => handleDelete(tool.command)} className="text-[11px] text-red-500 font-medium">{t('common.actions.delete')}</button>
                    <button onClick={() => setConfirmDelete(null)} className="text-[11px] text-surface-400">{t('common.actions.cancel')}</button>
                  </div>
                ) : (
                  <button aria-label={t('toolsHub.cli.deleteTool', { name: tool.display.name })} onClick={() => { setConfirmDelete(tool.command); setTimeout(() => setConfirmDelete(null), 4000) }}
                    className="shrink-0 p-1 text-surface-300 hover:text-red-400 transition-colors">
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                )
              )}
            </div>
          ))}
          {notInstalledTools.length > 0 && (
            <>
              <p className="text-[10px] text-surface-300 pt-2 pb-0.5 px-1">{t('toolsHub.cli.notInstalled')}</p>
              {notInstalledTools.map(tool => (
                <div key={tool.command} className="flex flex-wrap items-center gap-3 px-3 py-2 rounded-lg border border-dashed border-surface-200 opacity-50">
                  <span className="w-2 h-2 rounded-full shrink-0 bg-surface-300" />
                  <code className="min-w-0 max-w-full text-[12px] font-mono text-surface-500 truncate" title={tool.command}>{tool.command}</code>
                  <span className="min-w-0 flex-1 text-[11px] text-surface-400 truncate" title={tool.display.name}>{tool.display.name}</span>
                  {!tool.builtIn && (
                    <button aria-label={t('toolsHub.cli.deleteTool', { name: tool.display.name })} onClick={() => handleDelete(tool.command)} className="ml-auto shrink-0 p-1 text-surface-300 hover:text-red-400">
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              ))}
            </>
          )}
        </div>
      )}

      {showForm && (
        <div className="mt-3 p-4 border border-surface-200 rounded-lg bg-surface-50 dark:bg-surface-50/30 space-y-3">
          <div>
            <label className="block text-[11px] font-medium text-surface-500 mb-1">{t('toolsHub.cli.commandName')}</label>
            <div className="relative">
              <input value={formCommand} onChange={e => handleCommandChange(e.target.value)}
                placeholder={t('toolsHub.cli.commandPlaceholder')}
                className="w-full px-3 py-1.5 pr-8 text-[12px] font-mono rounded-md border border-surface-200 bg-white dark:bg-surface-0 text-surface-700 focus:outline-none focus:border-brand-400 focus:ring-1 focus:ring-brand-100" />
              {formCommand.trim() && (
                <span className="absolute right-2 top-1/2 -translate-y-1/2">
                  {isValidating ? <Loader2 className="w-3.5 h-3.5 text-surface-300 animate-spin" /> :
                    isInstalled ? <CheckCircle className="w-3.5 h-3.5 text-green-500" /> :
                    isInstalled === false ? <XCircle className="w-3.5 h-3.5 text-surface-300" /> : null}
                </span>
              )}
            </div>
            {formCommand.trim() && isInstalled === false && !isValidating && (
              <p className="text-[10px] text-surface-300 mt-0.5">{t('toolsHub.cli.notInstalledHint')}</p>
            )}
          </div>
          <div>
            <label className="block text-[11px] font-medium text-surface-500 mb-1">{t('toolsHub.cli.displayName')}</label>
            <input value={formName} onChange={e => setFormName(e.target.value)} placeholder={t('toolsHub.cli.displayNamePlaceholder')}
              className="w-full px-3 py-1.5 text-[12px] rounded-md border border-surface-200 bg-white dark:bg-surface-0 text-surface-700 focus:outline-none focus:border-brand-400 focus:ring-1 focus:ring-brand-100" />
          </div>
          <div>
            <label className="block text-[11px] font-medium text-surface-500 mb-1">{t('toolsHub.cli.description')}</label>
            <input value={formDesc} onChange={e => setFormDesc(e.target.value)} placeholder={t('toolsHub.cli.descriptionPlaceholder')}
              className="w-full px-3 py-1.5 text-[12px] rounded-md border border-surface-200 bg-white dark:bg-surface-0 text-surface-700 focus:outline-none focus:border-brand-400 focus:ring-1 focus:ring-brand-100" />
          </div>
          <div className="flex items-center gap-2 pt-1">
            <button onClick={handleSave} disabled={!formCommand.trim() || !formName.trim() || isSaving}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[12px] font-medium bg-brand-500 text-ink-on-accent hover:bg-brand-600 disabled:opacity-40 transition-colors">
              {isSaving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null} {t('common.actions.save')}
            </button>
            <button onClick={() => { setShowForm(false); setFormCommand(''); setFormName(''); setFormDesc(''); setIsInstalled(null) }}
              className="px-3 py-1.5 rounded-md text-[12px] text-surface-400 hover:text-surface-600 transition-colors">
              {t('common.actions.cancel')}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// ---- PluginsTab:Agent Plugins 标准包管理(plugin.json + skills/ + mcp.json) ----

interface PluginInfoUi {
  name: string
  dir: string
  version?: string
  description?: string
  author?: string
  enabled: boolean
  skillNames: string[]
  mcpServerNames: string[]
  warnings: string[]
  invalid?: string
}

type PluginInstallSourceUi = { type: 'folder'; path: string } | { type: 'github'; url: string }
type InstalledPluginSummary = { name: string; version?: string; skillCount: number; mcpServerCount: number }
type PluginInstallMessage =
  | { ok: true; installed: InstalledPluginSummary[]; skippedNames: string[] }
  | ({ ok: false } & DisplayError)

function PluginsTab() {
  const { t } = useTranslation()
  const [plugins, setPlugins] = useState<PluginInfoUi[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [githubUrl, setGithubUrl] = useState('')
  const [isInstalling, setIsInstalling] = useState(false)
  const [installMsg, setInstallMsg] = useState<PluginInstallMessage | null>(null)
  const [pendingOverwrite, setPendingOverwrite] = useState<{ source: PluginInstallSourceUi; names: string[] } | null>(null)
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null)
  const [busyName, setBusyName] = useState<string | null>(null)

  const loadPlugins = useCallback(async () => {
    try {
      const list = await (window.api as any).listPlugins()
      setPlugins(list || [])
    } catch {
      setPlugins([])
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => { loadPlugins() }, [loadPlugins])

  const runInstall = async (source: PluginInstallSourceUi, overwrite = false) => {
    setIsInstalling(true)
    setInstallMsg(null)
    setPendingOverwrite(null)
    try {
      const res = await (window.api as any).installPlugin(source, overwrite ? { overwrite: true } : undefined)
      if (res.ok) {
        setInstallMsg({
          ok: true,
          installed: res.installed,
          skippedNames: res.skipped.map((s: any) => s.name),
        })
        setGithubUrl('')
        await loadPlugins()
      } else if (res.needsOverwrite) {
        setPendingOverwrite({ source, names: res.conflictNames || [] })
      } else {
        setInstallMsg({ ok: false, ...toDisplayError(res, 'toolsHub.plugins.installFailed') })
      }
    } catch (err: any) {
      setInstallMsg({ ok: false, raw: err?.message || String(err) })
    } finally {
      setIsInstalling(false)
    }
  }

  const handlePickFolder = async () => {
    const paths = await window.api.openFileDialog('folder')
    if (!paths || paths.length === 0) return
    await runInstall({ type: 'folder', path: paths[0] })
  }

  const handleGithubInstall = async () => {
    const url = githubUrl.trim()
    if (!url) return
    await runInstall({ type: 'github', url })
  }

  const handleToggle = async (p: PluginInfoUi) => {
    setBusyName(p.name)
    try {
      await (window.api as any).setPluginDisabled(p.name, p.enabled)
      await loadPlugins()
    } finally {
      setBusyName(null)
    }
  }

  const handleRemove = async (name: string) => {
    setConfirmRemove(null)
    setBusyName(name)
    try {
      const res = await (window.api as any).uninstallPlugin(name)
      if (!res.ok) setInstallMsg({ ok: false, ...toDisplayError(res, 'toolsHub.plugins.uninstallFailed') })
      await loadPlugins()
    } finally {
      setBusyName(null)
    }
  }

  return (
    <div className="px-4 sm:px-8 py-4 space-y-5">
      {/* 安装区 */}
      <div className="p-4 border border-surface-200 rounded-lg bg-surface-50 dark:bg-surface-50/30 space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <Puzzle className="w-4 h-4 text-brand-500" />
          <h3 className="text-[13px] font-semibold text-surface-700">{t('toolsHub.plugins.installTitle')}</h3>
          <span className="text-[11px] text-surface-400">{t('toolsHub.plugins.standardHint')}</span>
        </div>
        <div className="flex flex-col sm:flex-row sm:items-center gap-2">
          <button
            onClick={handlePickFolder}
            disabled={isInstalling}
            className="flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-medium rounded-md border border-surface-200 text-surface-600 hover:bg-surface-100 disabled:opacity-50 transition-colors"
          >
            <FolderOpen className="w-3.5 h-3.5" /> {t('toolsHub.plugins.chooseFolder')}
          </button>
          <div className="flex-1 flex items-center gap-2">
            <div className="flex-1 relative">
              <GitBranch className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-surface-300" />
              <input
                value={githubUrl}
                onChange={e => setGithubUrl(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') handleGithubInstall() }}
                placeholder={t('toolsHub.plugins.repositoryPlaceholder')}
                className="w-full pl-8 pr-3 py-1.5 text-[12px] rounded-md border border-surface-200 bg-surface-0 dark:bg-surface-50 text-surface-700 placeholder:text-surface-300 outline-none focus:border-brand-400"
              />
            </div>
            <button
              onClick={handleGithubInstall}
              disabled={isInstalling || !githubUrl.trim()}
              className="px-3 py-1.5 text-[12px] font-medium rounded-md bg-brand-500 hover:bg-brand-600 text-ink-on-accent disabled:opacity-50 transition-colors"
            >
              {isInstalling ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : t('toolsHub.plugins.install')}
            </button>
          </div>
        </div>
        {pendingOverwrite && (
          <div className="flex flex-wrap items-center gap-2 text-[12px] text-amber-600 dark:text-amber-400">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
            <span className="min-w-0 break-words">{t('toolsHub.plugins.overwritePrompt', { names: pendingOverwrite.names.join(', ') })}</span>
            <button onClick={() => runInstall(pendingOverwrite.source, true)} className="font-medium text-red-500 hover:text-red-600">{t('toolsHub.plugins.overwrite')}</button>
            <button onClick={() => setPendingOverwrite(null)} className="text-surface-400 hover:text-surface-600">{t('common.actions.cancel')}</button>
          </div>
        )}
        {installMsg && (
          <div className={`flex items-center gap-1.5 text-[12px] ${installMsg.ok ? 'text-green-600 dark:text-green-400' : 'text-red-500'}`}>
            {installMsg.ok ? <CheckCircle className="w-3.5 h-3.5 shrink-0" /> : <XCircle className="w-3.5 h-3.5 shrink-0" />}
            <span className="min-w-0 break-words">
              {installMsg.ok
                ? t('toolsHub.plugins.installedSummary', {
                    plugins: installMsg.installed.map(item => t('toolsHub.plugins.installedItem', {
                      name: `${item.name}${item.version ? ` ${item.version}` : ''}`,
                      skillCount: item.skillCount,
                      serverCount: item.mcpServerCount,
                    })).join(', '),
                    skipped: installMsg.skippedNames.length > 0
                      ? t('toolsHub.plugins.skipped', { names: installMsg.skippedNames.join(', ') })
                      : '',
                  })
                : (installMsg.raw || (installMsg.key ? t(installMsg.key, installMsg.values) : ''))}
            </span>
          </div>
        )}
      </div>

      {/* 已安装列表 */}
      {isLoading ? (
        <div className="flex items-center justify-center py-10 text-surface-300"><Loader2 className="w-5 h-5 animate-spin" /></div>
      ) : plugins.length === 0 ? (
        <div className="text-center py-10">
          <Puzzle className="w-8 h-8 mx-auto text-surface-200 mb-2" />
          <p className="text-[13px] text-surface-400">{t('toolsHub.plugins.empty')}</p>
          <p className="text-[11px] text-surface-300 mt-1">{t('toolsHub.plugins.emptyHint')}</p>
        </div>
      ) : (
        <div className="space-y-2">
          {plugins.map(p => (
            <div key={p.name} className={`p-4 rounded-lg border border-surface-100 dark:border-surface-100 ${p.invalid ? 'opacity-60' : ''}`}>
              <div className="flex flex-wrap items-center gap-3">
                <span className={`w-2 h-2 rounded-full shrink-0 ${p.invalid ? 'bg-red-400' : p.enabled ? 'bg-green-400' : 'bg-surface-300'}`} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <h4 className="text-[13px] font-semibold text-surface-700 truncate" title={p.name}>{p.name}</h4>
                    {p.version && <span className="text-[10px] px-1.5 py-0.5 rounded bg-surface-100 text-surface-400">{p.version}</span>}
                    {p.author && <span className="text-[10px] text-surface-300 truncate" title={p.author}>{t('toolsHub.plugins.byAuthor', { author: p.author })}</span>}
                  </div>
                  {p.description && <p className="text-[12px] text-surface-400 line-clamp-2 mt-0.5">{p.description}</p>}
                  <p className="text-[11px] text-surface-400 mt-1 break-all">
                    {p.invalid
                      ? t('toolsHub.plugins.invalid', { reason: p.invalid })
                      : t('toolsHub.plugins.contents', { skillCount: p.skillNames.length, serverCount: p.mcpServerNames.length })}
                  </p>
                  {p.warnings.length > 0 && (
                    <p className="text-[11px] text-amber-600 dark:text-amber-400 mt-1 flex items-start gap-1">
                      <AlertTriangle className="w-3 h-3 shrink-0 mt-0.5" />
                      <span className="min-w-0 break-words">{p.warnings.join('; ')}</span>
                    </p>
                  )}
                </div>
                {confirmRemove === p.name ? (
                  <div className="flex items-center gap-1.5 shrink-0">
                    <span className="text-[11px] text-surface-400">{t('toolsHub.plugins.confirmUninstall')}</span>
                    <button onClick={() => handleRemove(p.name)} className="text-[11px] text-red-500 hover:text-red-600 font-medium">{t('toolsHub.plugins.uninstall')}</button>
                    <button onClick={() => setConfirmRemove(null)} className="text-[11px] text-surface-400 hover:text-surface-600">{t('common.actions.cancel')}</button>
                  </div>
                ) : (
                  <button
                    onClick={() => { setConfirmRemove(p.name); setTimeout(() => setConfirmRemove(prev => prev === p.name ? null : prev), 4000) }}
                    className="shrink-0 p-1.5 rounded hover:bg-surface-100 transition-colors" title={t('toolsHub.plugins.uninstallNamed', { name: p.name })}
                  >
                    <Trash2 className="w-3.5 h-3.5 text-surface-300 hover:text-red-400" />
                  </button>
                )}
                {!p.invalid && (
                  <button
                    onClick={() => handleToggle(p)}
                    disabled={busyName === p.name}
                    role="switch"
                    aria-checked={p.enabled}
                    aria-label={t('toolsHub.plugins.toggleNamed', { name: p.name })}
                    className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full transition-colors duration-200 disabled:opacity-50 ${p.enabled ? 'bg-brand-500' : 'bg-surface-200'}`}
                  >
                    <span className={`pointer-events-none inline-block h-5 w-5 mt-0.5 transform rounded-full bg-white shadow transition duration-200 ${p.enabled ? 'translate-x-[22px]' : 'translate-x-0.5'}`} />
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
