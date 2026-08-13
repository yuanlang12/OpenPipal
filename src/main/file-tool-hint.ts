/**
 * execute_code 的"该用工具"证据式反馈。
 *
 * 命中不拦截、不改行为，只在工具结果尾部附一行事实，让模型自己改道。
 *
 * 为什么是提示而不是硬拒（机制分层：证据式反馈优先于硬拒绝）：`open(...)` 也可能是
 * "读进来做真计算"，硬拦会误伤；而绕道的三笔代价——多一次用户确认（execute_code 在沙箱
 * 未启用时每次都要点允许）、整篇文件进上下文、产物脱离 artifact 管线——模型只要知道就有
 * 动力自己避开。
 *
 * 实案（2026-07-29）：design 角色用 `open(路径).read()` + 正则找 CSS 类，而 grep/read/edit
 * 就在它的工具表里——不是没得用，是没想起来用。
 *
 * 日落条件：模型在无提示的情况下也稳定优先选文件工具（连续多轮零命中）→ 可摘。
 */

const FILE_IO_CODE_RE =
  /\bopen\s*\(\s*['"`/~]|\bPath\s*\([^)]*\)\s*\.\s*(read_text|write_text|read_bytes|write_bytes)|\bfs\s*\.\s*(readFileSync|writeFileSync|appendFileSync|readFile|writeFile)|require\s*\(\s*['"]fs['"]\s*\)|\bwith\s+open\s*\(/

export function fileToolHint(code: string): string {
  if (!FILE_IO_CODE_RE.test(code || '')) return ''
  return (
    '\n\n💡 这段代码在直接读写文件。本机有专用工具：read（读文件）/ grep（按内容查找，不用把整篇读进上下文）/ ' +
    'edit（精确替换）/ write（写文件）。它们是安全操作、不用每次找用户确认，结果也更省上下文——' +
    '下次这类操作直接用工具，execute_code 留给真正需要计算的场合。'
  )
}
