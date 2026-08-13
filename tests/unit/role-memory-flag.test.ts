/**
 * 角色级记忆开关（agent.md frontmatter `memory` 字段）解析单测。
 * parseMemoryEnabled 是纯函数：'off'/'false'/'disabled'（大小写不敏感）→ false，
 * 缺省/其它任意值 → true。覆盖 role-loader.ts 里唯一可独立测试的判定逻辑。
 */
import { describe, it, expect } from 'vitest'
import { parseMemoryEnabled } from '../../src/main/role-loader'

describe('parseMemoryEnabled（角色级记忆开关判定）', () => {
  it('off → false（design 关闭记忆的写法）', () => {
    expect(parseMemoryEnabled('off')).toBe(false)
  })

  it('大小写不敏感：OFF / Off 也算关闭', () => {
    expect(parseMemoryEnabled('OFF')).toBe(false)
    expect(parseMemoryEnabled('Off')).toBe(false)
  })

  it('false / disabled 同样视为关闭', () => {
    expect(parseMemoryEnabled('false')).toBe(false)
    expect(parseMemoryEnabled('disabled')).toBe(false)
  })

  it('缺省（undefined）→ true（默认开启，其它角色不受影响）', () => {
    expect(parseMemoryEnabled(undefined)).toBe(true)
  })

  it('怪值（非约定关键字）→ true（保守：不认识的值不关闭）', () => {
    expect(parseMemoryEnabled('on')).toBe(true)
    expect(parseMemoryEnabled('true')).toBe(true)
    expect(parseMemoryEnabled('yes')).toBe(true)
    expect(parseMemoryEnabled('随便写点什么')).toBe(true)
  })
})
