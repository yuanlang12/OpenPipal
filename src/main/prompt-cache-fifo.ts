/**
 * Prompt 前缀缓存 P3 —— 纯逻辑辅助（无 electron / 业务依赖）
 *
 * 抽到独立文件让单测能直接 import，不拖进 pi-tools.ts / agent-overrides.ts
 * 的 electron 依赖图。两处调用方：
 * - pi-tools.ts：工具组粘滞判定（单调 include，防止连接态波动导致 tools 数组
 *   整组增删，破坏 OpenAI 兼容前缀缓存字节匹配）
 * - agent-overrides.ts：workspace basePrompt 会话快照的 FIFO 容量管理
 */

/**
 * 通用 FIFO 上限 Map 写入：超过 cap 时淘汰插入顺序最旧的 key。
 * 已存在的 key 原地更新值，不影响其淘汰顺序（与 pi-agent-service.ts 的
 * memoryContextSnapshots 同一约定）。
 */
export function capInsert<K, V>(map: Map<K, V>, key: K, value: V, cap: number): void {
  if (!map.has(key) && map.size >= cap) {
    const oldestKey = map.keys().next().value
    if (oldestKey !== undefined) map.delete(oldestKey)
  }
  map.set(key, value)
}

/**
 * 工具组粘滞判定：当前可用 或 本会话曾经可用（粘滞位）即注入。
 * 只进不出——一旦某会话见过某工具组，后续即使连接态变化也持续注入，
 * 避免 tools 数组随连接态波动而使前缀缓存整组失配。
 * 工具组首次出现（true 之前从未 true 过）仍会付一次失配代价——
 * 那是真实能力变化，应该付。
 */
export function computeStickyInclude(currentlyAvailable: boolean, stickyFlag: boolean | undefined): boolean {
  return currentlyAvailable || !!stickyFlag
}

/**
 * P4 缓存保留时长门控：只对"long 档真实生效且参数形状官方"的直连路径开 1h/24h 保留——
 * OpenPipal 交互天然断续（侧边伴随：问一句→干几分钟自己的活→再回来问），默认 5 分钟
 * TTL 极易过期、下一轮全量重付 input；一次 >5min 间隔省下的整段前缀重写远超 long 档
 * 更高的缓存写入单价（Anthropic 2x vs 1.25x）。
 * 第三方 OpenAI 兼容网关不开：pi-ai detectCompat 的 supportsLongCacheRetention 默认
 * true，开 'long' 会把 prompt_cache_retention/prompt_cache_key 塞进请求体，严格网关有
 * 400 风险；而网关侧隐式前缀缓存不吃该参数——零收益纯风险，保持 'short' 不动请求形状。
 */
export function resolveCacheRetentionForModel(model: { api?: string; baseUrl?: string } | undefined): 'long' | undefined {
  if (model?.api === 'anthropic-messages') return 'long'
  if (typeof model?.baseUrl === 'string' && model.baseUrl.includes('api.openai.com')) return 'long'
  return undefined
}
