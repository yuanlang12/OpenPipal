/**
 * friendlyProviderError（config-manager.ts）—— 模型连接测试改造的纯函数错误友好化。
 *
 * 背景事故：custom 模型 baseUrl 缺 /v1 时，网关返回 HTTP 200 + HTML 首页（SPA catch-all），
 * 这是最阴险的假成功。friendlyProviderError 负责把这类 raw 错误/探测文本转成可读提示；
 * 其余错误必须原样透传（含 HTTP 状态码与 message），不能吞掉细节泛化成"连接失败"。
 */
import { describe, it, expect } from 'vitest'
import { friendlyProviderError } from '../../src/main/config-manager'

describe('friendlyProviderError', () => {
  it('raw 含 <!doctype html> → 提示缺 /v1，并回显 baseUrl', () => {
    const raw = '<!doctype html><html><head></head><body>SPA shell</body></html>'
    const result = friendlyProviderError(raw, 'https://x666.me')
    expect(result).toContain('/v1')
    expect(result).toContain('https://x666.me')
    expect(result).not.toContain('<html')
  })

  it('raw 只含 <html>（无 doctype）也能识别', () => {
    const raw = '<html><body>Not Found</body></html>'
    const result = friendlyProviderError(raw, 'https://gw.example.com')
    expect(result).toContain('/v1')
    expect(result).toContain('https://gw.example.com')
  })

  it('大小写变体：<!DOCTYPE HTML> 与 <HTML> 都能识别', () => {
    expect(friendlyProviderError('<!DOCTYPE HTML><HTML></HTML>', 'https://a.com')).toContain('/v1')
    expect(friendlyProviderError('<HTML><BODY>x</BODY></HTML>', 'https://b.com')).toContain('/v1')
  })

  it('普通网关错误原样透传（含 HTTP 状态码与 message，不泛化）', () => {
    const raw = '503 {"error":{"message":"No active API keys available for this group"}}'
    const result = friendlyProviderError(raw, 'https://x666.me/v1')
    expect(result).toBe(raw)
  })

  it('普通 401 错误原样透传', () => {
    const raw = '401 Incorrect API key provided'
    expect(friendlyProviderError(raw, 'https://api.example.com/v1')).toBe(raw)
  })

  it('空字符串兜底为"连接失败"，不抛异常', () => {
    expect(friendlyProviderError('', 'https://x.com')).toBe('连接失败')
    expect(friendlyProviderError('   ', 'https://x.com')).toBe('连接失败')
  })
})
