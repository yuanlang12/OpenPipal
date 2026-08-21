/**
 * ProcessGroup 展开态渲染项构建——连续同文件 edit/write 聚合成"文件 ×N"组。
 * 覆盖：①连续同文件聚合 ②不同文件/被其它消息隔断不聚合 ③schema 兼容(path/file_path)
 * ④解析失败/非 edit-write 工具消息原样单条。
 */
import { describe, it, expect } from 'vitest'
import { buildProcessRenderItems, fileEditPath } from '../../src/renderer/src/chat/processRender'
import type { ChatMessage } from '../../src/renderer/src/types'

let seq = 0
function toolMsg(toolName: string, args: Record<string, unknown>): ChatMessage {
  return {
    id: `t${++seq}`, role: 'assistant', content: 'ok', timestamp: seq,
    toolName, toolCallId: `c${seq}`, toolArgs: JSON.stringify(args)
  } as ChatMessage
}
function textMsg(content: string): ChatMessage {
  return { id: `a${++seq}`, role: 'assistant', content, timestamp: seq } as ChatMessage
}
function thinkMsg(content: string): ChatMessage {
  return { id: `k${++seq}`, role: 'assistant', content: '', thinkingContent: content, timestamp: seq, messageKind: 'thinking' } as ChatMessage
}

describe('fileEditPath', () => {
  it('edit/write 取 path，兼容 file_path/filePath', () => {
    expect(fileEditPath(toolMsg('edit', { path: '/a/b.tsx' }))).toBe('/a/b.tsx')
    expect(fileEditPath(toolMsg('write', { file_path: '/a/c.tsx' }))).toBe('/a/c.tsx')
    expect(fileEditPath(toolMsg('edit', { filePath: '/a/d.tsx' }))).toBe('/a/d.tsx')
  })
  it('非 edit/write 工具、坏 JSON、缺 path 都返回 null', () => {
    expect(fileEditPath(toolMsg('bash', { command: 'ls' }))).toBeNull()
    const bad = toolMsg('edit', {})
    bad.toolArgs = '{oops'
    expect(fileEditPath(bad)).toBeNull()
    expect(fileEditPath(toolMsg('edit', {}))).toBeNull()
    expect(fileEditPath(textMsg('hi'))).toBeNull()
  })
})

describe('buildProcessRenderItems', () => {
  it('连续同文件 edit 聚成一组，×N 计数正确', () => {
    const msgs = [toolMsg('edit', { path: '/x.tsx' }), toolMsg('edit', { path: '/x.tsx' }), toolMsg('write', { path: '/x.tsx' })]
    const items = buildProcessRenderItems(msgs)
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ kind: 'file-group', path: '/x.tsx' })
    expect((items[0] as any).items).toHaveLength(3)
  })

  it('不同文件各自成组；中间隔非文件消息则断开', () => {
    const msgs = [
      toolMsg('edit', { path: '/x.tsx' }),
      toolMsg('edit', { path: '/y.tsx' }),
      toolMsg('edit', { path: '/y.tsx' }),
      textMsg('接下来调整样式'),
      toolMsg('edit', { path: '/y.tsx' })
    ]
    const items = buildProcessRenderItems(msgs)
    expect(items.map(i => i.kind)).toEqual(['file-group', 'file-group', 'single', 'file-group'])
    expect((items[1] as any).items).toHaveLength(2)
    expect((items[3] as any).items).toHaveLength(1) // 被叙述隔断,不并入前组
  })

  it('既非 edit/write 也非探索类的工具消息保持单条', () => {
    const msgs = [toolMsg('bash', { command: 'ls' }), toolMsg('execute_code', { code: '1+1' })]
    const items = buildProcessRenderItems(msgs)
    expect(items.map(i => i.kind)).toEqual(['single', 'single'])
  })

  it('相邻探索步骤(读文件/找文件/搜网页)并成一组,文件与搜索分别计数', () => {
    const msgs = [
      toolMsg('web_search', { query: 'electron iframe' }),
      toolMsg('read', { path: '/x.tsx' }),
      toolMsg('grep', { pattern: 'srcdoc' }),
    ]
    const items = buildProcessRenderItems(msgs)
    expect(items.map(i => i.kind)).toEqual(['explore-group'])
    expect((items[0] as any).searches).toBe(1)
    expect((items[0] as any).files).toBe(2)
    expect((items[0] as any).items).toHaveLength(3)
  })

  it('探索组被非探索步骤隔断则断开(时间线不被抹平)', () => {
    const msgs = [
      toolMsg('read', { path: '/x.tsx' }),
      toolMsg('bash', { command: 'npm test' }),
      toolMsg('read', { path: '/y.tsx' }),
    ]
    const items = buildProcessRenderItems(msgs)
    expect(items.map(i => i.kind)).toEqual(['explore-group', 'single', 'explore-group'])
    expect((items[0] as any).files).toBe(1)
    expect((items[2] as any).files).toBe(1)
  })

  it('连续 thinking 聚成一组;被其它消息隔断则断开', () => {
    const msgs = [
      thinkMsg('第一步推理'),
      thinkMsg('继续推理'),
      textMsg('先记录一个中间结论'),
      thinkMsg('重新开始一段推理'),
    ]
    const items = buildProcessRenderItems(msgs)
    expect(items.map(i => i.kind)).toEqual(['think-group', 'single', 'think-group'])
    expect((items[0] as any).items).toHaveLength(2)
    expect((items[2] as any).items).toHaveLength(1)
  })

  it('同一长期档案的读取跨其它消息聚合，别名保持稳定 descriptor', () => {    const base = '/Users/u/.openpipal/workspace/assets/teacher/小学语文'
    const msgs = [
      toolMsg('read', { path: `${base}/风格.md` }),
      textMsg('先核对一项资料'),
      toolMsg('read', { path: `${base}/refs/README.md` }),
      toolMsg('read', { path: '/Users/u/.openpipal/workspace/assets/teacher/初中物理/风格.md' }),
    ]
    const items = buildProcessRenderItems(msgs)

    expect(items.map(i => i.kind)).toEqual(['archive-group', 'single', 'archive-group'])
    const first = items[0]
    const third = items[2]
    if (first.kind !== 'archive-group' || third.kind !== 'archive-group') {
      throw new Error('expected archive groups')
    }
    expect(first.items).toHaveLength(2)
    expect(first.info).toMatchObject({
      groupName: '小学语文',
      docName: { raw: '风格', translationKey: 'chat.fileDisplay.aliases.styleOverview' },
    })
    expect(third.items).toHaveLength(1)
    expect(third.info.groupName).toBe('初中物理')
  })
})
