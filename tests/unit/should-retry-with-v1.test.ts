/**
 * shouldRetryWithV1 / appendV1（config-manager.ts）—— 模型连接测试的探测式 /v1 自动补全。
 *
 * 背景：用户只想填裸网址（如 https://x666.me），但不能固定拼 /v1——现有 preset 里
 * 既有 https://dashscope.aliyuncs.com/compatible-mode/v1（前缀带 v1）也有
 * https://…gateway.com/v1/ai/cloudbase（v1 在中间、结尾不是 v1）这类反例。
 * 这两个纯函数只负责"要不要补 /v1"与"怎么补"，不掺业务判断（是否 nonApiResponse 由
 * testConnection 编排层决定）。
 */
import { describe, it, expect } from 'vitest'
import { shouldRetryWithV1, appendV1 } from '../../src/main/config-manager'

describe('shouldRetryWithV1', () => {
  it('裸域名 → true（需要补 /v1）', () => {
    expect(shouldRetryWithV1('https://x666.me')).toBe(true)
  })

  it('尾部斜杠 → true（忽略尾部斜杠再判断）', () => {
    expect(shouldRetryWithV1('https://x666.me/')).toBe(true)
  })

  it('已 /v1 结尾 → false（不重试）', () => {
    expect(shouldRetryWithV1('https://api.example.com/v1')).toBe(false)
  })

  it('已 /v1 结尾 + 尾部斜杠 → false', () => {
    expect(shouldRetryWithV1('https://api.example.com/v1/')).toBe(false)
  })

  it('大小写不敏感：/V1 结尾 → false', () => {
    expect(shouldRetryWithV1('https://api.example.com/V1')).toBe(false)
  })

  it('compatible-mode/v1（前缀带 v1，dashscope 真实 preset）→ false', () => {
    expect(shouldRetryWithV1('https://dashscope.aliyuncs.com/compatible-mode/v1')).toBe(false)
  })

  it('v1 在中间、结尾不是 v1（网关真实 preset）→ true', () => {
    // 注：这个 case 第一次原样尝试就能成功，实际不会触发重试；这里只验证纯函数逻辑。
    expect(shouldRetryWithV1('https://xxx-gateway.com/v1/ai/cloudbase')).toBe(true)
  })
})

describe('appendV1', () => {
  it('裸域名 → 补全为 域名/v1', () => {
    expect(appendV1('https://x666.me')).toBe('https://x666.me/v1')
  })

  it('尾部斜杠先去掉再补 /v1（不产生双斜杠）', () => {
    expect(appendV1('https://x666.me/')).toBe('https://x666.me/v1')
  })

  it('多个尾部斜杠也能正确去除', () => {
    expect(appendV1('https://x666.me//')).toBe('https://x666.me/v1')
  })
})
