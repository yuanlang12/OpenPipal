#!/usr/bin/env node
/**
 * 真机验收用的最小 MCP 服务器（stdio）：三个工具各带一种协议注解，
 * 用来证明 OpenPipal 真的按 readOnlyHint / destructiveHint 分级，而不是一律弹确认。
 *   list_notes   readOnlyHint    → 应免确认
 *   delete_note  destructiveHint → 应弹"可能删除或覆盖数据"的确认
 *   add_note     无注解          → 应弹普通确认
 * 每次调用追加一行到 NOTES_CALL_LOG（测试用它核对调用顺序，不靠模型措辞）。
 */
import { appendFileSync } from 'node:fs'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const notes = new Map([
  ['n1', '周一例会纪要'],
  ['n2', '草稿：给家长的通知'],
  ['n3', '期末复习计划']
])
const log = (line) => { if (process.env.NOTES_CALL_LOG) appendFileSync(process.env.NOTES_CALL_LOG, `${line}\n`) }
const text = (value) => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }] })

const server = new McpServer({ name: 'notes', version: '0.0.1' })

server.registerTool('list_notes', {
  description: '列出所有笔记（id 与标题）',
  inputSchema: {},
  annotations: { readOnlyHint: true }
}, async () => {
  log('list_notes')
  return text([...notes].map(([id, title]) => ({ id, title })))
})

server.registerTool('delete_note', {
  description: '按 id 删除一条笔记',
  inputSchema: { id: z.string().describe('笔记 id，如 n2') },
  annotations: { destructiveHint: true }
}, async ({ id }) => {
  log(`delete_note ${id}`)
  const existed = notes.delete(id)
  return text(existed ? `已删除 ${id}` : `没有 ${id} 这条笔记`)
})

server.registerTool('add_note', {
  description: '新增一条笔记',
  inputSchema: { title: z.string().describe('标题') }
}, async ({ title }) => {
  const id = `n${notes.size + 1}`
  notes.set(id, title)
  log(`add_note ${id}`)
  return text(`已新增 ${id}`)
})

await server.connect(new StdioServerTransport())
