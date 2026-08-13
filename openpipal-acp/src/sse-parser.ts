/**
 * SSE 解析器：把 fetch response body (ReadableStream<Uint8Array>) 拆成 JSON 事件流
 *
 * OpenPipal 桌面端的 /chat/stream 输出格式：
 *   data: {"type":"text","content":"...","conversationId":"..."}\n\n
 *   data: {"type":"tool_start","name":"..."}\n\n
 *   ...
 *   data: {"type":"done"}\n\n
 */

export async function* parseSSE(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<any> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    while (true) {
      if (signal?.aborted) return

      const { value, done } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })

      // SSE 事件以 \n\n 分隔
      let idx
      while ((idx = buffer.indexOf('\n\n')) >= 0) {
        const chunk = buffer.slice(0, idx)
        buffer = buffer.slice(idx + 2)

        // 每个 chunk 形如 "data: {...}"
        const dataLine = chunk.split('\n').find((l) => l.startsWith('data: '))
        if (!dataLine) continue

        const json = dataLine.slice(6).trim()
        if (!json) continue

        try {
          yield JSON.parse(json)
        } catch (err) {
          console.error(`[openpipal-acp] failed to parse SSE chunk: ${json.slice(0, 100)}`)
        }
      }
    }
  } finally {
    try {
      reader.releaseLock()
    } catch {}
  }
}
