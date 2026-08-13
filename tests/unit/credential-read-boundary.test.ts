import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import {
  getAcpMcpTokenPath,
  getAuditLogPath,
  getBrowserControlPolicyPath,
  getCredentialReadDenyPaths,
  getDevelopmentEnvPath,
  getMcpOAuthRootPath,
  getMcpAppPermissionsPath,
  getOpenPipalConfigBackupPath,
  getOpenPipalConfigPath,
  getTasksRootPath,
  getUserMcpConfigPath,
  buildSensitiveReadGlobs,
  SENSITIVE_READ_GLOBS,
} from '../../src/main/credential-paths'
import {
  canonicalizeSecurityPath,
  ALLOWED_DIRS,
  SENSITIVE_DIRS,
  appendPrivateAuditLogLine,
  classifyToolRisk,
  createHardBoundaryHook,
  ensurePrivateAuditLogFile,
  initializeSecurityStorage,
} from '../../src/main/pi-security'
import { buildSandboxConfig } from '../../src/main/sandbox-manager'
import { dataPath, getOpenPipalHome } from '../../src/main/data-root'
import {
  createEvolverTaskMigrationTool,
  type EvolverTaskMigrationStore,
} from '../../src/main/evolver-task-migration'
import { buildEvolverTools } from '../../src/main/evolver-tools'
import type { Task } from '../../src/main/task-store'

const temporaryRoots: string[] = []

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

describe('authoritative credential read boundary', () => {
  it('hard-denies every persisted credential location through read and read_file', () => {
    const credentialTargets = [
      getOpenPipalConfigPath(),
      getOpenPipalConfigBackupPath(),
      getAcpMcpTokenPath(),
      path.join(getMcpOAuthRootPath(), 'remote-server.bin'),
      getUserMcpConfigPath(),
      getMcpAppPermissionsPath(),
      path.join(getTasksRootPath(), 'webhook-task.json'),
      getAuditLogPath(),
      getBrowserControlPolicyPath(),
      getDevelopmentEnvPath(),
      dataPath('plugins', 'literal-secrets', 'mcp.json'),
    ]

    for (const target of credentialTargets) {
      expect(classifyToolRisk('read', { path: target }).level, target).toBe('risky')
      expect(classifyToolRisk('read_file', { file_path: target }).level, target).toBe('risky')
    }

    // Other application-owned data remains available to legitimate reads.
    expect(classifyToolRisk('read', { path: dataPath('memory', 'notes.md') }).level).toBe('safe')
  })

  it('does not instruct the tool-installer skill to bypass the protected MCP config', () => {
    const skill = fs.readFileSync(
      path.resolve('resources/skills/tool-installer/SKILL.md'),
      'utf8'
    )
    expect(skill).toContain('插件 > 工具')
    expect(skill).toContain('Never')
    expect(skill).not.toContain('Write config to `~/.openpipal/mcp-servers.json`')
    expect(skill).not.toContain('read-merge-write')
  })

  it('rejects symlink aliases and default discovery scans of credential roots', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openpipal-credential-boundary-'))
    temporaryRoots.push(root)
    const alias = path.join(root, 'innocent-looking-token')
    fs.symlinkSync(getAcpMcpTokenPath(), alias)

    expect(classifyToolRisk('read', { path: alias }).level).toBe('risky')
    for (const workingDir of [dataPath(), getMcpOAuthRootPath(), getTasksRootPath()]) {
      expect(classifyToolRisk('grep', { pattern: 'secret' }, { workingDir }).level).toBe('risky')
      expect(classifyToolRisk('find', {}, { workingDir }).level).toBe('risky')
      expect(classifyToolRisk('ls', {}, { workingDir }).level).toBe('risky')
    }

    const pluginDir = dataPath('plugins', 'literal-secrets')
    expect(classifyToolRisk('grep', { pattern: 'Authorization' }, { workingDir: pluginDir }).level)
      .toBe('risky')
    expect(classifyToolRisk('read', { path: dataPath('plugins', 'literal-secrets', 'skills', 'SKILL.md') }).level)
      .toBe('safe')
    expect(classifyToolRisk('grep', { pattern: 'memory' }, {
      workingDir: dataPath('memory')
    }).level).toBe('safe')
  })

  it('blocks dotenv basenames in any allowed workspace, including relative paths', () => {
    for (const dotenvName of ['.env', '.env.local', '.ENV.production', '.env.example', '.envrc']) {
      expect(classifyToolRisk(
        'read',
        { path: dotenvName },
        { workingDir: process.cwd() }
      ).level, dotenvName).toBe('risky')
    }
  })

  it('preserves ordinary repository discovery while the worker filters nested dotenv files', () => {
    for (const tool of [
      ['grep', { pattern: 'security' }],
      ['find', { pattern: '*.ts' }],
      ['ls', {}],
    ] as const) {
      expect(classifyToolRisk(tool[0], tool[1], { workingDir: process.cwd() }).level)
        .toBe('safe')
    }
  })

  it('feeds the exact sensitive list and sandbox-only globs into denyRead', () => {
    const exactCredentials = getCredentialReadDenyPaths()
    expect(SENSITIVE_DIRS).toEqual(expect.arrayContaining(exactCredentials))

    const config = buildSandboxConfig()
    expect(config.filesystem.denyRead).toEqual(expect.arrayContaining([
      ...SENSITIVE_DIRS,
      ...SENSITIVE_READ_GLOBS,
    ]))
    expect(SENSITIVE_READ_GLOBS).toContain(path.join(getOpenPipalHome(), '**', '.env*'))
    expect(SENSITIVE_READ_GLOBS).toEqual(expect.arrayContaining([
      '/**/.[eE][nN][vV]*',
    ]))
    expect(SENSITIVE_READ_GLOBS).toContain(dataPath('plugins', '*', 'mcp.json'))
    expect(config.filesystem.allowWrite).toEqual(expect.arrayContaining(ALLOWED_DIRS))
    expect(config.filesystem.denyWrite).toEqual(expect.arrayContaining([
      ...exactCredentials,
      ...SENSITIVE_READ_GLOBS,
    ]))

    expect(buildSensitiveReadGlobs('/isolated/qa-home', '/Users/real-user', '/plugins'))
      .toEqual(expect.arrayContaining([
        '/isolated/qa-home/**/.env*',
        '/Users/real-user/**/.env*',
        '/**/.[eE][nN][vV]*',
        '/plugins/*/mcp.json',
      ]))
  })

  it.runIf(process.platform === 'darwin' && !process.env.CODEX_SANDBOX)(
    'blocks dotenv outside HOME through the real macOS sandbox while preserving normal reads',
    async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openpipal-srt-dotenv-'))
      temporaryRoots.push(root)
      const secretPath = path.join(root, 'nested', '.env.local')
      const envrcPath = path.join(root, 'nested', '.envrc')
      const publicPath = path.join(root, 'nested', 'public.txt')
      fs.mkdirSync(path.dirname(secretPath), { recursive: true })
      fs.writeFileSync(secretPath, 'SRT_SECRET_MUST_NOT_LEAK\n')
      fs.writeFileSync(envrcPath, 'SRT_ENVRC_MUST_NOT_LEAK\n')
      fs.writeFileSync(publicPath, 'SRT_PUBLIC_READ_OK\n')

      const { SandboxManager } = await import('@anthropic-ai/sandbox-runtime')
      const filesystem = buildSandboxConfig().filesystem
      const command = [
        `if cat ${shellQuote(secretPath)}; then exit 91; fi`,
        `if cat ${shellQuote(envrcPath)}; then exit 92; fi`,
        `cat ${shellQuote(publicPath)}`,
      ].join('; ')
      const wrapped = await SandboxManager.wrapWithSandbox(command, undefined, { filesystem })
      const output = execFileSync('/bin/zsh', ['-lc', wrapped], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      expect(output).toContain('SRT_PUBLIC_READ_OK')
      expect(output).not.toContain('SRT_SECRET_MUST_NOT_LEAK')
      expect(output).not.toContain('SRT_ENVRC_MUST_NOT_LEAK')
    }
  )

  it('keeps unattended internal agents behind the same hard credential boundary', async () => {
    const assignedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'openpipal-assigned-root-'))
    temporaryRoots.push(assignedRoot)
    fs.writeFileSync(path.join(assignedRoot, 'own.md'), 'own workspace')
    const siblingRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'openpipal-sibling-root-'))
    temporaryRoots.push(siblingRoot)
    fs.writeFileSync(path.join(siblingRoot, 'sibling.md'), 'other workspace')
    const escapeLink = path.join(assignedRoot, 'innocent-link')
    fs.symlinkSync(path.join(siblingRoot, 'sibling.md'), escapeLink)

    const hook = createHardBoundaryHook({ workingDir: assignedRoot, assignedRoot })
    await expect(hook({
      toolCall: { name: 'read' },
      args: { path: getTasksRootPath() }
    } as any)).resolves.toMatchObject({ block: true })
    await expect(hook({
      toolCall: { name: 'read' },
      args: { path: 'own.md' }
    } as any)).resolves.toBeUndefined()
    await expect(hook({
      toolCall: { name: 'write' },
      args: { path: 'new.md', content: 'safe' }
    } as any)).resolves.toBeUndefined()
    for (const blockedPath of [
      path.join(siblingRoot, 'sibling.md'),
      path.join(os.homedir(), 'Documents', 'outside-assignment.md'),
      escapeLink,
    ]) {
      await expect(hook({
        toolCall: { name: 'read' },
        args: { path: blockedPath }
      } as any), blockedPath).resolves.toMatchObject({ block: true })
    }

    const memoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'openpipal-memory-assignment-'))
    temporaryRoots.push(memoryRoot)
    fs.mkdirSync(path.join(memoryRoot, 'global'), { recursive: true })
    fs.mkdirSync(path.join(memoryRoot, 'conversations', 'conv-1'), { recursive: true })
    const memoryHook = createHardBoundaryHook({ workingDir: memoryRoot, assignedRoot: memoryRoot })
    for (const allowedPath of ['global/MEMORY.md', 'conversations/conv-1/note.md']) {
      await expect(memoryHook({
        toolCall: { name: 'write' },
        args: { path: allowedPath, content: 'safe' }
      } as any), allowedPath).resolves.toBeUndefined()
    }
    await expect(memoryHook({
      toolCall: { name: 'write' },
      args: { path: '../agents/sibling/agent.md', content: 'blocked' }
    } as any)).resolves.toMatchObject({ block: true })
    await expect(memoryHook({
      toolCall: { name: 'write' },
      args: { path: '../browser-control.json', content: '{"allow":true}' }
    } as any)).resolves.toMatchObject({ block: true })
    expect(canonicalizeSecurityPath(escapeLink)).toBe(
      canonicalizeSecurityPath(path.join(siblingRoot, 'sibling.md'))
    )
  })

  it('does not expose a raw shell to Evolver and uses credential-filtered discovery', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'openpipal-evolver-tools-'))
    temporaryRoots.push(cwd)
    fs.writeFileSync(path.join(cwd, '.env.local'), 'EVOLVER_SECRET=MUST_NOT_LEAK\n')
    fs.writeFileSync(path.join(cwd, 'visible.md'), 'safe evolver marker\n')

    const tools = buildEvolverTools(cwd)
    expect(tools.map(tool => tool.name)).toEqual(expect.arrayContaining([
      'read', 'edit', 'write', 'grep', 'find', 'ls'
    ]))
    expect(tools.some(tool => tool.name === 'bash')).toBe(false)

    const grep = tools.find(tool => tool.name === 'grep')!
    const result = await grep.execute(
      'evolver-credential-search',
      { pattern: 'MUST_NOT_LEAK|safe evolver marker', path: '.' },
      undefined,
      undefined
    )
    const output = result.content
      .filter(part => part.type === 'text')
      .map(part => part.text)
      .join('')
    expect(output).toContain('safe evolver marker')
    expect(output).not.toContain('MUST_NOT_LEAK')
    expect(output).not.toContain('.env.local')

    const source = fs.readFileSync(path.resolve('src/main/evolver-agent.ts'), 'utf8')
    expect(source).toContain('buildEvolverTools(cwd, taskCandidates)')
    expect(source).toContain('beforeToolCall: createHardBoundaryHook({')
    expect(source).toContain('assignedRoot: scope.assignedRoot')
    expect(source).toContain('const agentMd = bundledAgentMd ||')
    expect(source).toContain('# Authoritative Runtime Boundary')
    expect(source).not.toContain('Tasks directory:')
  })

  it('migrates only preselected tasks without returning webhook secrets to the model', async () => {
    const secret = 'webhook-secret-must-stay-in-main'
    const task: Task = {
      id: 'candidate-1',
      name: 'Webhook task',
      enabled: true,
      trigger: { type: 'webhook', secret },
      prompt: 'run safely',
      conversationMode: 'per-run',
      boundConversationId: 'conversation-current',
      createdAt: 1,
      updatedAt: 1,
    }
    let update: Partial<Task> | undefined
    let created: Omit<Task, 'id' | 'createdAt' | 'updatedAt'> | undefined
    const store: EvolverTaskMigrationStore = {
      getTask: id => id === task.id ? task : null,
      updateTask: (_id, updates) => {
        update = updates
        return { ...task, ...updates, updatedAt: 2 }
      },
      createTask: data => {
        created = data
        return { ...data, id: 'copy-1', createdAt: 2, updatedAt: 2 }
      }
    }
    const tool = createEvolverTaskMigrationTool([
      {
        id: task.id,
        name: task.name,
        createdAt: task.createdAt,
        boundConversationId: 'conversation-current',
      }
    ], 'agent-new', store)

    const migrated = await tool.execute(
      'migrate-task',
      { taskId: task.id, action: 'migrate' },
      undefined,
      undefined
    )
    expect(update).toEqual({ workspaceId: 'agent-new', agentId: undefined })
    expect(JSON.stringify(migrated)).not.toContain(secret)

    const copied = await tool.execute(
      'copy-task',
      { taskId: task.id, action: 'copy' },
      undefined,
      undefined
    )
    expect(created?.trigger).toEqual({ type: 'webhook', secret })
    expect(created?.workspaceId).toBe('agent-new')
    expect(JSON.stringify(copied)).not.toContain(secret)

    const rejected = await tool.execute(
      'migrate-unselected',
      { taskId: 'attacker-selected-id', action: 'migrate' },
      undefined,
      undefined
    )
    expect(JSON.stringify(rejected)).not.toContain(secret)
    expect(rejected.details).toMatchObject({ isError: true })
  })

  it('creates, repairs, and appends audit.log through a 0600 no-follow descriptor', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openpipal-audit-mode-'))
    temporaryRoots.push(root)
    const auditPath = path.join(root, 'nested', 'audit.log')
    fs.mkdirSync(path.dirname(auditPath), { recursive: true })
    fs.writeFileSync(auditPath, 'existing audit history\n', { mode: 0o644 })
    fs.chmodSync(auditPath, 0o644)

    // This is the production startup seam: an upgraded 0644 log is repaired
    // before the first new tool call, while preserving its existing history.
    expect(initializeSecurityStorage(auditPath)).toBe(true)
    expect(fs.readFileSync(auditPath, 'utf8')).toBe('existing audit history\n')
    expect(fs.statSync(auditPath).mode & 0o077).toBe(0)
    expect(await appendPrivateAuditLogLine(auditPath, 'new audit line\n')).toBe(true)
    expect(fs.readFileSync(auditPath, 'utf8')).toBe('existing audit history\nnew audit line\n')
    expect(fs.statSync(auditPath).mode & 0o077).toBe(0)

    const newAuditPath = path.join(root, 'new', 'audit.log')
    expect(ensurePrivateAuditLogFile(newAuditPath)).toBe(true)
    expect(fs.statSync(newAuditPath).mode & 0o077).toBe(0)

    if (fs.constants.O_NOFOLLOW) {
      const outside = path.join(root, 'outside.log')
      const link = path.join(root, 'audit-link.log')
      fs.writeFileSync(outside, 'must remain unchanged\n')
      fs.symlinkSync(outside, link)
      expect(await appendPrivateAuditLogLine(link, 'must not be written\n')).toBe(false)
      expect(fs.readFileSync(outside, 'utf8')).toBe('must remain unchanged\n')
    }
  })
})
