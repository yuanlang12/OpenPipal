/**
 * 入口文档注入接进系统提示词的接线（Phase 1）
 *
 * project-context.ts 自己的边界由 project-context-injection.test.ts 钉；这里钉的是
 * **它有没有真的进到那一条系统提示词里**，以及两个连带修正：
 *
 * 1. 提示词里的"工作目录"过去是各分支现推的默认值，用户在会话里选了仓库之后它还在说
 *    Agent 的草稿区——模型照着那句话找文件，找不到。现在必须报运行时真正会用的目录。
 * 2. 已经原文注入了，就不能再让 codebase 资产那条动线叫模型"优先读 AGENTS.md"——
 *    那是白花一次工具往返读一份已经在上下文里的东西。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  roles: {
    general: {
      name: 'general',
      displayName: 'General',
      icon: '',
      systemPrompt: 'SYSTEM:general',
      tools: [],
      memoryEnabled: true
    }
  } as Record<string, any>
}))

vi.mock('../../src/main/role-manager', () => ({
  getCurrentRole: () => state.roles.general,
  getRoleConfig: (name: string) => state.roles[name] || null
}))
vi.mock('../../src/main/agent-workspace-store', () => ({
  readMeMd: () => '',
  readToolsConfig: () => ({})
}))
vi.mock('../../src/main/config-manager', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/config-manager')>()),
  isAutoMemoryEnabled: () => false
}))
vi.mock('../../src/main/memory-store', () => ({ buildMemoryContext: () => '' }))
vi.mock('../../src/main/memory-manager', () => ({
  formatMemoriesForPrompt: () => '',
  getRecentMemories: () => []
}))
vi.mock('../../src/main/mcp-manager', () => ({
  getMcpToolIndex: () => '',
  hasVisibleMcpServer: () => false
}))
vi.mock('../../src/main/cli-registry', () => ({ formatCliPrompt: () => '' }))
vi.mock('../../src/main/window-tracker', () => ({
  getCurrentConfig: () => ({ displayName: 'Finder', processName: 'Finder' }),
  isDockedToTargetApp: () => false
}))
vi.mock('../../src/main/artifact-store', () => ({
  listConversationArtifacts: () => [],
  coarseTypeFromFile: () => 'text'
}))
vi.mock('../../src/main/artifact-registry', () => ({
  getArtifactStore: () => ({ getRecord: () => null })
}))

const { prepareOpenPipalSystemPrompt } = await import('../../src/main/agent-runtime/openpipal-prompt-core')
const { invalidateProjectContextSnapshots } = await import('../../src/main/agent-runtime/project-context')

const roots: string[] = []

function makeRepo(agentsMd: string): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'op-ctx-wire-')))
  roots.push(root)
  const repo = path.join(root, 'repo')
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true })
  fs.writeFileSync(path.join(repo, 'AGENTS.md'), agentsMd, 'utf-8')
  return repo
}

function render(overrides: Record<string, unknown>): string {
  return prepareOpenPipalSystemPrompt('desktop', overrides as any, { stablePrefix: true }).render()
}

beforeEach(() => invalidateProjectContextSnapshots())
afterEach(() => {
  for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
  invalidateProjectContextSnapshots()
})

describe('入口文档进系统提示词', () => {
  it('没设工作目录（默认落在 Agent 数据区）时，提示词里一个字都不多', () => {
    const prompt = render({ conversationId: 'conv-none' })
    expect(prompt).not.toContain('<project_context>')
  })

  it('工作目录指向带 AGENTS.md 的仓库时，正文进提示词', () => {
    const repo = makeRepo('# 仓库规矩\n跑测试用 `pnpm test`，别碰 `generated/`')
    const prompt = render({ conversationId: 'conv-repo', workingDir: repo })

    expect(prompt).toContain('<project_context>')
    expect(prompt).toContain('pnpm test')
    expect(prompt).toContain(`<project_instructions path="${path.join(repo, 'AGENTS.md')}">`)
  })

  it('提示词里的"工作目录"报的是运行时真正会用的目录，不是 Agent 草稿区', () => {
    const repo = makeRepo('规矩')
    const prompt = render({ conversationId: 'conv-wd', workingDir: repo })
    expect(prompt).toContain(`工作目录：\`${repo}\``)
    expect(prompt).toContain(`所有文件操作、代码执行、依赖安装都在 \`${repo}\` 内进行`)
  })

  it('注入之后，codebase 动线改口成"别重复 read"', () => {
    const repo = makeRepo('规矩')
    const assets = [{ category: 'codebase', path: repo, sourceType: 'codebase', fileName: 'repo' }]

    const injected = render({ conversationId: 'conv-a', workingDir: repo, initialAssets: assets })
    expect(injected).toContain('**不要重复 read**')
    expect(injected).not.toContain('①优先读 README/AGENTS.md/package.json')

    // 没注入时（工作目录还在草稿区）保持原动线：文档还没在上下文里，就该去读
    const notInjected = render({ conversationId: 'conv-b', initialAssets: assets })
    expect(notInjected).toContain('①优先读 README/AGENTS.md/package.json')
    expect(notInjected).not.toContain('**不要重复 read**')
  })

  it('位置在工作空间之后、会话简报之前 —— 项目规矩先于本次任务的具体交代', () => {
    const repo = makeRepo('规矩')
    const prompt = render({
      conversationId: 'conv-order',
      workingDir: repo,
      projectName: 'X'
    })
    expect(prompt.indexOf('## 你的工作空间')).toBeLessThan(prompt.indexOf('<project_context>'))
    // 用换行开头定位真正的简报块——工作空间段里有一句散文提到 <conversation-brief>，
    // 裸 indexOf 会命中那一处，把顺序断言变成永远的假阳性
    expect(prompt.indexOf('<project_context>')).toBeLessThan(prompt.indexOf('\n<conversation-brief>'))
  })

  it('资产库不跟着工作目录漂 —— 它是本助手的跨会话素材，不住在用户的仓库里', () => {
    const repo = makeRepo('规矩')
    const prompt = render({ conversationId: 'conv-assets', workingDir: repo })
    expect(prompt).toContain('assets/general/')
    expect(prompt).not.toContain(`${repo}/assets/`)
  })

  it('同一会话内文档改了也不重算 —— 整段系统提示词是一个 prompt cache 块', () => {
    const repo = makeRepo('第一版规矩')
    const first = render({ conversationId: 'conv-cache', workingDir: repo })
    fs.writeFileSync(path.join(repo, 'AGENTS.md'), '第二版规矩', 'utf-8')

    expect(render({ conversationId: 'conv-cache', workingDir: repo })).toBe(first)
    expect(first).toContain('第一版规矩')
    expect(render({ conversationId: 'conv-fresh', workingDir: repo })).toContain('第二版规矩')
  })
})
