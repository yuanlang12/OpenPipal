/**
 * 浏览器操作的「站点轴」授权策略(Phase 4,纯逻辑)。
 *
 * 借鉴 Codex:按域名(host)闸门,而非按动作类型。读操作(list_tabs/read_page/
 * screenshot)在 pi-security 已直接放行;这里只决定"对某个 host 的写操作"
 * (navigate/click/fill/select/scroll)是 allow / confirm / block。
 *
 * 三态来源(优先级从高到低):
 *  - blocklist:    用户明确拉黑 → block(直接拒,不问)
 *  - allowlist:    用户「始终允许」→ allow(不问,持久)
 *  - sessionGrants:本对话「本对话允许」过 → allow(换对话即失效)
 *  - 其余        → confirm(弹三选项:本对话允许 / 始终允许此站点 / 拒绝)
 *
 * 纯函数,无 I/O —— allowlist/blocklist 的落盘读写与 sessionGrants 的对话内缓存
 * 由调用方(pi-security / browser-control)提供,便于单测。
 */
export type BrowserDecision = 'allow' | 'confirm' | 'block'

export interface BrowserPolicyState {
  /** 持久「始终允许」的 host 列表 */
  allowlist: string[]
  /** 持久拉黑的 host 列表 */
  blocklist: string[]
  /** 本对话「本对话允许」过的 host 列表(换对话清空) */
  sessionGrants: string[]
}

/** 从 URL 取 host(小写,去端口/路径)。取不到返回 '' */
export function hostOf(url: string | undefined | null): string {
  if (!url) return ''
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return ''
  }
}

/** host 是否命中规则:精确相等,或规则是父域(example.com 命中 a.example.com) */
export function hostMatches(host: string, rule: string): boolean {
  if (!host || !rule) return false
  const h = host.toLowerCase()
  const r = rule.toLowerCase().replace(/^\*\./, '') // 容忍 "*.example.com" 写法
  return h === r || h.endsWith('.' + r)
}

function listHas(list: string[], host: string): boolean {
  return Array.isArray(list) && list.some((rule) => hostMatches(host, rule))
}

/**
 * 站点轴决策。blocklist 优先级最高(即便同时在 allowlist 也拒),保证拉黑是硬边界。
 * 取不到 host(空白页 / about:)→ 保守 confirm。
 */
export function decideBrowserAction(host: string, state: BrowserPolicyState): BrowserDecision {
  if (!host) return 'confirm'
  if (listHas(state.blocklist, host)) return 'block'
  if (listHas(state.allowlist, host)) return 'allow'
  if (listHas(state.sessionGrants, host)) return 'allow'
  return 'confirm'
}
