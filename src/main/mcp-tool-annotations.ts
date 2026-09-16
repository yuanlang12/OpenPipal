/**
 * MCP 协议的工具注解（tools/list 里每个工具自述的副作用形状）：
 *   readOnlyHint    只读，不改环境
 *   destructiveHint 可能删除或覆盖数据（协议默认值是 true，所以只认显式写了的）
 *   idempotentHint  重复调用无额外效果
 *   openWorldHint   触达外部世界（网络、第三方系统）
 *
 * 这是服务器给的事实，不是宿主猜的。以前风险分级靠工具名前缀猜 delete_/create_，
 * 而 MCP 工具压根走不到那段（origin 'mcp' 一律需确认）——只读工具也每次弹卡。
 * 注解来自用户自己装/连的服务器：它要撒谎，它作为本机子进程或已授权的远端本来就能干更多，
 * 所以按它说的分级并不扩大信任面；认不出（没写注解）仍旧每次问。
 */
export interface McpToolAnnotations {
  readOnlyHint?: boolean
  destructiveHint?: boolean
  idempotentHint?: boolean
  openWorldHint?: boolean
}

const ANNOTATION_KEYS = ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'] as const

/** 只收布尔值的四个键，别的一律丢：注解是远端输入，不能原样进内存再原样进提示词。 */
export function pickMcpToolAnnotations(raw: unknown): McpToolAnnotations | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const out: McpToolAnnotations = {}
  for (const key of ANNOTATION_KEYS) {
    const value = (raw as Record<string, unknown>)[key]
    if (typeof value === 'boolean') out[key] = value
  }
  return Object.keys(out).length ? out : undefined
}

/** 给模型看的一行事实（tools.describe 用）；没有注解返回空串。 */
export function describeMcpToolAnnotations(a: McpToolAnnotations | undefined): string {
  if (!a) return ''
  const parts: string[] = []
  if (a.readOnlyHint === true) parts.push('只读')
  else if (a.destructiveHint === true) parts.push('可能删除或覆盖数据')
  else if (a.destructiveHint === false) parts.push('会改动数据但不覆盖已有内容')
  if (a.idempotentHint === true) parts.push('重复调用无额外效果')
  if (a.openWorldHint === true) parts.push('触达外部系统')
  return parts.length ? `副作用（服务器自述）: ${parts.join('，')}` : ''
}
