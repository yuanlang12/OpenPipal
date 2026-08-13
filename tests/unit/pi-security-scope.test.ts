import { describe, expect, it } from 'vitest'
import os from 'os'
import path from 'path'
import { assessToolScope } from '../../src/main/pi-security'

const home = os.homedir()

describe('Agent 工具任务边界', () => {
  const scope = { conversationId: 'conv-own', workspaceId: 'agent-own', workingDir: '/tmp/work' }

  it('允许读取当前 Agent 工作区', () => {
    const p = path.join(home, '.openpipal', 'agents', 'agent-own', 'memory', 'note.md')
    expect(assessToolScope('read', { path: p }, scope)).toBeNull()
  })

  it('阻止读取其他 Agent 的 memory', () => {
    const p = path.join(home, '.openpipal', 'agents', 'agent-other', 'memory', 'note.md')
    expect(assessToolScope('read', { path: p }, scope)?.level).toBe('risky')
  })

  it('阻止 bash 扫描整个 OpenPipal agents 根目录', () => {
    const command = `find ${path.join(home, '.openpipal', 'agents')} -name '*.md'`
    expect(assessToolScope('bash', { command }, scope)?.reason).toContain('其他 Agent')
  })

  it('只允许当前会话的 artifact sidecar', () => {
    const own = path.join(home, '.openpipal', 'conversations', 'artifacts', 'conv-own', 'artifact-a.jsx')
    const other = path.join(home, '.openpipal', 'conversations', 'artifacts', 'conv-other', 'artifact-b.jsx')
    expect(assessToolScope('read', { path: own }, scope)).toBeNull()
    expect(assessToolScope('read', { path: other }, scope)?.level).toBe('risky')
  })

  it('阻止枚举共享 outputs，但允许使用明确文件路径', () => {
    const root = path.join(home, '.openpipal', 'outputs')
    expect(assessToolScope('bash', { command: `find ${root} -type f` }, scope)?.level).toBe('risky')
    expect(assessToolScope('bash', { command: `ffprobe ${root}/current.mp4` }, scope)).toBeNull()
  })

  it('阻止从 OpenPipal 根目录做一次性全库扫描', () => {
    expect(assessToolScope('bash', { command: 'find ~/.openpipal/ -name "*.md"' }, scope)?.level).toBe('risky')
    expect(assessToolScope('find', { path: path.join(home, '.openpipal', 'outputs') }, scope)?.level).toBe('risky')
  })

  it('发现工具省略 path 时仍按实际 workingDir 阻止全库扫描', () => {
    const rootScope = { ...scope, workingDir: path.join(home, '.openpipal') }
    expect(assessToolScope('grep', { pattern: 'apiKey' }, rootScope)?.level).toBe('risky')
    expect(assessToolScope('find', {}, rootScope)?.level).toBe('risky')
    expect(assessToolScope('ls', {}, rootScope)?.level).toBe('risky')
  })

  it('允许读取自己会话的 JSON,其他会话的仍然阻止', () => {
    const own = path.join(home, '.openpipal', 'conversations', 'conv-own.json')
    const other = path.join(home, '.openpipal', 'conversations', 'conv-other.json')
    expect(assessToolScope('read', { path: own }, scope)).toBeNull()
    expect(assessToolScope('read', { path: other }, scope)?.level).toBe('risky')
  })
})
