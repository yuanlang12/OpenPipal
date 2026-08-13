/**
 * 日志落盘的脱敏锁。日志上了磁盘就是永久留档，密钥一旦写进去等于长期泄漏面——
 * 这层过滤必须比"当前没有打印密钥的代码"活得更久。
 */
import { describe, it, expect } from 'vitest'
import { redactSecrets } from '../../src/main/main-log'

describe('日志脱敏', () => {
  it('遮掉 sk-/xai-/gsk- 这类前缀密钥', () => {
    const out = redactSecrets('[Config] key=sk-abcd1234efgh5678 ok')
    expect(out).toContain('sk-***')
    expect(out).not.toContain('abcd1234efgh5678')
  })

  it('遮掉 Bearer 头', () => {
    expect(redactSecrets('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9')).toBe('Authorization: Bearer ***')
  })

  it('遮掉 JSON 里的 apiKey / token / secret 字段值', () => {
    const out = redactSecrets('{"apiKey":"9f8e7d6c5b4a3210","model":"glm-5.2"}')
    expect(out).not.toContain('9f8e7d6c5b4a3210')
    expect(out).toContain('glm-5.2') // 非敏感字段不受影响
  })

  it('遮掉 URL 查询串里的 key/token', () => {
    const out = redactSecrets('GET https://api.x.com/v1/chat?api_key=abcdefgh12345678&model=glm')
    expect(out).not.toContain('abcdefgh12345678')
    expect(out).toContain('model=glm')
  })

  it('普通日志原样通过（不误伤）', () => {
    const line = '[Pi] 静默 800ms 无任何模型事件 —— 判定服务无响应，中断本轮'
    expect(redactSecrets(line)).toBe(line)
  })
})
