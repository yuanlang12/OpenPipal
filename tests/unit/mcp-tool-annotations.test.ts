import { describe, expect, it } from 'vitest'
import { describeMcpToolAnnotations, pickMcpToolAnnotations } from '../../src/main/mcp-tool-annotations'

describe('MCP 工具注解：只收协议里的四个布尔键', () => {
  it('非布尔、多余键、非对象一律丢', () => {
    expect(pickMcpToolAnnotations(undefined)).toBeUndefined()
    expect(pickMcpToolAnnotations(null)).toBeUndefined()
    expect(pickMcpToolAnnotations('readOnlyHint')).toBeUndefined()
    expect(pickMcpToolAnnotations([true])).toBeUndefined()
    expect(pickMcpToolAnnotations({ title: 'x', readOnlyHint: 'true', extra: 1 })).toBeUndefined()
    expect(pickMcpToolAnnotations({ readOnlyHint: true, destructiveHint: 'no', openWorldHint: false }))
      .toEqual({ readOnlyHint: true, openWorldHint: false })
  })

  it('给模型的一行事实', () => {
    expect(describeMcpToolAnnotations(undefined)).toBe('')
    expect(describeMcpToolAnnotations({ readOnlyHint: true, openWorldHint: true })).toBe('副作用（服务器自述）: 只读，触达外部系统')
    expect(describeMcpToolAnnotations({ destructiveHint: true })).toBe('副作用（服务器自述）: 可能删除或覆盖数据')
    expect(describeMcpToolAnnotations({ destructiveHint: false, idempotentHint: true })).toBe('副作用（服务器自述）: 会改动数据但不覆盖已有内容，重复调用无额外效果')
    expect(describeMcpToolAnnotations({ idempotentHint: false })).toBe('')
  })
})
