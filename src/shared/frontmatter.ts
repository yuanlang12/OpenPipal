/**
 * agent.md 的 frontmatter（`---` 包起来的 `key: value` 行）+ 正文。内置角色与 Pal 共用同一种写法：
 * 主进程（role-loader / agent-registry）按它读声明，渲染层（Pal 面板）按它把声明与人设正文分开显示——同一个解析器。
 * 极简：只支持 `key: value` 和 `key: a, b, c`，不支持嵌套 / 列表字面量 / 引号转义——我们用不到。
 */
export interface ParsedMd {
  frontmatter: Record<string, string>
  body: string
}

export function parseFrontmatter(content: string): ParsedMd {
  const lines = content.split('\n')
  if (lines[0]?.trim() !== '---') {
    return { frontmatter: {}, body: content }
  }
  const frontmatter: Record<string, string> = {}
  let endIdx = -1
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') { endIdx = i; break }
    const m = lines[i].match(/^([a-zA-Z_][\w-]*)\s*:\s*(.*)$/)
    if (m) {
      const key = m[1].trim()
      let value = m[2].trim()
      // 去掉可能的首尾引号
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1)
      }
      frontmatter[key] = value
    }
  }
  if (endIdx === -1) return { frontmatter: {}, body: content }
  const body = lines.slice(endIdx + 1).join('\n').replace(/^\n+/, '')
  return { frontmatter, body }
}
