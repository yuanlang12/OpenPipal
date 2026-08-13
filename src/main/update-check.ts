/**
 * 版本检查 —— 问一次 GitHub Releases，不部署任何服务。
 *
 * 只在用户打开「关于」时发一次请求，不在启动时发：启动即联网等于每次开机都
 * 向外报一次到。打开关于页是个明确的"告诉我这个应用的情况"的动作，够作依据。
 *
 * 只从响应里取 tag_name 一个字段，且**不回传任何 URL**：下载链接在渲染层写死。
 * 远端字段是不可信输入，让它变成一个能点的地址（最终会走到 shell.openExternal）
 * 就是个漏洞——不接这个数据，这条路就不存在。
 */
import type { UpdateCheckResult } from '../shared/update-contract'

const RELEASES_API = 'https://api.github.com/repos/yuanlang12/OpenPipal/releases/latest'
const TIMEOUT_MS = 8000


/** `v1.2.3` / `1.2.3-beta.1` → [1, 2, 3]；取不出数字就返回 null */
function parseVersion(raw: string): number[] | null {
  const core = raw.trim().replace(/^v/i, '').split(/[-+]/)[0]
  const segments = core.split('.')
  // 每段必须是非空数字串：Number('') 是 0，空串会被当成版本 0 —— 于是任何版本
  // 都"比它新"，检查结果凭空冒出来。这是 JS 里最容易踩的一脚。
  if (!segments.length || segments.some(segment => !/^\d+$/.test(segment))) return null
  return segments.map(Number)
}

/** a 比 b 新则返回 true。段数不同时短的补 0（1.2 与 1.2.0 等价）。 */
export function isNewerVersion(a: string, b: string): boolean {
  const left = parseVersion(a)
  const right = parseVersion(b)
  if (!left || !right) return false
  const width = Math.max(left.length, right.length)
  for (let i = 0; i < width; i++) {
    const l = left[i] ?? 0
    const r = right[i] ?? 0
    if (l !== r) return l > r
  }
  return false
}

export async function checkForUpdate(currentVersion: string): Promise<UpdateCheckResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const response = await fetch(RELEASES_API, {
      headers: { Accept: 'application/vnd.github+json' },
      signal: controller.signal
    })
    // 仓库私有时未认证访问返回 404；这不是错误，只是还查不到，安静收场
    if (!response.ok) return { status: 'unavailable' }
    const release = (await response.json()) as { tag_name?: unknown }
    const tag = typeof release?.tag_name === 'string' ? release.tag_name : ''
    if (!tag || !parseVersion(tag)) return { status: 'unavailable' }
    return isNewerVersion(tag, currentVersion)
      ? { status: 'update-available', current: currentVersion, latest: tag.replace(/^v/i, '') }
      : { status: 'up-to-date', current: currentVersion }
  } catch {
    return { status: 'unavailable' }
  } finally {
    clearTimeout(timer)
  }
}
