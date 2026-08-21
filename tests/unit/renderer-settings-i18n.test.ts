import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createRendererI18n } from '../../src/renderer/src/i18n'
import { formatRelativeTime } from '../../src/renderer/src/i18n/formatters'
import { formatProcessDuration } from '../../src/renderer/src/components/ProcessGroup'

const MIGRATED_FILES = [
  'src/renderer/src/components/ProcessGroup.tsx',
  'src/renderer/src/components/StreamingArea.tsx',
  'src/renderer/src/components/ModelSettings.tsx',
  'src/renderer/src/components/VoiceSettings.tsx',
  'src/renderer/src/components/AppSettings.tsx',
  'src/renderer/src/components/MemorySettings.tsx',
  'src/renderer/src/components/AboutSection.tsx',
  'src/renderer/src/components/AcpConnections.tsx',
]

const read = (path: string): string => readFileSync(resolve(path), 'utf8')

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

describe('renderer settings and process i18n', () => {
  it('serves the migrated English and Chinese settings resources', async () => {
    const english = await createRendererI18n('en')
    const chinese = await createRendererI18n('zh-CN')

    expect(english.t('settings.model.form.addTitle')).toBe('Add model')
    expect(english.t('settings.voice.actions.testConnection')).toBe('Test connection')
    expect(english.t('settings.memory.globalCount', { count: 2 })).toBe('Global memory (2 items)')
    expect(english.t('chat.process.exploreFiles', { count: 2 })).toBe('2 files')
    expect(english.t('chat.process.thoughtDuration', { duration: '3s' })).toBe('Thought for 3s')
    expect(chinese.t('settings.apps.workingDirectory.choose')).toBe('选择')
    expect(chinese.t('settings.apps.following.master.off')).toContain('不会跟随任何应用')
    expect(english.t('settings.apps.following.master.off')).toContain('will not follow any app')
    expect(chinese.t('settings.apps.following.errors.save')).toContain('已恢复原状态')
    expect(english.t('settings.apps.following.errors.save')).toContain('previous state was restored')
    expect(chinese.t('settings.about.version')).toBe('版本')
    expect(chinese.t('toolsHub.mcp.httpHeaders')).toBe('HTTP 请求头')
    expect(english.t('toolsHub.mcp.httpHeaders')).toBe('HTTP Headers')
    expect(read('src/renderer/src/components/ToolsHub.tsx'))
      .toContain("t('toolsHub.mcp.httpHeaders')")
  })

  it('describes ACP connections in both locales without inventing a connected state', async () => {
    const english = await createRendererI18n('en')
    const chinese = await createRendererI18n('zh-CN')

    expect(chinese.t('settings.connections.title')).toBe('外部连接')
    expect(english.t('settings.connections.title')).toBe('External connections')
    expect(chinese.t('settings.connections.service.listening', { port: 3031 })).toContain('127.0.0.1:3031')
    expect(english.t('settings.connections.service.off')).toContain('nothing can connect')
    expect(chinese.t('settings.connections.pending.title', { count: 2 })).toBe('等你确认（2）')
    expect(english.t('settings.connections.pending.title', { count: 2 })).toBe('Waiting for your approval (2)')
    expect(chinese.t('settings.connections.pending.hint')).toContain('编辑器')
    expect(english.t('settings.connections.session.clientLine', { client: 'Zed', version: 2 })).toBe('Zed · ACP v2')
    expect(chinese.t('settings.connections.session.agent', { agent: '我的法务助手' })).toBe('使用 Agent：我的法务助手')
    expect(english.t('settings.connections.session.agent', { agent: 'Legal helper' })).toBe('Using agent: Legal helper')
    // 「没装好」和「装好了没用」是两个不同的下一步，空状态不能只有一句
    expect(chinese.t('settings.connections.empty')).not.toBe(chinese.t('settings.connections.emptyAfterHandshake'))
    expect(english.t('settings.connections.emptyAfterHandshake')).toContain('not started a session')

    // 面板只描述"此刻"：不缓存、不落盘，主进程推变更就重新取一次快照
    const panel = read('src/renderer/src/components/AcpConnections.tsx')
    expect(panel).toContain('window.api.getAcpStatus()')
    expect(panel).toContain('window.api.onAcpStatusChanged?.(load)')
    expect(panel).toContain("data-testid=\"acp-pending-permissions\"")
    expect(panel).not.toMatch(/setInterval|localStorage/)
  })

  it('keeps the global app-following switch and disables only the per-app controls while paused', () => {
    const appSettings = read('src/renderer/src/components/AppSettings.tsx')

    expect(appSettings).toContain('data-testid="app-following-master-toggle"')
    expect(appSettings).toContain('setAppFollowingEnabled(nextEnabled)')
    expect(appSettings).toContain('disabled={loading || !followingEnabled || saving}')
    expect(appSettings).toContain('setFollowingEnabled(data.enabled)')
    expect(appSettings).toContain('settingsEpoch.current += 1')
  })

  it('formats memory dates with the active locale rather than a fixed locale', () => {
    const now = new Date('2026-08-09T12:00:00Z').getTime()
    const timestamp = now - 2 * 60 * 60 * 1000

    const english = formatRelativeTime(timestamp, 'en-US', now)
    const chinese = formatRelativeTime(timestamp, 'zh-CN', now)

    expect(english).toBe(new Intl.RelativeTimeFormat('en-US', { numeric: 'auto' }).format(-2, 'hour'))
    expect(chinese).toBe(new Intl.RelativeTimeFormat('zh-CN', { numeric: 'auto' }).format(-2, 'hour'))
    expect(english).not.toBe(chinese)
  })

  it('formats process duration units through the active locale', async () => {
    const english = await createRendererI18n('en')
    const chinese = await createRendererI18n('zh-CN')

    expect(formatProcessDuration(90_000, 'en-US', english.getFixedT('en'))).toBe('1m 30s')
    expect(formatProcessDuration(90_000, 'zh-CN', chinese.getFixedT('zh-CN'))).toBe('1 分 30 秒')
  })

  it('removes migrated static Chinese copy while preserving official voice names', () => {
    const source = stripComments(MIGRATED_FILES.map(read).join('\n'))
    const migratedUiLiterals = [
      '模型设置',
      '添加模型',
      '测试连接',
      '语音设置',
      '自动记忆',
      '立即整理',
      '默认工作目录',
      '提交 Issue',
      '处理中…',
      '正在深入思考…',
    ]

    for (const literal of migratedUiLiterals) expect(source).not.toContain(literal)

    const voice = read('src/renderer/src/components/VoiceSettings.tsx')
    expect(voice).toContain("label: '小何'")
    expect(voice).toContain("label: '云舟'")
    expect(voice).toContain("label: '小天'")
  })

  it('keeps provider, model, path, memory, thinking, and backend content raw', () => {
    const model = read('src/renderer/src/components/ModelSettings.tsx')
    const voice = read('src/renderer/src/components/VoiceSettings.tsx')
    const memory = read('src/renderer/src/components/MemorySettings.tsx')
    const streaming = read('src/renderer/src/components/StreamingArea.tsx')

    expect(model).toContain('setConnectionError(result.error || \'\')')
    expect(model).toContain('source: ctxDetection.source')
    expect(model).toContain('provider,\n      baseUrl,\n      model,\n      apiKey,')
    expect(voice).toContain("toDisplayError(result, 'settings.voice.errors.connectionFailed')")
    expect(voice).toContain('baseUrl: baseUrl.trim()')
    expect(voice).toContain('model: model.trim()')
    expect(memory).toContain('{mem.name || mem.filename}')
    expect(memory).toContain('{expandedContent.content}')
    expect(memory).toContain('summary: result.summary')
    expect(streaming).toContain('<StreamingText content={text} />')
    expect(streaming).toContain('toolStreamingTitle ||')

    const source = MIGRATED_FILES.map(read).join('\n')
    expect(source).not.toMatch(/\bt\(\s*(?:result\.error|ctxDetection\.source|mem\.name|expandedContent\.content|toolStreamingTitle|text)/)
  })

  it('keeps long English labels and dynamic errors fluid', () => {
    const model = read('src/renderer/src/components/ModelSettings.tsx')
    const voice = read('src/renderer/src/components/VoiceSettings.tsx')
    const memory = read('src/renderer/src/components/MemorySettings.tsx')

    expect(model).toContain('grid grid-cols-1 sm:grid-cols-3')
    // 服务商标题行现在是可折叠卡片的展开按钮:同样要能收缩(min-w-0),
    // 长英文服务商名靠 truncate 收口而不是撑破布局 —— 比原来的 flex-wrap 更硬。
    expect(model).toContain('flex flex-1 min-w-0 items-center gap-2 text-left')
    // 只钉承重的那部分:服务商名要能收缩并截断。别把配色令牌写进来 ——
    // 一次纯调色就会让这条「截断契约」无辜变红。
    expect(model).toContain('flex flex-1 min-w-0 items-center gap-2 text-left')
    expect(model).toMatch(/font-medium[^"']*truncate/)
    expect(model).toContain('text-red-500 break-words')
    expect(voice).toContain('grid grid-cols-1 sm:grid-cols-2')
    expect(voice).toContain('flex items-center gap-2 pt-2 flex-wrap')
    expect(voice).not.toContain('max-w-[200px] truncate')
    expect(memory).not.toContain('w-12 text-right')
  })

  it('routes internally-authored connection-test errors through errorKey/t(), never disturbing the raw passthrough contract', async () => {
    const english = await createRendererI18n('en')
    const chinese = await createRendererI18n('zh-CN')

    // New OpenPipal-authored error keys resolve in both locales.
    expect(english.t('settings.model.errors.connectionTimeout')).toBe('Connection timed out (15s)')
    expect(chinese.t('settings.model.errors.connectionTimeout')).toBe('连接超时（15s）')
    expect(english.t('settings.model.errors.nonApiResponse', { baseUrl: 'https://x.example' }))
      .toBe('The gateway returned a web page instead of an API response — baseUrl may be missing /v1 (current: https://x.example)')
    expect(chinese.t('settings.model.errors.nonApiResponse', { baseUrl: 'https://x.example' }))
      .toContain('https://x.example')
    expect(english.t('settings.model.errors.apiError')).toBe('API returned an error')
    expect(chinese.t('settings.model.errors.apiError')).toBe('API 返回错误')
    expect(english.t('settings.model.errors.autoRetryFailed', { baseUrl: 'https://x.example/v1', error: 'boom' }))
      .toBe('Automatically retried https://x.example/v1: boom')

    const model = read('src/renderer/src/components/ModelSettings.tsx')
    // Preference order: translated errorKey wins over raw connectionError when the backend
    // marks the text as internally authored; the raw passthrough call below stays untouched
    // (see the protected assertion in the previous test) for external gateway text.
    expect(model).toContain('connectionErrorOverride')
    expect(model).toContain('setConnectionErrorOverride(result.errorKey ? { key: result.errorKey, params: result.errorParams } : null)')
    expect(model).toContain('t(connectionErrorOverride.key, connectionErrorOverride.params)')
    expect(model).toContain('(connectionError || t(connectionErrorKey))')
  })
})
