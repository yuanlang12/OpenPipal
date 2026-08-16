/**
 * 搜索服务（web_search）配置外化的契约锁：
 * ① 生效回退：用户配了就用用户的，没配才回退 .env 内置 key
 * ② 展示口径：key 恒掩码，内置回退打 builtin 标记（红线：内置明文不出主进程）
 * ③ 保存/清除：空 key = 保留原值；clear 后回落内置
 * ④ 取 key 路径：webSearch 每次调用现读配置（改完不用重启），没 key 时 no_key 文案指向设置页
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'openpipal-search-'))
process.env.OPENPIPAL_ISOLATED_HOME = TMP
const CONFIG_PATH = path.join(TMP, '.openpipal', 'config.json')
fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true })

/** 假 net.request：记录最后一次请求体，按 pending 的状态码/响应体回放 */
const sent: Array<{ url: string; body: any }> = []
let nextStatus = 200
let nextBody = JSON.stringify({ results: [{ title: 't', url: 'u', content: 'c' }] })

vi.mock('electron', () => ({
  net: {
    request: (opts: { url: string }) => {
      const handlers: Record<string, (...args: any[]) => void> = {}
      let body = ''
      return {
        setHeader: () => {},
        on: (event: string, cb: (...args: any[]) => void) => { handlers[event] = cb },
        write: (chunk: string) => { body = chunk },
        end: () => {
          sent.push({ url: opts.url, body: JSON.parse(body) })
          handlers.response?.({
            statusCode: nextStatus,
            on: (event: string, cb: (chunk?: unknown) => void) => {
              if (event === 'data') cb(nextBody)
              if (event === 'end') cb()
            }
          })
        }
      }
    }
  }
}))

const cm = await import('../../src/main/config-manager')
const ws = await import('../../src/main/web-search')

beforeEach(() => {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify({ configVersion: 2 }, null, 2))
  delete process.env.TAVILY_API_KEY
  sent.length = 0
  nextStatus = 200
  nextBody = JSON.stringify({ results: [{ title: 't', url: 'u', content: 'c' }] })
})

describe('生效配置与回退', () => {
  it('没有用户配置时回退 .env 内置 key，并标 builtin', () => {
    process.env.TAVILY_API_KEY = 'env-builtin-key'
    expect(cm.getEffectiveSearchConfig()).toEqual({ provider: 'tavily', apiKey: 'env-builtin-key' })
    expect(cm.isBuiltinSearchCredential()).toBe(true)
  })

  it('用户配置优先于 .env，builtin 转 false', () => {
    process.env.TAVILY_API_KEY = 'env-builtin-key'
    cm.saveSearchConfig({ provider: 'tavily', apiKey: 'user-key' })
    expect(cm.getEffectiveSearchConfig().apiKey).toBe('user-key')
    expect(cm.isBuiltinSearchCredential()).toBe(false)
  })

  it('两边都空时 key 为空、configured=false', () => {
    expect(cm.getEffectiveSearchConfig().apiKey).toBe('')
    expect(cm.getEffectiveSearchConfigForDisplay().configured).toBe(false)
    expect(cm.isBuiltinSearchCredential()).toBe(false)
  })
})

describe('展示口径（红线：明文不出主进程）', () => {
  it('内置回退：掩码 + builtin=true，返回里没有明文', () => {
    process.env.TAVILY_API_KEY = 'env-builtin-key'
    const display = cm.getEffectiveSearchConfigForDisplay()
    expect(display).toEqual({ provider: 'tavily', apiKey: '••••••', builtin: true, configured: true })
    expect(JSON.stringify(display)).not.toContain('env-builtin-key')
  })

  it('用户 key 同样恒掩码', () => {
    cm.saveSearchConfig({ provider: 'tavily', apiKey: 'user-key' })
    const display = cm.getEffectiveSearchConfigForDisplay()
    expect(display.apiKey).toBe('••••••')
    expect(display.builtin).toBe(false)
    expect(JSON.stringify(display)).not.toContain('user-key')
  })
})

describe('保存与清除', () => {
  it('空 key = 保留原值，不会把已保存的凭证抹成空', () => {
    cm.saveSearchConfig({ provider: 'tavily', apiKey: 'user-key' })
    cm.saveSearchConfig({ provider: 'tavily', apiKey: '   ' })
    expect(cm.getEffectiveSearchConfig().apiKey).toBe('user-key')
  })

  it('原本无值时空提交不写空壳', () => {
    cm.saveSearchConfig({ provider: 'tavily', apiKey: '' })
    expect(cm.loadConfig().searchConfig).toBeUndefined()
  })

  it('clear 后回落内置', () => {
    process.env.TAVILY_API_KEY = 'env-builtin-key'
    cm.saveSearchConfig({ provider: 'tavily', apiKey: 'user-key' })
    cm.clearSearchConfig()
    expect(cm.loadConfig().searchConfig).toBeUndefined()
    expect(cm.getEffectiveSearchConfig().apiKey).toBe('env-builtin-key')
    expect(cm.isBuiltinSearchCredential()).toBe(true)
  })
})

describe('web_search 取 key 路径', () => {
  it('每次调用现读配置：设置页改完不用重启', async () => {
    cm.saveSearchConfig({ provider: 'tavily', apiKey: 'key-1' })
    await ws.webSearch('q')
    cm.saveSearchConfig({ provider: 'tavily', apiKey: 'key-2' })
    await ws.webSearch('q')
    expect(sent.map(r => r.body.api_key)).toEqual(['key-1', 'key-2'])
    expect(sent[0].url).toBe('https://api.tavily.com/search')
  })

  it('没有任何 key 时不发请求，no_key 文案指向设置页', async () => {
    const outcome = await ws.webSearch('q')
    expect(outcome).toEqual({ ok: false, reason: 'no_key', detail: '未配置搜索服务' })
    expect(sent).toHaveLength(0)
    const formatted = ws.formatSearchResults(outcome)
    expect(formatted).toContain('设置 → 搜索服务')
    expect(formatted).toContain('Tavily API Key')
  })

  it('连通测试可用未保存的临时 key，且返回里不回显 key', async () => {
    cm.saveSearchConfig({ provider: 'tavily', apiKey: 'saved-key' })
    const result = await ws.testSearchConnection('temp-key')
    expect(result).toEqual({ ok: true })
    expect(sent[0].body.api_key).toBe('temp-key')
    expect(JSON.stringify(result)).not.toContain('temp-key')
  })

  it('不带临时 key 时用生效配置；失败只带 errorKey，不带凭证', async () => {
    cm.saveSearchConfig({ provider: 'tavily', apiKey: 'saved-key' })
    nextStatus = 401
    nextBody = '{"detail":"invalid api key"}'
    const result = await ws.testSearchConnection()
    expect(sent[0].body.api_key).toBe('saved-key')
    expect(result).toEqual({
      ok: false,
      errorKey: 'settings.search.errors.httpError',
      errorParams: { detail: 'HTTP 401' }
    })
    expect(JSON.stringify(result)).not.toContain('saved-key')
  })

  it('没有任何 key 时测试直接报 missingApiKey，不发请求', async () => {
    expect(await ws.testSearchConnection()).toEqual({ ok: false, errorKey: 'settings.search.errors.missingApiKey' })
    expect(sent).toHaveLength(0)
  })
})

describe('设置页文案', () => {
  it('主进程自造的 errorKey 在中英两份目录里都能解析', async () => {
    const { ZH_CN_MESSAGES, EN_MESSAGES } = await import('../../src/shared/i18n/resources')
    const keys = ['missingApiKey', 'httpError', 'requestFailed', 'badResponse', 'connectionFailed', 'testUnsupported'] as const
    for (const catalogue of [ZH_CN_MESSAGES, EN_MESSAGES]) {
      for (const key of keys) expect(catalogue.settings.search.errors[key]).toBeTruthy()
      expect(catalogue.settings.tabs.search).toBeTruthy()
    }
  })
})
