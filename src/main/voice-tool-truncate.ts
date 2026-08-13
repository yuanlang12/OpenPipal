/**
 * Voice 模式工具结果截断逻辑 —— 纯函数，无任何 electron / 业务依赖
 *
 * 抽到独立文件让 node --experimental-strip-types 能直接跑单测。
 * 与 realtime-tool-bridge.ts 解耦：bridge 调 buildPiTools 时拉一整套依赖图，
 * 而单测只关心截断逻辑——独立后单测 0 副作用启动。
 */

/** Artifact 类工具：产出大内容（HTML / 文档 / 卡片），结果只回 ack，原文留在 chat 面板 */
export const ARTIFACT_TOOLS = new Set<string>([
  'create_visualizer',
  'create_artifact',
  'present_to_user',
  'generate_document'
])

export const MAX_VOICE_RESULT_CHARS = 4000

/**
 * 把工具结果转成 voice context 适配的紧凑字符串。
 * @param toolName 工具名（决定特殊处理分支）
 * @param result Pi AgentToolResult 形态：{ content: [{type:'text', text}], details: {...} }
 */
export function truncateForVoice(toolName: string, result: any): string {
  // 1. Artifact 类工具：回 ack + title + **id**（真实内容已通过 chat:* 管线渲染到聊天面板）。
  //    必须带 id：用户要改稿时,模型得用同一个 id 调 create_artifact/create_visualizer 原地更新——
  //    这正是文字模式能更新、语音模式之前不能的原因(之前这里丢了 id、还叫模型"不要再调工具")。
  if (ARTIFACT_TOOLS.has(toolName)) {
    const d = result?.details || {}
    // 把手可能在 artifact/visualizer/document(create_*) 或 args(generate_document) 里——都要看,
    // 否则像 generate_document 这样把 filePath/title 放 details.args 的工具,会被本分支整段丢掉。
    const meta = d.artifact || d.visualizer || d.document || d.args || {}
    const title = meta.title || toolName
    const id = meta.id || ''                                  // create_artifact / create_visualizer 用于原地更新
    const filePath = meta.filePath || ''                      // generate_document 用于后续打开/发送
    const parts = [`已生成「${title}」`]
    if (id) parts.push(`(id: ${id})`)
    parts.push('，已显示在聊天面板里。先用一句话简短告诉用户结果。')
    if (id) parts.push(`若用户要修改/换版式，用同一个 id（${id}）再次调用同一工具即可原地更新，不要新建。`)
    if (filePath) parts.push(`文件保存在 ${filePath}，用户要打开/发送时用这个路径。`)
    return JSON.stringify({ ok: true, id, filePath, message: parts.join('') })
  }

  // 2. web_search：取前 5 条(含 url,便于模型引用/追问),文字模式拿全量、语音给够用即可
  if (toolName === 'web_search' && Array.isArray(result?.details?.results)) {
    const top = result.details.results.slice(0, 5)
    const text = top
      .map((r: any) => `- ${r.title || ''}（${r.url || ''}）: ${r.snippet || r.description || ''}`)
      .join('\n')
    return text || 'No results.'
  }

  // 3. 通用：取 content[*].text 拼接，空 content / 无文本块时回落到 details
  let text = ''
  if (typeof result === 'string') {
    text = result
  } else if (Array.isArray(result?.content)) {
    text = result.content
      .filter((b: any) => b?.type === 'text' && typeof b.text === 'string')
      .map((b: any) => b.text)
      .join('\n')
  }
  // 文本仍为空（content 全是非文本块 / 完全空数组 / 根本没 content）→ 回落 details
  if (!text) {
    text = JSON.stringify(result?.details || result || {})
  }

  // 4. 长度截断
  if (text.length > MAX_VOICE_RESULT_CHARS) {
    const truncated = text.substring(0, MAX_VOICE_RESULT_CHARS)
    const omitted = text.length - MAX_VOICE_RESULT_CHARS
    return `${truncated}\n... [voice 模式截断了后续 ${omitted} 字符；完整内容已在聊天面板展示]`
  }
  return text
}
