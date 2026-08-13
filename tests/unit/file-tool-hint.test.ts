/**
 * execute_code 的"该用工具"证据式反馈锁。
 *
 * 这是提示不是门闩：命中只在结果尾部附一行事实，绝不拦截——`open()` 也可能是"读进来做真计算"。
 * 两个方向都要锁：该提示的别漏（模型绕道读写文件），不该提示的别吵（纯计算/字符串里出现 open）。
 */
import { describe, it, expect } from 'vitest'
import { fileToolHint } from '../../src/main/file-tool-hint'

const hinted = (code: string): boolean => fileToolHint(code).length > 0

describe('文件工具提示', () => {
  it('python 读文件 → 提示', () => {
    expect(hinted('content = open("/Users/x/.openpipal/workspace/a.html").read()')).toBe(true)
    expect(hinted('with open(path, "w") as f:\n    f.write(html)')).toBe(true)
    expect(hinted('from pathlib import Path\ntext = Path("/tmp/a.txt").read_text()')).toBe(true)
  })

  it('node 读写文件 → 提示', () => {
    expect(hinted('const fs = require("fs"); fs.writeFileSync("/tmp/a.html", html)')).toBe(true)
    expect(hinted('import fs from "fs"; const s = fs.readFileSync(p, "utf8")')).toBe(true)
  })

  it('纯计算 / 无文件 IO → 不提示（别吵）', () => {
    expect(hinted('print(sum(range(100)))')).toBe(false)
    expect(hinted('const r = [1,2,3].map(x => x * 2); console.log(r)')).toBe(false)
    expect(hinted('import re\nprint(re.findall(r"a+", "aaabbb"))')).toBe(false)
  })

  it('提示文案点名替代工具，且明确说是"下次"（不否定这次的结果）', () => {
    const hint = fileToolHint('open("/tmp/a")')
    expect(hint).toContain('grep')
    expect(hint).toContain('read')
    expect(hint).toContain('edit')
    expect(hint).not.toContain('拒绝')
  })
})
