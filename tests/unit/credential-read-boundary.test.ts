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
  buildEnvTemplateReadAllowGlobs,
  buildGitDotenvExcludeBody,
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
  registerWorkspaceRoot,
  resetWorkspaceRoots,
  ensurePrivateAuditLogFile,
  initializeSecurityStorage,
} from '../../src/main/pi-security'
import { buildSandboxConfig, getGitDotenvExcludesFile } from '../../src/main/sandbox-manager'
import { buildGitDotenvExcludeEnv } from '../../src/main/openpipal-execution-env'
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
    for (const dotenvName of ['.env', '.env.local', '.ENV.production', '.envrc']) {
      expect(classifyToolRisk(
        'read',
        { path: dotenvName },
        { workingDir: process.cwd() }
      ).level, dotenvName).toBe('risky')
    }
  })

  /**
   * 2026-08-28 **刻意放宽**：`.env.example` 原本也在上面那张拒读表里（这条断言是从那里
   * 拆出来的，不是新写的）。改它的理由不是"实现起来麻烦"，是那条宽 `.env*` 拦错了东西：
   *
   * - **代价量过**：影子运行 60 次里 19 次（32%）撞上 `.env.example` 的 `Operation not permitted`，
   *   横跨 10 道题。挡住的不是读密钥，是 `git stash` / `git status` / `git checkout`——
   *   git 要把工作树打成 tree 就得读每个被跟踪的文件。实案 `6919551@r1` 想回基线做对照，
   *   卡在「stash 尝试因 `.env.example` 权限问题未执行任何回退」。
   * - **拦住的安全收益很浅**：这些模板本来就提交在版本库里，助手照样能
   *   `git show HEAD:.env.example` 读到内容（`.git` 不在读拒表里）。
   *
   * 放宽的边界写死在这里，别再扩：只认四个通用模板名、只认小写、**只放读不放写**。
   */
  it('lets the agent read committed dotenv templates, but nothing that looks like a real secret', () => {
    for (const template of ['.env.example', '.env.sample', '.env.template', '.env.dist']) {
      expect(classifyToolRisk(
        'read',
        { path: template },
        { workingDir: process.cwd() }
      ).level, template).toBe('safe')
    }
    // 没见过的写法一律按最严的算：大写变体、以及"看着像模板其实不是"的名字
    for (const notATemplate of ['.ENV.EXAMPLE', '.env.example.local', '.env.examples', '.env.test']) {
      expect(classifyToolRisk(
        'read',
        { path: notATemplate },
        { workingDir: process.cwd() }
      ).level, notATemplate).toBe('risky')
    }
  })

  /**
   * 放宽的只有**读**。第一版漏了这道门：`classifySensitivePath` 是读写共用的总闸，模板一旦被判成
   * 「不敏感」就会一路落到 `WRITE_FILE_TOOLS` 分支，而那里 `isSandboxed()` 为真时直接返回
   * `safe` —— 装机版里助手能**静默覆写**别人仓库已提交的 `.env.example`。
   * 只跑单测看不出来（dev 下沙箱关着，落到 `needs_confirmation`），是评审逮到的。
   */
  it('never widens write access to dotenv templates, only read', () => {
    const wd = process.cwd()
    for (const template of ['.env.example', '.env.sample', '.env.template', '.env.dist']) {
      expect(classifyToolRisk('read', { path: template }, { workingDir: wd }).level, template).toBe('safe')
      expect(classifyToolRisk('write', { path: template, content: 'x' }, { workingDir: wd }).level,
        `${template} 不该可写`).toBe('risky')
      expect(classifyToolRisk('edit', { path: template, old_string: 'a', new_string: 'b' }, { workingDir: wd }).level,
        `${template} 不该可编辑`).toBe('risky')
    }
    // 真密钥读写都拦死，一个字没松
    for (const tool of [['read', {}], ['write', { content: 'x' }], ['edit', { old_string: 'a', new_string: 'b' }]] as const) {
      expect(classifyToolRisk(tool[0], { path: '.env', ...tool[1] }, { workingDir: wd }).level, tool[0]).toBe('risky')
    }
  })

  it('re-allows templates at the OS sandbox layer without touching the deny rules', () => {
    // SRT 语义：allowRead 压过 denyRead，denyWrite 压过 allowWrite。
    // 所以读能放回来、写放不回来——这正是我们要的形状。
    // **必须限定在工作目录内**：allowRead 压过 denyRead，不限范围就会连
    // SENSITIVE_DIRS（~/.ssh、~/.aws…）和 ~/.openpipal 下的凭据一起打穿。
    expect(buildEnvTemplateReadAllowGlobs(['/tmp/repo'])).toEqual([
      '/tmp/repo/**/.env.example', '/tmp/repo/**/.env.sample',
      '/tmp/repo/**/.env.template', '/tmp/repo/**/.env.dist'
    ])
    // 没登记工作目录就一条都不放行（fail-closed）
    expect(buildEnvTemplateReadAllowGlobs([])).toEqual([])
    // 任何一条都不许是从根开始的通配
    for (const g of buildEnvTemplateReadAllowGlobs(['/tmp/repo'])) {
      expect(g.startsWith('/**/'), `${g} 是全盘通配，会打穿敏感目录`).toBe(false)
    }
    // 宽拒读规则一个字都没动
    expect(SENSITIVE_READ_GLOBS).toContain('/**/.[eE][nN][vV]*')
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

/**
 * 沙箱下 git 的 dotenv 排除清单。
 *
 * 立案的那句原话（生产配置、真沙箱实测）：
 *   `error: lstat(".env"): Operation not permitted`
 * 病灶不是"读密钥"，是**遍历**——SRT 把 denyRead 翻成 `(deny file-read* …)`，
 * 而 `file-read*` 连 metadata 一起拒，于是 git 连 lstat 都发不出去，整条命令挂掉。
 *
 * 2026-08-28 三方案五形态对照（每格 9 条 git 命令，都走 SRT 自己的 wrapWithSandbox）：
 *   - dotenv 已被 gitignore（正确做法，最常见）：**今天就是全绿的**，三个方案都不用管；
 *   - dotenv 未被忽略也未被 track：`git stash -u` / `git add -A .` 挂 → 这份清单修好，
 *     而"往沙箱 profile 里插一条 file-read-metadata 放行"那个方案**一条都修不了**；
 *   - dotenv 已被提交进版本库：三个方案都修不好 stash，而且那种仓库里
 *     `git show HEAD:<dotenv>` 本来就能读出密钥——不是这层该解决的问题（见 mechanism-registry.md）。
 * 那个 metadata 方案还在"刚 clone 出来"的仓库里把 `git diff/add/commit` 从通过弄成失败，
 * 所以没有采纳。这一版**沙箱规则一个字没动**。
 */
describe('git dotenv 排除清单', () => {
  const DOT = '.' + 'env'

  it('只藏 git 真读不到的那些，模板逐条放回来', () => {
    const body = buildGitDotenvExcludeBody()
    expect(body).toContain(`\n${DOT}\n`)
    expect(body).toContain(`\n${DOT}.*\n`)
    for (const template of ['.example', '.sample', '.template', '.dist']) {
      expect(body, `${DOT}${template} 是读得到的，排掉会让它对 git add 隐身`)
        .toContain(`\n!${DOT}${template}\n`)
    }
  })

  it('按 GIT_CONFIG_COUNT 顺延写位，用户自己设过就不插手', () => {
    // 空环境：占 0 号位
    expect(buildGitDotenvExcludeEnv('/x/ignore')).toEqual({
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'core.excludesFile',
      GIT_CONFIG_VALUE_0: '/x/ignore'
    })
    // 已有两条：接着写 2 号位，不覆盖前面的
    expect(buildGitDotenvExcludeEnv('/x/ignore', {
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: 'user.useConfigOnly',
      GIT_CONFIG_KEY_1: 'credential.helper'
    })).toMatchObject({ GIT_CONFIG_COUNT: '3', GIT_CONFIG_KEY_2: 'core.excludesFile' })
    // 用户自己设过 core.excludesFile：完全让路
    expect(buildGitDotenvExcludeEnv('/x/ignore', {
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'core.excludesFile',
      GIT_CONFIG_VALUE_0: '/user/own'
    })).toEqual({})
  })

  it('把用户自己的全局 ignore 一并带上——core.excludesFile 是整体替换，不叠加', () => {
    const content = fs.readFileSync(getGitDotenvExcludesFile(), 'utf8')
    expect(content.endsWith(buildGitDotenvExcludeBody())).toBe(true)
    const userGlobal = path.join(
      process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'git', 'ignore'
    )
    if (fs.existsSync(userGlobal)) {
      expect(content.startsWith(fs.readFileSync(userGlobal, 'utf8').trimEnd())).toBe(true)
    }
  })

  it.runIf(process.platform === 'darwin' && !process.env.CODEX_SANDBOX)(
    '真沙箱：未被忽略的 dotenv 不再让 git add / git stash -u 整条挂掉，密钥照旧读不到',
    async () => {
      // **必须建在 /tmp 下**：macOS 的 os.tmpdir() 是 /var/folders/…，realpath 落进
      // /private/var，而 assessWorkspaceRoot 把 /private/var 整棵树排除在工作根之外——
      // 建在那里的仓库根本登记不进沙箱，量到的是"没有工作根"而不是"这个改动有没有用"。
      const repo = fs.realpathSync(fs.mkdtempSync(path.join('/tmp', 'openpipal-dotenv-git-')))
      temporaryRoots.push(repo)
      const secretFile = path.join(repo, DOT)
      const secret = 'SRT_GIT_SECRET_MUST_NOT_LEAK'
      fs.mkdirSync(path.join(repo, 'src'), { recursive: true })
      fs.writeFileSync(path.join(repo, 'src', 'a.js'), 'export const a = 1\n')
      fs.writeFileSync(path.join(repo, `${DOT}.example`), 'API_KEY=your-key-here\n')
      fs.writeFileSync(secretFile, `API_KEY=${secret}\n`)
      const git = (args: string[]): void => {
        execFileSync('git', ['-c', 'user.email=p@p', '-c', 'user.name=p', ...args], { cwd: repo, stdio: 'ignore' })
      }
      git(['init', '-q', '.'])
      git(['add', 'src', `${DOT}.example`])        // 真密钥文件既没被忽略，也没被 track
      git(['commit', '-qm', 'base'])
      fs.appendFileSync(path.join(repo, 'src', 'a.js'), 'export const b = 2\n')

      resetWorkspaceRoots()
      expect(registerWorkspaceRoot(repo), '临时仓库没能登记成工作根').toBeTruthy()
      const filesystem = buildSandboxConfig().filesystem
      const { SandboxManager } = await import('@anthropic-ai/sandbox-runtime')
      const run = async (command: string, withExcludes: boolean): Promise<number> => {
        const prefix = withExcludes
          ? Object.entries(buildGitDotenvExcludeEnv(getGitDotenvExcludesFile()))
            .map(([k, v]) => `${k}=${shellQuote(String(v))}`).join(' ') + ' '
          : ''
        const wrapped = await SandboxManager.wrapWithSandbox(
          `cd ${shellQuote(repo)} && ${prefix}${command}`, undefined, { filesystem }
        )
        try {
          execFileSync('/bin/zsh', ['-lc', wrapped], { stdio: ['ignore', 'pipe', 'pipe'] })
          return 0
        } catch (error: any) {
          return error.status ?? -1
        }
      }

      // 改动前后各量一次：不对照就分不清"本来就绿"和"被修好了"
      expect(await run('git add -A .', false), '前提没成立：这条本来就该挂').not.toBe(0)
      expect(await run('git stash -u', false), '前提没成立：这条本来就该挂').not.toBe(0)
      expect(await run('git add -A .', true), 'git add 仍然挂着').toBe(0)
      expect(await run('git stash -u', true), 'git stash -u 仍然挂着').toBe(0)
      execFileSync('git', ['stash', 'pop'], { cwd: repo, stdio: 'ignore' })

      // 放行的是遍历，不是内容：密钥照旧读不到，文件一个字节没变
      expect(await run(`cat ${DOT}`, true), '密钥被读出来了').not.toBe(0)
      expect(fs.readFileSync(secretFile, 'utf8')).toBe(`API_KEY=${secret}\n`)
      // 也没被顺手提交进去——git 读不到内容，本来也提交不了
      expect(execFileSync('git', ['ls-files'], { cwd: repo, encoding: 'utf8' }))
        .not.toContain(`${DOT}\n`)
    },
    // 五次 sandbox-exec + 真 git：单跑约 2.2s，但整套并行时会挤过默认的 5s
    120_000
  )
})
