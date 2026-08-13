import { describe, expect, it, vi } from 'vitest'
import os from 'os'
import path from 'path'

vi.mock('../../src/main/sandbox-manager', () => ({ isSandboxed: () => true }))

import { classifyToolRisk } from '../../src/main/pi-security'

const home = os.homedir()
const tokensCss = path.join(home, '.openpipal', 'design-systems', 'demo', 'tokens', 'colors.css')
const RECEIPT = '[内容已保存，1348 字符；此为占位回执不可复制——需要原文用 read_artifact/read 重新读取]'

describe('回执门闩：write/edit 文件通道', () => {
  it('write 的 content 是回执 → 硬拒绝并指引先 read', () => {
    const r = classifyToolRisk('write', { path: tokensCss, content: RECEIPT })
    expect(r.level).toBe('risky')
    expect(r.reason).toContain('占位回执')
    expect(r.reason).toContain('read')
  })

  it('write_file / create_file 别名同样拦截', () => {
    for (const tool of ['write_file', 'create_file']) {
      expect(classifyToolRisk(tool, { path: tokensCss, content: `前缀\n${RECEIPT}\n后缀` }).level).toBe('risky')
    }
  })

  it('edit 的 newText 是回执 → 硬拒绝', () => {
    const r = classifyToolRisk('edit', { path: tokensCss, oldText: ':root { --x: 1; }', newText: RECEIPT })
    expect(r.level).toBe('risky')
    expect(r.reason).toContain('占位回执')
  })

  it('edit 的 edits[].newText 是回执 → 同样硬拒绝', () => {
    const r = classifyToolRisk('edit', {
      path: tokensCss,
      edits: [{ oldText: ':root { --x: 1; }', newText: RECEIPT }]
    })
    expect(r.level).toBe('risky')
    expect(r.reason).toContain('edits[].newText')
  })

  it('edit 的 JSON 字符串 edits 也不能绕过回执门闩', () => {
    const r = classifyToolRisk('edit', {
      path: tokensCss,
      edits: JSON.stringify([{ oldText: 'x', newText: RECEIPT }])
    })
    expect(r.level).toBe('risky')
  })

  it('edit 的 oldText 匹配回执属合法修复动作，不拦', () => {
    const r = classifyToolRisk('edit', { path: tokensCss, oldText: RECEIPT, newText: ':root { --x: 1; }' })
    expect(r.level).not.toBe('risky')
  })

  it('正常 CSS 内容不受影响', () => {
    const r = classifyToolRisk('write', { path: tokensCss, content: ':root { --brand: #3974B8; }' })
    expect(r.level).not.toBe('risky')
  })
})

describe('execute_code 与 bash/write 同权（python 旁路收窄）', () => {
  it('code 里含回执 → 硬拒绝', () => {
    const r = classifyToolRisk('execute_code', { language: 'python', code: `open('/tmp/x','w').write('${RECEIPT}')` })
    expect(r.level).toBe('risky')
    expect(r.reason).toContain('占位回执')
  })

  it('python 删除类 API → 需确认', () => {
    for (const code of ["import shutil; shutil.rmtree('/x')", "import os; os.remove('/x')", "Path('/x').unlink()"]) {
      const r = classifyToolRisk('execute_code', { language: 'python', code })
      expect(r.reason).toContain('删除')
    }
  })

  it('node fs 删除与 bash 语言的 rm -rf → 需确认', () => {
    expect(classifyToolRisk('execute_code', { language: 'javascript', code: "fs.rmSync('/x', {recursive: true})" }).reason).toContain('删除')
    expect(classifyToolRisk('execute_code', { language: 'bash', code: 'rm -rf /x' }).reason).toContain('删除')
  })

  it('未知/缺失语言硬拒绝，不能按 bash 回退绕过检查', () => {
    for (const language of ['sh', 'shell', 'python3', 'totally-unknown', undefined]) {
      const r = classifyToolRisk('execute_code', { language, code: 'rm -rf /x' })
      expect(r.level).toBe('risky')
      expect(r.reason).toContain('不支持的代码语言')
    }
  })

  it('合法语言做大小写和空白规范化后仍可用', () => {
    const r = classifyToolRisk('execute_code', { language: ' Python ', code: 'print(1)' })
    expect(r.reason).not.toContain('不支持的代码语言')
  })

  it('普通代码不误伤（含 !important 的写文件也不算删除）', () => {
    const r = classifyToolRisk('execute_code', { language: 'python', code: "open('/tmp/a.css','w').write('width: 100% !important')" })
    expect(r.reason).not.toContain('删除')
    expect(r.level).not.toBe('risky')
  })
})
