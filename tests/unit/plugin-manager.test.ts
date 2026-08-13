/**
 * plugin-manager 单测 —— Agent Plugins 1.0.0 校验核心
 *
 * 覆盖:manifest 校验(名称规则/闭集字段/失败边界)、skills 发现(仅直接子目录)、
 * mcp.json 解析(传输类型/占位符展开/路径安全/密钥禁区)。
 * plugin-manager 不依赖 electron,直接以临时目录 fixture 驱动 scanPluginDir。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  isValidPluginName,
  parsePluginManifest,
  expandPlaceholders,
  scanPluginDir,
  getPluginDataDir,
  PLUGIN_SCHEMA_URL,
  MCP_SCHEMA_URL
} from '../../src/main/plugin-manager'

const NO_DISABLED = new Set<string>()

function manifest(extra: Record<string, unknown> = {}, name = 'demo-plugin'): string {
  return JSON.stringify({ $schema: PLUGIN_SCHEMA_URL, name, ...extra })
}

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sw-plugin-test-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function makePlugin(files: Record<string, string>, dirName = 'demo-plugin'): string {
  const dir = join(root, dirName)
  for (const [rel, content] of Object.entries(files)) {
    const p = join(dir, rel)
    mkdirSync(join(p, '..'), { recursive: true })
    writeFileSync(p, content, 'utf-8')
  }
  return dir
}

describe('插件名称规则', () => {
  it('接受合法名称', () => {
    for (const n of ['a', 'my-plugin', 'a1.b2', 'x'.repeat(64)]) {
      expect(isValidPluginName(n), n).toBe(true)
    }
  })
  it('拒绝非法名称', () => {
    for (const n of ['', 'A-upper', '-lead', 'trail-', 'a--b', 'a..b', '.dot', 'x'.repeat(65), '中文', 'a b']) {
      expect(isValidPluginName(n), n).toBe(false)
    }
  })
})

describe('manifest 校验', () => {
  it('最小合法 manifest 通过,未知字段报告并忽略', () => {
    const r = parsePluginManifest(manifest({ mystery: 1 }))
    expect(r.manifest?.name).toBe('demo-plugin')
    expect(r.invalid).toBeUndefined()
    expect(r.warnings.some(w => w.includes('mystery'))).toBe(true)
  })
  it('缺失/错误 $schema 致命', () => {
    expect(parsePluginManifest(JSON.stringify({ name: 'a' })).invalid).toMatch(/\$schema/)
    expect(parsePluginManifest(JSON.stringify({ $schema: 'https://other', name: 'a' })).invalid).toMatch(/\$schema/)
  })
  it('已知字段类型错误致命(闭集模式)', () => {
    expect(parsePluginManifest(manifest({ version: 3 })).invalid).toMatch(/version/)
    expect(parsePluginManifest(manifest({ keywords: 'oops' })).invalid).toMatch(/keywords/)
    expect(parsePluginManifest(manifest({ author: 'someone' })).invalid).toMatch(/author/)
  })
  it('extensions 非对象仅警告不致命', () => {
    const r = parsePluginManifest(manifest({ extensions: 'nope' }))
    expect(r.invalid).toBeUndefined()
    expect(r.warnings.some(w => w.includes('extensions'))).toBe(true)
  })
})

describe('占位符展开', () => {
  it('只认 PLUGIN_ROOT/PLUGIN_DATA,未识别的保持字面', () => {
    expect(expandPlaceholders('${PLUGIN_ROOT}/bin:${PLUGIN_DATA}/db:${HOME}', '/r', '/d'))
      .toBe('/r/bin:/d/db:${HOME}')
  })
})

describe('scanPluginDir:组件发现与失败边界', () => {
  it('缺 plugin.json → 整包无效', () => {
    const dir = makePlugin({ 'skills/foo/SKILL.md': '# x' })
    const r = scanPluginDir(dir, 'demo-plugin', NO_DISABLED)
    expect(r.info.invalid).toMatch(/plugin\.json/)
    expect(r.skillsDir).toBeUndefined()
  })

  it('skills 只认直接子目录里的 SKILL.md', () => {
    const dir = makePlugin({
      'plugin.json': manifest(),
      'skills/alpha/SKILL.md': '# a',
      'skills/beta/nested/SKILL.md': '# 深层不算',
      'skills/not-a-skill/readme.md': 'x'
    })
    const r = scanPluginDir(dir, 'demo-plugin', NO_DISABLED)
    expect(r.info.invalid).toBeUndefined()
    expect(r.info.skillNames).toEqual(['alpha'])
    expect(r.skillsDir).toBe(join(dir, 'skills'))
  })

  it('mcp.json 无效 JSON → 仅禁用 MCP,技能照常', () => {
    const dir = makePlugin({
      'plugin.json': manifest(),
      'skills/alpha/SKILL.md': '# a',
      'mcp.json': '{oops'
    })
    const r = scanPluginDir(dir, 'demo-plugin', NO_DISABLED)
    expect(r.info.invalid).toBeUndefined()
    expect(r.info.skillNames).toEqual(['alpha'])
    expect(r.mcpServers).toEqual([])
    expect(r.info.warnings.some(w => w.includes('mcp.json'))).toBe(true)
  })

  it('stdio server:占位符展开 + cwd 默认插件根 + ./ 命令解析进根', () => {
    const dir = makePlugin({
      'plugin.json': manifest(),
      'bin/serve': '#!/bin/sh',
      'mcp.json': JSON.stringify({
        $schema: MCP_SCHEMA_URL,
        mcpServers: {
          local: {
            type: 'stdio',
            command: './bin/serve',
            args: ['--data', '${PLUGIN_DATA}/store'],
            env: { CONFIG: '${PLUGIN_ROOT}/cfg.json' }
          }
        }
      })
    })
    const r = scanPluginDir(dir, 'demo-plugin', NO_DISABLED)
    expect(r.mcpServers).toHaveLength(1)
    const cfg = r.mcpServers[0].config
    expect(cfg.command).toBe(join(dir, 'bin/serve'))
    expect(cfg.args).toEqual(['--data', join(getPluginDataDir('demo-plugin'), 'store')])
    expect(cfg.env).toEqual({ CONFIG: join(dir, 'cfg.json') })
    expect(cfg.cwd).toBe(dir)
  })

  it('危险/非法 server 条目逐条跳过:路径逃逸、env 保留键、非环回 http、sse', () => {
    const dir = makePlugin({
      'plugin.json': manifest(),
      'mcp.json': JSON.stringify({
        $schema: MCP_SCHEMA_URL,
        mcpServers: {
          escape: { type: 'stdio', command: './../outside' },
          reserved: { type: 'stdio', command: 'node', env: { PLUGIN_ROOT: '/tmp' } },
          insecure: { type: 'streamable-http', url: 'http://evil.example.com/mcp' },
          legacy: { type: 'sse', url: 'https://ok.example.com/sse' },
          good: { type: 'streamable-http', url: 'https://ok.example.com/mcp' },
          loop: { type: 'streamable-http', url: 'http://localhost:3100/mcp' }
        }
      })
    })
    const r = scanPluginDir(dir, 'demo-plugin', NO_DISABLED)
    expect(r.mcpServers.map(s => s.serverName).sort()).toEqual(['good', 'loop'])
    expect(r.info.warnings.length).toBeGreaterThanOrEqual(4)
  })

  it('禁用列表生效,目录名与 manifest 名不一致仅警告', () => {
    const dir = makePlugin({ 'plugin.json': manifest({}, 'real-name') }, 'folder-name')
    const r = scanPluginDir(dir, 'folder-name', new Set(['real-name']))
    expect(r.info.name).toBe('real-name')
    expect(r.info.enabled).toBe(false)
    expect(r.info.warnings.some(w => w.includes('不一致'))).toBe(true)
  })
})
