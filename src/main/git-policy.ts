/**
 * git 远端操作的「项目轴」判据（纯逻辑：无 fs、无 electron、无状态）。
 *
 * 状态层在 git-policy-store.ts —— 与 browser-policy / browser-policy-store 同一分工：
 * 这里只回答"这条命令要不要用用户的 git 凭据"和"给定档位+授权该放行还是问一次"，
 * 谁授权过、授权落在哪个文件，本模块一概不知道。
 *
 * ## 为什么需要这道门（2026-08-23 实测）
 *
 * 沙箱里 `git credential-osxkeychain` 是通的（wrapWithSandbox 前后行为一致、都 exit 0），
 * `~/.gitconfig` 也读得到。而 `git push origin main` 不在 DESTRUCTIVE_COMMANDS 表里
 * （表里只有强推），沙箱开启时 bash 分类是 `safe` —— 也就是**今天模型可以拿用户钥匙串里
 * 的凭据直接推代码，一次都不问**。所以这个 Phase 首先是收紧，不是放宽。
 *
 * 反过来，token 通道（GITHUB_TOKEN / GH_TOKEN）被 sanitizeEnvironment 无条件抹掉，
 * 用 `gh` 的人现在连 `gh pr list` 都跑不了。授权之后按项目放行那几个变量，是这道门的另一半。
 *
 * SSH 通道不在讨论范围：SRT 只代理 HTTP/HTTPS 且沙箱里 DNS 不放行，
 * `ssh git@github.com` 卡在 "Could not resolve hostname"（见 sandbox-manager.ts 的实测注释）。
 */

export type GitAccessDecision = 'allow' | 'ask' | 'deny'

/** 命中的远端操作。label 只用于把话说清楚（弹框里写"git push"），不参与判定。 */
export interface GitRemoteUse {
  label: string
}

/**
 * `git` 在子命令之前可以插一串全局选项，其中这几个还要吃掉后面一个词
 * （`git -C /repo push` 的 `/repo` 不是子命令）。漏掉这张表就会把路径当成子命令，
 * 于是 `git -C /repo push` 认不出来 —— 而认不出来 = 静默放行，正是这道门要堵的洞。
 */
const GIT_GLOBAL_FLAGS_WITH_VALUE = new Set([
  '-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--super-prefix'
])

/** 会联网鉴权的 git 子命令。 */
const GIT_REMOTE_SUBCOMMANDS = new Set([
  'push', 'pull', 'fetch', 'clone', 'ls-remote'
])

/**
 * 这几条要看第二个词才知道联不联网：
 * `git remote add` 纯本地，`git remote update` 会去拉；submodule 同理。
 * 判不准的时候宁可多问一次（问了只是多一次点击，漏了是凭据静默外流）。
 */
const GIT_CONDITIONAL_SUBCOMMANDS: Record<string, Set<string> | null> = {
  remote: new Set(['update', 'prune', 'show']),
  submodule: new Set(['update', 'sync', 'foreach']),
}

/** 这两个 CLI 本身就是"拿着用户 token 说话"，任何子命令都算。 */
const CREDENTIALED_CLIS = new Set(['gh', 'hub', 'glab'])

/** 按 shell 的命令分隔符切段，让 `ls && git push` 里的 push 同样被看见。 */
function splitSegments(command: string): string[] {
  return command.split(/(?:\|\||&&|[;|&\n])/g)
}

/** 粗切词：够用来认子命令即可，不追求还原 shell 的完整引号语义。 */
function tokenize(segment: string): string[] {
  return (segment.match(/"(?:\\.|[^"])*"|'[^']*'|\S+/g) || []).map(token => {
    const quoted = (token.startsWith('"') && token.endsWith('"'))
      || (token.startsWith("'") && token.endsWith("'"))
    return quoted ? token.slice(1, -1) : token
  })
}

/** 去掉 `/usr/bin/git`、`env`/`sudo` 之类前缀后，这段的主命令名。 */
function commandName(token: string): string {
  const base = token.split('/').pop() || token
  return base.toLowerCase()
}

function inspectGitInvocation(tokens: string[], startIndex: number): GitRemoteUse | null {
  let i = startIndex + 1
  while (i < tokens.length) {
    const token = tokens[i]
    if (!token.startsWith('-')) break
    // `--git-dir=/x` 自带值，不吃下一个词；`--git-dir /x` 才吃
    if (GIT_GLOBAL_FLAGS_WITH_VALUE.has(token)) i += 2
    else i += 1
  }
  const sub = tokens[i]
  if (!sub) return null
  if (GIT_REMOTE_SUBCOMMANDS.has(sub)) return { label: `git ${sub}` }
  const conditional = GIT_CONDITIONAL_SUBCOMMANDS[sub]
  if (conditional) {
    const next = tokens.slice(i + 1).find(token => !token.startsWith('-'))
    if (next && conditional.has(next)) return { label: `git ${sub} ${next}` }
    return null
  }
  // `git archive --remote=…` 会连远端，但它不是常见路径，单独认一下就够
  if (sub === 'archive' && tokens.slice(i + 1).some(token => token.startsWith('--remote'))) {
    return { label: 'git archive --remote' }
  }
  return null
}

/**
 * 这条命令是否要用到用户的 git 凭据。
 *
 * **刻意偏向多认**：认错了只是多弹一次框，认漏了就是凭据静默可用。
 * 但也不能宽到"命令里出现 git 就算"—— `git status` / `git log` 天天跑，
 * 每条都问会把用户训练成闭眼点允许，那比不问更糟。
 */
export function detectGitRemoteUse(command: string): GitRemoteUse | null {
  if (!command) return null
  for (const segment of splitSegments(command)) {
    const tokens = tokenize(segment)
    for (let i = 0; i < tokens.length; i++) {
      const name = commandName(tokens[i])
      // 变量赋值前缀（FOO=bar git push）与 env/sudo/nohup 之类的包装词直接跳过
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) continue
      if (name === 'git') {
        const hit = inspectGitInvocation(tokens, i)
        if (hit) return hit
      } else if (CREDENTIALED_CLIS.has(name)) {
        const sub = tokens.slice(i + 1).find(token => !token.startsWith('-'))
        return { label: sub ? `${name} ${sub}` : name }
      }
    }
  }
  return null
}

export interface GitAccessState {
  /** 这个项目已经被用户授权过（本对话授权或持久授权，状态层不区分） */
  granted: boolean
}

/**
 * 档位 + 授权 → 放行 / 问一次 / 拒绝。用户定的三档语义：
 * 只读不行；自动审核记住这个项目的授权，授权过就放行；完全允许直接放行。
 */
export function decideGitAccess(
  tier: 'readonly' | 'auto' | 'full',
  state: GitAccessState
): GitAccessDecision {
  if (tier === 'readonly') return 'deny'
  if (tier === 'full') return 'allow'
  return state.granted ? 'allow' : 'ask'
}
