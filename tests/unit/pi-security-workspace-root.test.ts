/**
 * 工作目录闸门（Phase 0）
 *
 * 回归的是这条实案：ALLOWED_DIRS 是编译期常量，只有 ~/Documents|Desktop|Downloads、
 * /tmp 和数据根。仓库住在 ~/code、~/work、/Volumes/… 时，read/write/edit/ls/find/grep
 * 六个结构化工具一律判 risky，而 risky 在 authorizeToolCall 里是硬拒——没有确认弹窗、
 * 没有会话放行、没有 env 逃生舱；目录选择器又不校验，症状是"选完了，一动手全拒且无声"。
 *
 * 修法是让用户显式选定的那个目录成为允许根，但**只放宽这一条**：过宽的根（家目录、
 * /Users、根目录）不算，Layer 3 的敏感/系统路径检查一步不让。下面每个 it 各钉一条边界。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ALLOWED_DIRS,
  assessWorkspaceRoot,
  authorizeToolCall,
  classifyToolRisk,
  invalidateWorkspaceRootCache,
  listWorkspaceRoots,
  registerWorkspaceRoot,
  replaceGlobalWorkspaceRoot,
  resetWorkspaceRoots
} from '../../src/main/pi-security'
import { buildSandboxConfig } from '../../src/main/sandbox-manager'

const HOME = os.homedir()

/**
 * 造一个既不在 ALLOWED_DIRS 也不在 /tmp 下的真实"项目目录"——那正是本次要放行的形态。
 * 注意要建成 `~/.op-…/repo` 两层：家目录下的单层点目录本身被判为工具私产（isBareHomeDotDir），
 * 直接拿 mkdtemp 出来的那一层当工作根会被正确拒绝，测不到我们想测的东西。
 */
const created: string[] = []
function repo(): string {
  const holder = fs.mkdtempSync(path.join(HOME, '.op-workspace-root-test-'))
  created.push(holder)
  const dir = path.join(holder, 'repo')
  fs.mkdirSync(dir)
  return dir
}

afterEach(() => {
  while (created.length) {
    fs.rmSync(created.pop()!, { recursive: true, force: true })
  }
  resetWorkspaceRoots()
  invalidateWorkspaceRootCache()
})

const STRUCTURED_TOOLS: Array<[string, (p: string) => any]> = [
  ['read', p => ({ path: p })],
  ['write', p => ({ path: p, content: 'x' })],
  ['edit', p => ({ path: p, edits: [{ oldText: 'a', newText: 'b' }] })],
  ['ls', p => ({ path: p })],
  ['find', p => ({ path: p, pattern: '*.ts' })],
  ['grep', p => ({ path: p, pattern: 'export' })]
]

describe('工作目录作为允许根', () => {
  it('ALLOWED_DIRS 之外的仓库：六个结构化工具都不再被硬拒', () => {
    const root = repo()
    // 前提自检：这个目录确实不在编译期白名单里，否则这条测试什么都没证明
    expect(ALLOWED_DIRS.some(d => root === d || root.startsWith(d + path.sep))).toBe(false)

    const target = path.join(root, 'src', 'index.ts')
    for (const [tool, args] of STRUCTURED_TOOLS) {
      const assessment = classifyToolRisk(tool, args(target), { workingDir: root })
      expect(assessment.level, `${tool} 应当不再硬拒`).not.toBe('risky')
    }
  })

  it('放行只覆盖工作目录本身：目录外的路径照旧硬拒，理由带上当前工作目录', () => {
    const root = repo()
    const outside = repo()
    const assessment = classifyToolRisk(
      'read',
      { path: path.join(outside, 'secret.ts') },
      { workingDir: root }
    )
    expect(assessment.level).toBe('risky')
    // 理由要能让模型自己纠偏，而不是降级去 bash cat 硬读
    expect(assessment.reason).toContain(root)
  })

  it('过宽的根不算允许根：家目录 / 根目录都不放行', () => {
    for (const broad of [HOME, path.parse(HOME).root, path.dirname(HOME)]) {
      expect(assessWorkspaceRoot(broad).ok, `${broad} 不该被接受`).toBe(false)
      expect(assessWorkspaceRoot(broad).code).toBe('too_broad')
    }
    // 家目录当工作目录时，家目录下的任意文件仍然进不去
    const stray = path.join(HOME, '.op-not-a-workspace-file')
    expect(classifyToolRisk('read', { path: stray }, { workingDir: HOME }).level).toBe('risky')
  })

  it('大小写变体不能绕过任何一道判定（macOS 默认 APFS 不区分大小写）', () => {
    // 对抗式审查实案：resolveRealPath 原本用 JS 版 realpathSync，只跟符号链接、
    // 大小写原样返回。于是 ~/.SSH 与 /Users/<USER 大写> 都逃过了敏感/过宽判定，
    // 整个家目录（含 .ssh/.aws/Library/Keychains）对六个文件工具变成 safe。
    const upperHome = HOME.replace(/[^/]+$/, m => m.toUpperCase())
    expect(assessWorkspaceRoot(upperHome).ok, `${upperHome} 必须与家目录同判`).toBe(false)
    expect(assessWorkspaceRoot(upperHome).code).toBe('too_broad')

    const upperSsh = path.join(HOME, '.SSH')
    if (fs.existsSync(path.join(HOME, '.ssh'))) {
      expect(assessWorkspaceRoot(upperSsh).ok, '~/.SSH 必须与 ~/.ssh 同判').toBe(false)
    }
    // 分类器侧：大小写变体的家目录不能让家目录下的东西变 safe
    expect(
      classifyToolRisk('read', { path: path.join(upperHome, 'Library', 'Keychains', 'x') }, { workingDir: upperHome }).level
    ).toBe('risky')
  })

  it('配置树 / 可执行体 / 别人的家目录都不算项目目录', () => {
    const denied = [
      path.join(HOME, 'Library'),
      path.join(HOME, 'Library', 'LaunchAgents'),
      path.join(HOME, 'Library', 'Application Support'),
      path.join(HOME, '.config'),
      path.join(HOME, '.claude'),   // 单层点目录：工具私产，不是项目
      '/Applications',
      '/opt',
      '/Library',
      path.join(path.dirname(HOME), 'someone-else')
    ]
    for (const d of denied) {
      const v = assessWorkspaceRoot(d)
      expect(v.ok, `${d} 不该被接受为工作根`).toBe(false)
    }
    // 但我们自己的默认工作区在点目录**之下**，必须继续可用
    expect(assessWorkspaceRoot(path.join(HOME, '.openpipal', 'workspace')).ok).toBe(true)
    expect(assessWorkspaceRoot(path.join(HOME, 'Documents')).ok).toBe(true)
  })

  it('失败不进缓存：目录后来变可用了要能认出来（外置盘挂载）', () => {
    const parent = repo()
    const late = path.join(parent, 'mounted-later')
    expect(registerWorkspaceRoot(late)).toBeNull()   // 还不存在
    fs.mkdirSync(late, { recursive: true })
    // 缓存住失败的话这里会继续返回 null，本进程再也认不出这个目录
    expect(registerWorkspaceRoot(late)).toBe(fs.realpathSync(late))
  })

  it('Layer 3 不因工作目录放宽：工作目录里的凭证与系统路径照旧硬拒', () => {
    const root = repo()
    fs.mkdirSync(path.join(root, '.ssh'), { recursive: true })
    fs.writeFileSync(path.join(root, '.env'), 'SECRET=1')

    // 仓库自带的 .env 走 basename 判定（classifySensitivePath 对 .env* 一律拒）
    expect(classifyToolRisk('read', { path: path.join(root, '.env') }, { workingDir: root }).level)
      .toBe('risky')
    // 家目录下的真凭证目录不因为换了工作目录而开门
    expect(classifyToolRisk('read', { path: path.join(HOME, '.ssh', 'id_rsa') }, { workingDir: root }).level)
      .toBe('risky')
    // 系统目录仍然是硬边界
    expect(classifyToolRisk('write', { path: '/etc/hosts', content: 'x' }, { workingDir: root }).level)
      .toBe('risky')
  })

  it('不存在 / 不是目录的工作目录不被接受', () => {
    const root = repo()
    const missing = path.join(root, 'nope')
    expect(assessWorkspaceRoot(missing).code).toBe('not_found')

    const file = path.join(root, 'a-file.txt')
    fs.writeFileSync(file, 'x')
    expect(assessWorkspaceRoot(file).code).toBe('not_dir')

    expect(assessWorkspaceRoot('').code).toBe('empty')
    expect(assessWorkspaceRoot(undefined).code).toBe('empty')
  })

  it('换目录后记忆要失效，否则旧判定会跟着新目录走', () => {
    const root = repo()
    const target = path.join(root, 'a.ts')
    expect(classifyToolRisk('read', { path: target }, { workingDir: root }).level).not.toBe('risky')

    fs.rmSync(root, { recursive: true, force: true })
    created.splice(created.indexOf(root), 1)
    invalidateWorkspaceRootCache()
    // 目录没了就不再是合法允许根，也就退回 ALLOWED_DIRS 那张表
    expect(classifyToolRisk('read', { path: target }, { workingDir: root }).level).toBe('risky')
  })
})

describe('沙箱写范围', () => {
  it("allowWrite 不再出现 '.'——它按 process.cwd() 解析，装机版会展开成整盘可写", () => {
    const config = buildSandboxConfig()
    expect(config.filesystem.allowWrite).not.toContain('.')
    for (const entry of config.filesystem.allowWrite || []) {
      expect(path.isAbsolute(entry), `allowWrite 条目必须是绝对路径：${entry}`).toBe(true)
    }
  })

  it('登记过的工作根进 allowWrite；不合格的根不进', () => {
    const root = repo()
    expect(registerWorkspaceRoot(root)).toBeTruthy()
    expect(listWorkspaceRoots()).toContain(fs.realpathSync(root))
    expect(buildSandboxConfig().filesystem.allowWrite).toContain(fs.realpathSync(root))

    expect(registerWorkspaceRoot(HOME)).toBeNull()
    expect(buildSandboxConfig().filesystem.allowWrite).not.toContain(HOME)
  })

  it('走授权链路（现役 pi-core 的入口）就会把工作根登记进去', async () => {
    const root = repo()
    expect(listWorkspaceRoots()).not.toContain(fs.realpathSync(root))

    // pi-core 主循环不经过 createSecurityHook，它自己 new PiCoreToolAuthorizer 后
    // 直接调 authorizeToolCall——登记必须挂在这一层，挂在包装层等于静默落空。
    const controller = new AbortController()
    await authorizeToolCall(
      'read',
      { path: path.join(root, 'a.ts') },
      { scope: { workingDir: root } },
      controller.signal
    )
    expect(listWorkspaceRoots()).toContain(fs.realpathSync(root))
  })

  it('换全局工作目录会整表重置——旧根留着等于对 bash 一直可写', () => {
    const a = repo()
    const b = repo()
    expect(registerWorkspaceRoot(a)).toBeTruthy()
    expect(listWorkspaceRoots()).toContain(fs.realpathSync(a))

    replaceGlobalWorkspaceRoot(b)
    expect(listWorkspaceRoots()).toEqual([fs.realpathSync(b)])
    // bash 分支不做路径判定，OS 沙箱是它唯一的写边界——旧根必须从 allowWrite 里消失
    expect(buildSandboxConfig().filesystem.allowWrite).not.toContain(fs.realpathSync(a))
  })

  it('工具链缓存目录要可写，否则 npm install 一上来就 EPERM', () => {
    const allowWrite = buildSandboxConfig().filesystem.allowWrite || []
    for (const cache of ['.npm', '.cache', path.join('Library', 'Caches')]) {
      expect(allowWrite, `${cache} 应当可写`).toContain(path.join(HOME, cache))
    }
  })

  it('git hooks 的禁写规则用绝对 glob——相对写法在装机版会打成 /.git/hooks', () => {
    const denyWrite = buildSandboxConfig().filesystem.denyWrite || []
    expect(denyWrite).not.toContain('.git/hooks')
    // 不能以 '/**' 收尾：SRT 的 stripWriteGlobs 会剥掉它，结果只 deny 了目录本身，
    // 钩子文件照样能写——那正是这条规则要挡的东西。
    expect(denyWrite.some(p => p.endsWith('/.git/hooks/*'))).toBe(true)
    expect(denyWrite.some(p => p.endsWith('/.git/hooks/**'))).toBe(false)
    for (const entry of denyWrite) {
      expect(path.isAbsolute(entry), `denyWrite 条目必须是绝对路径或绝对 glob：${entry}`).toBe(true)
    }
  })
})

describe('git 凭证路径必须是硬边界', () => {
  // 2026-08-21 复核实案：~/.git-credentials 与 ~/.config/gh 既不在 SENSITIVE_DIRS 也不在
  // 沙箱 denyRead，模型一条 `cat ~/.git-credentials` 就能拿走用户已有的 git 凭证。
  // 「按项目授权再放行凭证」的设计必须建在这道门之后，否则一开始就绕得过去。
  const credentialPaths = [
    path.join(HOME, '.git-credentials'),
    path.join(HOME, '.config', 'git', 'credentials'),
    path.join(HOME, '.config', 'gh', 'hosts.yml'),
    path.join(HOME, '.config', 'hub'),
  ]

  it('结构化读工具一律硬拒，且不因工作目录放宽', () => {
    const root = repo()
    for (const p of credentialPaths) {
      expect(classifyToolRisk('read', { path: p }).level, p).toBe('risky')
      // 就算把工作目录设在别处，凭证仍然是 Layer 3 硬边界
      expect(classifyToolRisk('read', { path: p }, { workingDir: root }).level, p).toBe('risky')
    }
  })

  it('大小写变体同样拒绝（macOS 默认不区分大小写）', () => {
    expect(classifyToolRisk('read', { path: path.join(HOME, '.GIT-CREDENTIALS') }).level).toBe('risky')
  })

  it('沙箱 denyRead 覆盖到同一批路径', () => {
    const denyRead = buildSandboxConfig().filesystem.denyRead || []
    for (const p of [path.join(HOME, '.git-credentials'), path.join(HOME, '.config', 'gh')]) {
      expect(denyRead, `${p} 应在 denyRead 里`).toContain(p)
    }
  })
})
