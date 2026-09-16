import { afterAll, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import path from 'path'

const { TMP } = vi.hoisted(() => ({
  TMP: `/private/tmp/openpipal-output-history-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}))

// 只对本测试加载的模块伪造 home，不能改 process.env.HOME 污染同一 Vitest worker 的其它用例。
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>()
  return { ...actual, homedir: () => TMP }
})

const { listOutputHistory } = await import('../../src/main/memory-manager')
const { createWorkspace, getAgentOutputsDir } = await import('../../src/main/agent-workspace-store')

afterAll(() => {
  fs.rmSync(TMP, { recursive: true, force: true })
})

describe('listOutputHistory', () => {
  it('聚合全局与各 Agent 的输出文件，并保留归属', () => {
    const globalDir = path.join(TMP, '.openpipal', 'outputs')
    fs.mkdirSync(globalDir, { recursive: true })
    fs.writeFileSync(path.join(globalDir, '全局报告.pdf'), 'global')

    const workspace = createWorkspace({ name: '研究 Agent', icon: '🔬', description: 'test' })
    const agentDir = getAgentOutputsDir(workspace.id)
    fs.mkdirSync(agentDir, { recursive: true })
    fs.writeFileSync(path.join(agentDir, 'Agent 汇报.pptx'), 'agent')

    expect(listOutputHistory()).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: '全局报告.pdf', scope: 'global', ext: 'pdf' }),
      expect.objectContaining({ name: 'Agent 汇报.pptx', scope: 'agent', workspaceId: workspace.id, workspaceName: '研究 Agent', ext: 'pptx' })
    ]))
  })

  it('多进会话 UUID 命名的子目录（模型产物按会话分目录），历史手写的 bundle 目录与 .self-check 不进', () => {
    const globalDir = path.join(TMP, '.openpipal', 'outputs')
    const conv = '0f9c1a2b-3d4e-4f60-8a7b-9c0d1e2f3a4b'
    fs.mkdirSync(path.join(globalDir, conv, '.self-check'), { recursive: true })
    fs.writeFileSync(path.join(globalDir, conv, '会话报告.pdf'), 'conv')
    fs.writeFileSync(path.join(globalDir, conv, '.self-check', 'artifact-1.png'), 'png')
    fs.mkdirSync(path.join(globalDir, '手写的项目'), { recursive: true })
    fs.writeFileSync(path.join(globalDir, '手写的项目', 'index.html'), 'legacy')

    const names = listOutputHistory().map(e => e.name)
    expect(listOutputHistory()).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: '会话报告.pdf', scope: 'global', conversationId: conv })
    ]))
    expect(names).not.toContain('artifact-1.png')
    expect(names).not.toContain('index.html')
  })
})
