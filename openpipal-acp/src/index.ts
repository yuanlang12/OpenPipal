/**
 * openpipal-acp — bin entry
 *
 * 启动 stdio JSON-RPC 监听，把 ACP 协议翻译给 OpenPipal 桌面端。
 * stdout 只发 ACP 消息——所有日志走 stderr，避免污染 JSON-RPC 流。
 */

import * as v1 from '@agentclientprotocol/sdk'
import * as v2 from '@agentclientprotocol/sdk/experimental/v2'
import { Readable, Writable } from 'node:stream'
import { OpenPipalAgentRuntime, createV1Agent, createV2Agent } from './agent.js'

// 把 Node.js stdio 转成 Web Streams API（ACP SDK 要求）
const inStream = Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>
const outStream = Writable.toWeb(process.stdout) as unknown as WritableStream<Uint8Array>

// 注意：ndJsonStream 第一个参数是 output（stdout），第二个是 input（stdin）
const stream = v1.ndJsonStream(outStream, inStream)
const runtime = new OpenPipalAgentRuntime()
const router = v2.agentProtocolRouter().withV1(createV1Agent(runtime))
const v2Enabled = ['1', 'true', 'yes'].includes((process.env.OPENPIPAL_ACP_V2 || '').toLowerCase())

if (v2Enabled) router.withV2(createV2Agent(runtime))
router.connect(stream)

// 编辑器关掉适配器的方式是关 stdio，不发信号。常驻推送通道会一直握着活 handle，
// 所以必须显式收摊退出，否则留下孤儿进程 + 桌面端那边一条永远不回收的订阅。
let shuttingDown = false
const shutdown = (reason: string): void => {
  if (shuttingDown) return
  shuttingDown = true
  console.error(`[openpipal-acp] ${reason} → 收摊退出`)
  void runtime.shutdown().finally(() => process.exit(0))
}
process.stdin.once('end', () => shutdown('stdin 已关闭'))
process.stdin.once('close', () => shutdown('stdin 已关闭'))

console.error(
  `[openpipal-acp] started on stdio (ACP v1${v2Enabled ? ' + experimental v2' : ''})`,
)
