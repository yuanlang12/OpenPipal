/**
 * 字符口径的 token 粗估（ASCII/4 + 其余/1.6）—— 压缩预算（history-compactor）、
 * 工具轨迹计量（tool-trail）、单条工具结果封顶（context-window-policy）、用量卡分区
 * （context-usage-stats）共用同一把尺子。
 *
 * 独立成叶子模块（零 import）是刻意的：这是纯函数，谁都用得上，但它原本住在
 * history-compactor 里，而那个模块拖着 config-manager / conversation-store /
 * simple-completion 一串依赖、被大量单测整体 mock——想复用就得连带 mock 一堆
 * 无关东西，于是各处宁可各抄一份、靠注释和单测防漂移。放在这里，复用的代价
 * 归零，公式就只剩这一处定义。
 */
export function estimateTokens(text: string): number {
  let ascii = 0
  let other = 0
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) < 128) ascii++
    else other++
  }
  return Math.ceil(ascii / 4 + other / 1.6)
}
