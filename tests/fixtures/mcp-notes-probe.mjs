// 手工探针：起 mcp-notes-server.mjs，打印 tools/list 的注解并各调一次
//   NOTES_CALL_LOG=/tmp/notes-calls.log node tests/fixtures/mcp-notes-probe.mjs
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const c = new Client({ name: 'probe', version: '0' })
// SDK 默认只给子进程一套精简环境；NOTES_CALL_LOG 要显式传下去
await c.connect(new StdioClientTransport({ command: process.execPath, args: [join(here, 'mcp-notes-server.mjs')], env: { ...process.env } }))
const { tools } = await c.listTools()
for (const t of tools) console.log(t.name, JSON.stringify(t.annotations), JSON.stringify(t.inputSchema).slice(0, 80))
console.log(JSON.stringify(await c.callTool({ name: 'list_notes', arguments: {} })).slice(0, 200))
console.log(JSON.stringify(await c.callTool({ name: 'delete_note', arguments: { id: 'n2' } })))
await c.close()
