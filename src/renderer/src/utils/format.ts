/** 格式化文件大小为人类可读字符串 */
export function fmtSize(b: number): string {
  if (b < 1024) return `${b}B`
  if (b < 1048576) return `${(b / 1024).toFixed(1)}KB`
  return `${(b / 1048576).toFixed(1)}MB`
}

/** 相对时间（中文），支持分钟/小时/天/周粒度 */
export function timeAgo(ts: number): string {
  const diff = Date.now() - ts
  const minutes = Math.floor(diff / 60000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes}分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}小时前`
  const days = Math.floor(hours / 24)
  if (days === 1) return '昨天'
  if (days < 7) return `${days}天前`
  if (days < 30) return `${Math.floor(days / 7)}周前`
  return `${Math.floor(days / 30)}月前`
}

/**
 * 界面内展示产物标题时隐藏 .dc.html 技术后缀——它是内部格式标识，
 * 只有导出到外部时文件名才需要带（导出链路不经过本函数）。
 */
export function stripDcSuffix(title: string): string {
  return (title || '').replace(/\.dc\.html?$/i, '')
}

/**
 * 产物内容整体只是上下文压缩回执占位 = 曾被"回执当正文"缺陷覆写（成因已在
 * pi-tools 回执门闩拦死）。渲染层用它切换到损坏态提示，不渲染无意义的占位块。
 */
export function isReceiptOnlyContent(content: string): boolean {
  return /^\s*\[内容已保存，\d+ 字符[^\]]*\]\s*$/.test(content || '')
}
