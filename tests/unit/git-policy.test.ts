/**
 * Phase 5 —— git 凭据的项目轴授权。
 *
 * 这一层守的是一个真实的洞（2026-08-23 实测）：沙箱里钥匙串 helper 是通的，
 * 而 `git push origin main` 不在破坏性命令表里、沙箱下判 safe——门加上之前，
 * 模型可以拿用户已存的凭据直接推代码，一次都不问。
 *
 * 持久授权文件走 OPENPIPAL_ISOLATED_HOME 隔离，绝不写用户真实 home。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const ISOLATED_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'openpipal-git-policy-'))
process.env.OPENPIPAL_ISOLATED_HOME = ISOLATED_HOME

const { decideGitAccess, detectGitRemoteUse } = await import('../../src/main/git-policy')
const store = await import('../../src/main/git-policy-store')
const { sanitizeEnvironment, pickGitCredentialEnv } = await import('../../src/main/sandbox-manager')
const { getCredentialReadDenyPaths, getGitPolicyPath } = await import('../../src/main/credential-paths')

const read = (p: string): string => fs.readFileSync(p, 'utf8')

describe('detectGitRemoteUse —— 哪些命令会用到用户的 git 凭据', () => {
  it.each([
    ['git push', 'git push origin main'],
    ['git pull', 'git pull --rebase'],
    ['git fetch', 'git fetch --all'],
    ['git clone', 'git clone https://github.com/x/y.git'],
    ['git ls-remote', 'git ls-remote --heads origin'],
  ])('认得出 %s', (label, command) => {
    expect(detectGitRemoteUse(command)?.label).toBe(label)
  })

  it('全局选项吃掉一个词也不能漏认 —— git -C /repo push 里 /repo 不是子命令', () => {
    expect(detectGitRemoteUse('git -C /Users/x/repo push')?.label).toBe('git push')
    expect(detectGitRemoteUse('git -c user.name=x push')?.label).toBe('git push')
    expect(detectGitRemoteUse('git --git-dir /r/.git fetch')?.label).toBe('git fetch')
    // `=` 形式自带值，不该再吃掉下一个词
    expect(detectGitRemoteUse('git --git-dir=/r/.git fetch')?.label).toBe('git fetch')
  })

  it('拼接命令里的 git 一样要看见 —— 认漏就是凭据静默可用', () => {
    expect(detectGitRemoteUse('ls -la && git push')?.label).toBe('git push')
    expect(detectGitRemoteUse('npm test; git push origin main')?.label).toBe('git push')
    expect(detectGitRemoteUse('echo hi | git push')?.label).toBe('git push')
    expect(detectGitRemoteUse('GIT_TRACE=1 git fetch')?.label).toBe('git fetch')
    expect(detectGitRemoteUse('/usr/bin/git push')?.label).toBe('git push')
  })

  it('本地 git 命令不问 —— 天天跑的都弹框会把用户训练成闭眼点允许', () => {
    for (const command of [
      'git status', 'git log --oneline -5', 'git diff HEAD', 'git add -A',
      'git commit -m "x"', 'git branch -a', 'git remote -v', 'git remote add origin https://x',
      'git stash', 'git rebase -i HEAD~3', 'git submodule status'
    ]) {
      expect(detectGitRemoteUse(command), command).toBeNull()
    }
  })

  it('要看第二个词才知道联不联网的那几条', () => {
    expect(detectGitRemoteUse('git remote update')?.label).toBe('git remote update')
    expect(detectGitRemoteUse('git submodule update --init')?.label).toBe('git submodule update')
    expect(detectGitRemoteUse('git archive --remote=ssh://x HEAD')?.label).toBe('git archive --remote')
  })

  it('gh / hub / glab 本身就是拿着 token 说话，任何子命令都算', () => {
    expect(detectGitRemoteUse('gh pr create --fill')?.label).toBe('gh pr')
    expect(detectGitRemoteUse('gh auth status')?.label).toBe('gh auth')
    expect(detectGitRemoteUse('hub browse')?.label).toBe('hub browse')
  })

  it('不因为命令里出现 git 这三个字母就算', () => {
    expect(detectGitRemoteUse('echo "how to git push"')).toBeNull()
    expect(detectGitRemoteUse('cat github-notes.md')).toBeNull()
    expect(detectGitRemoteUse('')).toBeNull()
  })
})

describe('decideGitAccess —— 用户定的三档语义', () => {
  it('只读档一律不放行', () => {
    expect(decideGitAccess('readonly', { granted: false })).toBe('deny')
    expect(decideGitAccess('readonly', { granted: true })).toBe('deny')
  })

  it('自动审核档：授权过就放行，没授权就问一次', () => {
    expect(decideGitAccess('auto', { granted: false })).toBe('ask')
    expect(decideGitAccess('auto', { granted: true })).toBe('allow')
  })

  it('完全允许档直接放行', () => {
    expect(decideGitAccess('full', { granted: false })).toBe('allow')
  })
})

describe('git-policy-store —— 授权的单位是仓库，不是 cwd', () => {
  let repo: string
  let sub: string
  let sibling: string

  beforeEach(() => {
    store.__resetGitPolicyForTests()
    try { fs.rmSync(getGitPolicyPath(), { force: true }) } catch { /* 首次没有文件 */ }
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openpipal-repos-'))
    repo = path.join(root, 'checkout-service')
    sub = path.join(repo, 'packages', 'web')
    sibling = path.join(root, 'billing-api')
    fs.mkdirSync(sub, { recursive: true })
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true })
    fs.mkdirSync(path.join(sibling, '.git'), { recursive: true })
  })

  it('子目录归到仓库根 —— 否则 packages/web 下每个目录都要重问一遍', () => {
    expect(store.resolveProjectKey(sub)).toBe(store.resolveProjectKey(repo))
  })

  it('授权不外溢到兄弟仓库 —— 精确匹配，不是前缀匹配', () => {
    store.grantAlwaysProject(repo)
    expect(store.hasGitGrant(sub)).toBe(true)
    expect(store.hasGitGrant(sibling)).toBe(false)
    expect(store.hasGitGrant(path.dirname(repo))).toBe(false)
  })

  it('本对话授权只在这条对话里算数', () => {
    store.grantSessionProject('conv-a', repo)
    expect(store.hasGitGrant(repo, 'conv-a')).toBe(true)
    expect(store.hasGitGrant(repo, 'conv-b')).toBe(false)
    // 不带 conversationId = 只认持久授权（子代理走的就是这条路）
    expect(store.hasGitGrant(repo)).toBe(false)
    store.clearSessionGitGrants('conv-a')
    expect(store.hasGitGrant(repo, 'conv-a')).toBe(false)
  })

  it('持久授权落盘并对所有对话生效；撤销后立刻失效', () => {
    store.grantAlwaysProject(repo)
    expect(store.hasGitGrant(repo, 'conv-whatever')).toBe(true)
    expect(JSON.parse(read(getGitPolicyPath())).allowlist).toContain(store.resolveProjectKey(repo))
    store.revokeProject(repo)
    expect(store.hasGitGrant(repo)).toBe(false)
  })

  it('大小写变体命中同一条授权 —— macOS 不区分大小写，字节比较会被绕过', () => {
    store.grantAlwaysProject(repo)
    expect(store.hasGitGrant(repo.toUpperCase())).toBe(true)
  })

  it('授权文件在凭据拒读清单里 —— 模型能改这个文件就等于能给自己授权', () => {
    expect(getCredentialReadDenyPaths()).toContain(getGitPolicyPath())
  })
})

describe('sanitizeEnvironment —— token 通道', () => {
  const source = {
    GITHUB_TOKEN: 'ghp_x',
    GH_TOKEN: 'gho_y',
    ANTHROPIC_API_KEY: 'sk-secret',
    SOME_OTHER_TOKEN: 'nope',
    PATH: '/usr/bin'
  }

  it('缺省仍然全抹掉 —— 不传选项等于历史行为', () => {
    const env = sanitizeEnvironment(source)
    expect(env.GITHUB_TOKEN).toBeUndefined()
    expect(env.GH_TOKEN).toBeUndefined()
    expect(env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(env.PATH).toBe('/usr/bin')
  })

  it('放行时 GITHUB_TOKEN 必须真的活下来 —— 它同时被两条规则删（陷阱回归）', () => {
    // GITHUB_TOKEN 既在 SENSITIVE_ENV_KEYS 里，又匹配 /_(KEY|SECRET|TOKEN|...)$/i。
    // 只在一处开口子，这个开关就是死的。
    const env = sanitizeEnvironment(source, { allowGitCredentials: true })
    expect(env.GITHUB_TOKEN).toBe('ghp_x')
    expect(env.GH_TOKEN).toBe('gho_y')
  })

  it('放行 git token 不等于放行别的凭据', () => {
    const env = sanitizeEnvironment(source, { allowGitCredentials: true })
    expect(env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(env.SOME_OTHER_TOKEN).toBeUndefined()
  })

  it('pickGitCredentialEnv 只挑真的存在的字符串', () => {
    expect(pickGitCredentialEnv({ GH_TOKEN: 'a' })).toEqual({ GH_TOKEN: 'a' })
    expect(pickGitCredentialEnv({})).toEqual({})
  })
})

describe('接线 —— 判据放对了地方才算数', () => {
  it('git 门排在风险分类之前：分类那层没有 conversationId，也不知道谁授权过', () => {
    const src = read('src/main/pi-security.ts')
    const gate = src.indexOf('enforceGitProjectGrant(toolName, args')
    const classify = src.indexOf('const assessment = classifyToolRisk(toolName, args, scope)')
    expect(gate).toBeGreaterThan(0)
    expect(classify).toBeGreaterThan(gate)
  })

  it('token 只在「命令要连远端」且「项目已授权」两条同时成立时下发', () => {
    const src = read('src/main/openpipal-execution-env.ts')
    expect(src).toMatch(
      /const allowGitCredentials = !!detectGitRemoteUse\(command\) && hasGitGrant\(cwd, this\.conversationId\)/
    )
  })

  it('「本次会话允许」对 git 走项目持久授权，不走按工具授权', () => {
    // bash 是 argumentScoped 的：按工具授权对 git 没意义，下一条 fetch 参数不同又要重问。
    const src = read('src/main/ipc-handlers.ts')
    expect(src).toMatch(/} else if \(gitGrant\) \{[\s\S]{0,300}grantAlwaysProject\(gitGrant\.workingDir\)/)
  })

  it('只读档不放行远端操作，理由要告诉模型怎么办', () => {
    const src = read('src/main/pi-security.ts')
    expect(src).toMatch(/只读档不动远端/)
    expect(src).toMatch(/自动审核/)
  })
})

describe('授权记到哪个仓库 —— 会话工作目录 ≠ 全局工作目录', () => {
  it('持久授权用请求自带的目录，不用全局 getWorkingDir()', () => {
    // 每条会话可以有自己的工作目录（前置页那个目录条就是改它）。
    // 拿全局值会把 A 仓库的授权记到 B 仓库上——那是"授权外溢"，比多问一次严重得多。
    const ipc = read('src/main/ipc-handlers.ts')
    expect(ipc).toMatch(/workingDir: request\.workingDir \|\| getWorkingDir\(\)/)
    const sec = read('src/main/pi-security.ts')
    expect(sec).toMatch(/localSessionApprovalScope\(workingDir\),\s*\n\s*workingDir\s*\n\s*\)/)
  })
})

describe('authorizeToolCall —— 门真的会响（不只是源码里写着）', () => {
  it('没授权的 git push 在自动审核档被拦下，且理由说的是 git 授权', async () => {
    const { authorizeToolCall } = await import('../../src/main/pi-security')
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'openpipal-gate-'))
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true })
    store.__resetGitPolicyForTests()

    // 没注入内联权限发送器 = 无人可问 → 必须 fail-closed（headless/ACP 也走这条）
    const verdict = await authorizeToolCall('bash', { command: 'git push origin main' }, {
      conversationId: 'conv-gate', tier: 'auto', scope: { workingDir: repo }
    })
    expect(verdict?.block).toBe(true)
    expect(verdict?.reason).toMatch(/git 凭据/)
  })

  it('授权过之后同一个仓库不再拦 git —— 拦不住的话这个功能等于没做', async () => {
    const { authorizeToolCall } = await import('../../src/main/pi-security')
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'openpipal-gate-'))
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true })
    store.__resetGitPolicyForTests()
    store.grantSessionProject('conv-gate2', repo)

    const verdict = await authorizeToolCall('bash', { command: 'git push origin main' }, {
      conversationId: 'conv-gate2', tier: 'auto', scope: { workingDir: repo }
    })
    // 授权过就不该再是 git 授权那个理由了（沙箱没开时它会被别的规则拦，那是另一回事）
    expect(verdict?.reason || '').not.toMatch(/git 凭据/)
  })

  it('完全允许档不问，但会把授权记下来 —— 不记的话执行层拿不到 token', async () => {
    const { authorizeToolCall } = await import('../../src/main/pi-security')
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'openpipal-gate-'))
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true })
    store.__resetGitPolicyForTests()

    const verdict = await authorizeToolCall('bash', { command: 'git push origin main' }, {
      conversationId: 'conv-full', tier: 'full', scope: { workingDir: repo }
    })
    expect(verdict?.reason || '').not.toMatch(/git 凭据/)
    expect(store.hasGitGrant(repo, 'conv-full')).toBe(true)
  })

  it('本地 git 命令不经过这道门', async () => {
    const { authorizeToolCall } = await import('../../src/main/pi-security')
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'openpipal-gate-'))
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true })
    store.__resetGitPolicyForTests()

    const verdict = await authorizeToolCall('bash', { command: 'git status' }, {
      conversationId: 'conv-local', tier: 'auto', scope: { workingDir: repo }
    })
    expect(verdict?.reason || '').not.toMatch(/git 凭据/)
    expect(store.hasGitGrant(repo, 'conv-local')).toBe(false)
  })
})

/**
 * 沙箱下 git init / clone 的模板坑。
 *
 * 2026-08-23 端到端验收时撞上：denyWrite 有一条 `.git/hooks` 拒写（防"写个钩子，
 * 下次 commit 就执行任意代码"），而 git init/clone 每次都要把默认模板里的
 * `hooks/*.sample` 拷进新仓库，于是这两条命令在沙箱里 100% 失败：
 *   fatal: cannot copy '.../templates/hooks/commit-msg.sample' to '.../.git/hooks/...': Operation not permitted
 * 修法是指一个空模板目录（拒写规则不动）。这几条钉的是"别把它改回去"。
 */
describe('沙箱下的 git 模板目录', () => {
  it('空模板目录真的存在、真的是空的', async () => {
    const { getGitTemplateDir } = await import('../../src/main/sandbox-manager')
    const dir = getGitTemplateDir()
    expect(fs.existsSync(dir)).toBe(true)
    expect(fs.readdirSync(dir), '模板目录里有东西，git 就会把它拷进 .git/').toHaveLength(0)
  })

  it('空模板下 git init 不会往 .git/hooks 拷任何示例', async () => {
    const { getGitTemplateDir } = await import('../../src/main/sandbox-manager')
    const { execFileSync } = await import('node:child_process')
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'openpipal-tpl-'))
    execFileSync('git', ['init', '-b', 'main', 'r'], {
      cwd: base,
      env: { ...process.env, GIT_TEMPLATE_DIR: getGitTemplateDir() }
    })
    const hooks = path.join(base, 'r', '.git', 'hooks')
    const copied = fs.existsSync(hooks) ? fs.readdirSync(hooks) : []
    expect(copied, '拷了示例钩子 = 在沙箱里这条命令必然被拒写打死').toHaveLength(0)
  })

  it('只有沙箱开着才注入，且用户自己设过的优先', () => {
    const src = read('src/main/openpipal-execution-env.ts')
    // 必须在 safeEnv 之前：放后面就会盖掉用户自己设的 GIT_TEMPLATE_DIR
    const injected = src.indexOf('sandboxed ? { GIT_TEMPLATE_DIR: getGitTemplateDir() }')
    const safeEnv = src.indexOf('...(options?.inheritEnv === false ? {} : this.safeEnv)')
    expect(injected).toBeGreaterThan(0)
    expect(safeEnv).toBeGreaterThan(injected)
  })

  it('拒写规则本身没被放松 —— 修的是模板，不是那条 deny', () => {
    expect(read('src/main/sandbox-manager.ts')).toContain("'/**/.git/hooks/*'")
  })
})

/**
 * git 身份护栏。
 *
 * git 没配 user.name/user.email 时**不报错**：拿登录名 + 机器名拼一个盖上去，退出码 0，
 * 警告还印在提交之后。所有"看退出码"的纪律都拦不住，模型也不例外（真机验收里就这么
 * 把假署名写进了历史）。护栏把无声的失败变成有声的失败，剩下的交给模型转告用户。
 */
describe('git 身份护栏', () => {
  const guard = async (env: NodeJS.ProcessEnv = {}) =>
    (await import('../../src/main/openpipal-execution-env')).buildGitIdentityGuardEnv(env)

  it('空环境：从 0 号位开始写', async () => {
    expect(await guard({})).toEqual({
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'user.useConfigOnly',
      GIT_CONFIG_VALUE_0: 'true'
    })
  })

  it('用户已有 GIT_CONFIG_* 时顺延，不覆盖人家的', async () => {
    const patch = await guard({
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: 'core.editor',
      GIT_CONFIG_KEY_1: 'init.defaultBranch'
    })
    expect(patch.GIT_CONFIG_COUNT).toBe('3')
    expect(patch.GIT_CONFIG_KEY_2).toBe('user.useConfigOnly')
    expect(patch.GIT_CONFIG_KEY_0, '写到 0 号位就把用户的 core.editor 顶掉了').toBeUndefined()
  })

  it('用户自己表过态就不插手', async () => {
    expect(await guard({
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'user.useConfigOnly',
      GIT_CONFIG_VALUE_0: 'false'
    })).toEqual({})
  })

  it('护栏排在凭据桥之前算，两者索引不打架', async () => {
    const { buildGitCredentialEnv } = await import('../../src/main/git-credential-bridge')
    const guarded = { ...(await guard({})) }
    const both = { ...guarded, ...buildGitCredentialEnv('tok', guarded) }
    expect(both.GIT_CONFIG_COUNT).toBe('3')
    expect(both.GIT_CONFIG_KEY_0, '凭据桥从 0 号位起写就把护栏冲掉了').toBe('user.useConfigOnly')
    expect(both.GIT_CONFIG_KEY_1).toContain('credential.')
    expect(both.GIT_CONFIG_KEY_2).toContain('credential.')
  })

  it('执行环境里三处 GIT_CONFIG_* 注入依次接龙，谁都不覆盖前一个', () => {
    // 三处都按 GIT_CONFIG_COUNT 顺延写位，所以每一处**必须拿上一处的结果当输入**。
    // 钉的是这条接龙，不是某一个函数名——中间再插一处注入时，这条会红。
    const src = read('src/main/openpipal-execution-env.ts')
    const excluded = src.indexOf('buildGitDotenvExcludeEnv(getGitDotenvExcludesFile(), baseEnv)')
    const guarded = src.indexOf('buildGitIdentityGuardEnv(excludedEnv)')
    const bridge = src.indexOf('buildGitCredentialEnv(gitToken, guardedEnv)')
    expect(excluded, 'dotenv 排除清单没接在 baseEnv 上').toBeGreaterThan(0)
    expect(guarded, '身份护栏必须拿加过排除清单的那份环境算索引').toBeGreaterThan(excluded)
    expect(bridge, '凭据桥必须拿加过护栏的那份环境算索引').toBeGreaterThan(guarded)
  })

  it('三处注入叠起来占 0..3 号位，一条都没被冲掉', async () => {
    const { buildGitDotenvExcludeEnv, buildGitIdentityGuardEnv } =
      await import('../../src/main/openpipal-execution-env')
    const { buildGitCredentialEnv } = await import('../../src/main/git-credential-bridge')
    const excluded = { ...buildGitDotenvExcludeEnv('/x/ignore') }
    const guarded = { ...excluded, ...buildGitIdentityGuardEnv(excluded) }
    const all = { ...guarded, ...buildGitCredentialEnv('tok', guarded) }
    expect(all.GIT_CONFIG_COUNT).toBe('4')
    expect(all.GIT_CONFIG_KEY_0).toBe('core.excludesFile')
    expect(all.GIT_CONFIG_KEY_1).toBe('user.useConfigOnly')
    expect(all.GIT_CONFIG_KEY_2).toContain('credential.')
    expect(all.GIT_CONFIG_KEY_3).toContain('credential.')
  })

  describe('真跑 git，验行为不是验字符串', () => {
    const IDENT = ['-c', 'user.email=x@y.z', '-c', 'user.name=X']
    let base: string
    let home: string

    const stage = (name: string): string => {
      const repo = path.join(base, name)
      fs.mkdirSync(repo, { recursive: true })
      execFileSync('git', ['init', '-q', '-b', 'main', '.'], { cwd: repo })
      fs.writeFileSync(path.join(repo, 'a.txt'), 'hi\n')
      execFileSync('git', ['add', '-A'], { cwd: repo })
      return repo
    }
    /** 干净环境：没有 ~/.gitconfig，也不读系统级配置 —— 就是"从没配过 git 的人" */
    const bare = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv =>
      ({ ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), GIT_CONFIG_NOSYSTEM: '1', ...extra })

    beforeAll(() => {
      base = fs.mkdtempSync(path.join(os.tmpdir(), 'openpipal-gitid-'))
      home = path.join(base, 'empty-home')
      fs.mkdirSync(home, { recursive: true })
    })
    afterAll(() => {
      try { fs.rmSync(base, { recursive: true, force: true }) } catch { /* 清理失败不影响结论 */ }
    })

    it('没护栏时 git 会瞎猜一个身份，还告诉你成功了', () => {
      const repo = stage('no-guard')
      execFileSync('git', ['commit', '-m', 't'], { cwd: repo, env: bare(), stdio: 'ignore' })
      const author = execFileSync('git', ['log', '-1', '--pretty=%ae'], { cwd: repo, encoding: 'utf8' }).trim()
      expect(author, '这就是问题本身：提交成立了，署名是假的').toMatch(/@/)
    })

    it('有护栏时同一条命令直接失败，且提交没落地', async () => {
      const repo = stage('guarded')
      let code: number | null = null
      let stderr = ''
      try {
        execFileSync('git', ['commit', '-m', 't'], { cwd: repo, env: bare(await guard({})), encoding: 'utf8' })
      } catch (error: any) {
        code = error.status
        stderr = String(error.stderr || '')
      }
      expect(code, '还是 0 就等于护栏没生效').not.toBe(0)
      expect(stderr, 'git 得把配置办法原样告诉用户，模型才转达得了').toContain('user.email')
      expect(
        () => execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, stdio: 'ignore' }),
        '命令失败了却留下提交，等于白拦'
      ).toThrow()
    })

    it('用户配过身份时零误伤：照样提交，作者是他自己的', async () => {
      const repo = stage('configured')
      execFileSync('git', [...IDENT, 'commit', '-q', '-m', 't'], { cwd: repo, env: bare(await guard({})) })
      expect(
        execFileSync('git', ['log', '-1', '--pretty=%ae'], { cwd: repo, encoding: 'utf8' }).trim()
      ).toBe('x@y.z')
    })
  })
})
