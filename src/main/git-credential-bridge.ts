/**
 * 把用户的 git 凭据送进沙箱 —— 只送 token，不放开凭据文件。
 *
 * ## 为什么需要这一层（2026-08-23 沙箱内实测）
 *
 * macOS 上 github.com 的凭据 helper 常常是 `!gh auth git-credential`，而
 * `~/.config/gh` 在 SENSITIVE_DIRS 拒读表里（里面的 hosts.yml 存着 oauth token）。
 * 结果是沙箱里任何需要鉴权的 git 操作都撞死在：
 *
 *     failed to read configuration: open ~/.config/gh/config.yml: operation not permitted
 *
 * 而且 `gh` **在读配置文件之前不看 `GH_TOKEN`**，光给环境变量救不回来。
 * 也就是说，光有「按项目授权」这道门，授权完还是什么都干不了。
 *
 * ## 怎么送
 *
 * 主进程不在沙箱里，可以正常取到 token（`gh auth token`）。取到之后**不放开那个目录**，
 * 而是给子进程挂一条只回显 token 的内联 credential helper：
 *
 *   - 先用空值把该 URL 上已有的 helper 列表清掉（否则 gh 那条还会被调到、还会死）
 *   - 再挂自己的，从 `OPENPIPAL_GIT_TOKEN` 读值
 *
 * 实测这条路在沙箱里走通：`git credential fill` 正常返回，私有仓的报错从
 * 「配置被拒」变成 GitHub 服务端的「Authentication failed」—— 说明 token 真的送到了。
 *
 * ## 代价，说清楚
 *
 * 已授权项目里，**要连远端的那条 git 命令**能在自己的环境里看到 token。这绕不过去：
 * agent 要能自己 push，就必然在某一刻碰得到凭据。这里做的是把「某一刻」压到最小——
 * 凭据文件仍然拒读，token 也不进不碰远端的命令（`npm install` 的 postinstall 看不到）。
 *
 * `gh` 本身在沙箱里仍然不可用：给了 `GH_CONFIG_DIR` 能越过配置那关，但它的 TLS 校验
 * 挂在 Go 的 macOS 证书链上（`x509: OSStatus -26276`，`SSL_CERT_FILE` 也不管用）。
 * 那是 SRT + Go 的问题，与本模块无关，没做兜底。
 */
import { execFile } from 'node:child_process'

/** token 拿到手就缓存一小会儿：每条 git 命令都 spawn 一次 gh 太浪费，
 *  但缓存太久又会在用户重新登录后一直用着旧的。五分钟够短也够省。 */
const TOKEN_TTL_MS = 5 * 60 * 1000

interface CachedToken {
  token: string | null
  at: number
}
let cache: CachedToken | null = null

/** 从 gh CLI 取 token。主进程不在沙箱里，读得到 `~/.config/gh`。 */
function readTokenFromGh(): Promise<string | null> {
  return new Promise(resolve => {
    execFile('gh', ['auth', 'token'], { timeout: 5000 }, (error, stdout) => {
      // gh 没装 / 没登录都走这里。不是异常，只是这台机器没有这条通道。
      if (error) return resolve(null)
      const token = String(stdout || '').trim()
      resolve(token || null)
    })
  })
}

/**
 * 解析出可用的 git token。顺序：用户自己设的环境变量 > gh CLI。
 * 拿不到就返回 null —— 调用方不注入，git 走它原本的通道（在沙箱里多半也会失败，
 * 但那是这个功能之前就有的状态，不该由这里伪造成功）。
 */
export async function resolveGitToken(source: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  const fromEnv = source.GITHUB_TOKEN || source.GH_TOKEN
  if (typeof fromEnv === 'string' && fromEnv.trim()) return fromEnv.trim()

  const now = Date.now()
  if (cache && now - cache.at < TOKEN_TTL_MS) return cache.token
  const token = await readTokenFromGh()
  cache = { token, at: now }
  return token
}

/** 仅供单测与「用户重新登录了」时清缓存。 */
export function resetGitTokenCache(): void {
  cache = null
}

/**
 * token 落在环境里的变量名。它结尾是 `_TOKEN`，会被 sanitizeEnvironment 的宽泛正则删掉——
 * 所以必须同时登记进 sandbox-manager 的 GIT_CREDENTIAL_ENV_KEYS，否则这一整套是死的。
 */
export const GIT_TOKEN_ENV_KEY = 'OPENPIPAL_GIT_TOKEN'

/**
 * 内联 helper。**只回显，不做任何判断**——它跑在子进程里，写复杂逻辑等于给自己加攻击面。
 * `x-access-token` 是 GitHub 对「拿 token 当密码」的约定用户名，PAT 与 oauth token 都认。
 */
// 模板里的 `$${X}` = 一个字面 `$` 加上插值，拼出 shell 要的 `$OPENPIPAL_GIT_TOKEN`
const CREDENTIAL_HELPER = `!f() { echo username=x-access-token; echo "password=$${GIT_TOKEN_ENV_KEY}"; }; f`

/** token 的归属主机。gh 的 token 就是这台主机的，别拿去对别的域用。 */
function credentialHost(source: NodeJS.ProcessEnv): string {
  const host = String(source.GH_HOST || '').trim()
  return host || 'github.com'
}

/**
 * 拼出要额外注入给子进程的环境。
 *
 * `existingEnv` 里可能已经有 GIT_CONFIG_COUNT（用户自己设的），所以索引要接着数——
 * 从 0 开始写会把人家的配置覆盖掉。
 *
 * helper 的值**绝不能经过 shell 字符串**：它以 `!` 开头，多套一层引号就会被转义成 `\\!`，
 * git 于是去找一个名叫 `credential-\\!f() {...}` 的外部程序（实测踩过）。
 * 这里返回的是 map，由调用方直接交给 spawn 的 env。
 */
export function buildGitCredentialEnv(
  token: string,
  existingEnv: NodeJS.ProcessEnv = {}
): NodeJS.ProcessEnv {
  const host = credentialHost(existingEnv)
  const scope = `credential.https://${host}.helper`
  const base = Number.parseInt(String(existingEnv.GIT_CONFIG_COUNT || '0'), 10)
  const start = Number.isFinite(base) && base > 0 ? base : 0
  return {
    [GIT_TOKEN_ENV_KEY]: token,
    GIT_CONFIG_COUNT: String(start + 2),
    // 空值 = 把这个 URL 上已经攒下的 helper 列表清空。少了这一条，gh 那个 helper
    // 仍然排在前面被调到，然后死在读不了的配置文件上——等于白注入。
    [`GIT_CONFIG_KEY_${start}`]: scope,
    [`GIT_CONFIG_VALUE_${start}`]: '',
    [`GIT_CONFIG_KEY_${start + 1}`]: scope,
    [`GIT_CONFIG_VALUE_${start + 1}`]: CREDENTIAL_HELPER,
  }
}
