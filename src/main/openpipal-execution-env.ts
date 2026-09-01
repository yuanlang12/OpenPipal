import { type ChildProcess, spawn } from 'node:child_process'
import { constants as fsConstants } from 'node:fs'
import { access } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ExecutionError,
  type Result,
  type ShellExecOptions
} from '@earendil-works/pi-agent-core'
import { NodeExecutionEnv } from '@earendil-works/pi-agent-core/node'
import {
  getGitDotenvExcludesFile,
  getGitTemplateDir,
  getSanitizedEnv,
  isSandboxed,
  pickGitCredentialEnv,
  sanitizeEnvironment,
  wrapCommandStrict
} from './sandbox-manager'
import { detectGitRemoteUse } from './git-policy'
import { hasGitGrant } from './git-policy-store'
import { buildGitCredentialEnv, resolveGitToken } from './git-credential-bridge'
import { createTemporaryCodeFile } from './code-execution-temp'
import {
  OPENPIPAL_DEFAULT_MAX_CAPTURE_BYTES,
  OpenPipalBoundedOutputCapture
} from './bounded-output-capture'

/**
 * 往 `GIT_CONFIG_*` 里**顺延追加一条**配置，返回要合进 env 的增量（不改入参）。
 *
 * git 读的是 `GIT_CONFIG_COUNT` + 一串按序号排的 KEY/VALUE，所以索引必须接着现有的数——
 * 从 0 开始写会把已有的那条整个覆盖掉，而且**不报任何错**：git 照样跑，只是少了一条配置。
 * 这个算术曾经在三处各写一遍（身份护栏、dotenv 排除、凭据桥），改一处漏两处不会有类型错误。
 *
 * `existingEnv` 里已经声明过同名 key 就返回空对象——**后写的赢**，我们再追一条等于替用户改主意。
 */
function appendGitConfig(
  existingEnv: NodeJS.ProcessEnv,
  key: string,
  value: string
): NodeJS.ProcessEnv {
  const declared = Number.parseInt(String(existingEnv.GIT_CONFIG_COUNT || '0'), 10)
  const start = declared > 0 ? declared : 0
  for (let i = 0; i < start; i++) {
    if (String(existingEnv[`GIT_CONFIG_KEY_${i}`] || '').toLowerCase() === key.toLowerCase()) return {}
  }
  return {
    GIT_CONFIG_COUNT: String(start + 1),
    [`GIT_CONFIG_KEY_${start}`]: key,
    [`GIT_CONFIG_VALUE_${start}`]: value
  }
}

/**
 * git 身份护栏：没配 `user.name` / `user.email` 时，让 `git commit` **报错**，而不是瞎猜一个。
 *
 * git 默认会拿登录名 + 机器名拼一个身份盖上去，**退出码 0**，警告还印在提交*之后*
 * ——2026-08-24 实测 git 2.50.1：作者落成 `alice <alice@Alices-MacBook-Pro.local>`，提交照样成立。
 * 于是所有基于退出码的纪律都拦不住它；更糟的是编码助手提示词里那句"每条命令都要看退出码"
 * 反而把模型引开了：退出码是 0，按我们自己的规矩它就该往下走。真机验收里模型正是这样
 * 一路"成功"地把一个假署名写进了历史，全程没有任何一方察觉。
 *
 * **这不是能力拐杖**：再完美的模型也不知道用户叫什么、邮箱是什么——缺的是数据，不是判断力。
 * 所以修在代码里：打开 `user.useConfigOnly`，把无声的失败变成有声的失败（退出码 128 +
 * git 自己那段"请先 git config --global user.email …"的指引），剩下的交给模型——
 * 它看得懂那段话，会转告用户。**不需要为此加一句提示词。**
 *
 * 用户已经配过身份时这一项是 no-op（实测退出码 0、作者正确），所以不分角色、不分沙箱一律注入。
 * 唯一的让路：用户自己显式设过 `user.useConfigOnly` 就不插手——GIT_CONFIG_* 后写的赢，
 * 我们再追一条等于替他改主意。
 */
export function buildGitIdentityGuardEnv(existingEnv: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return appendGitConfig(existingEnv, 'user.useConfigOnly', 'true')
}

/**
 * 沙箱下把 `core.excludesFile` 指到我们生成的那份清单上，让 git 别去 lstat 它读不到的 dotenv。
 * 为什么需要、修好了哪些命令 → credential-paths.ts 的 `buildGitDotenvExcludeBody`。
 *
 * 和 `buildGitIdentityGuardEnv` 同一套写法（见 `appendGitConfig`）：按 `GIT_CONFIG_COUNT` 顺延写位，
 * **用户自己设过就完全不插手**（GIT_CONFIG_* 后写的赢，我们再追一条等于替他改主意）。
 */
export function buildGitDotenvExcludeEnv(
  excludesFile: string,
  existingEnv: NodeJS.ProcessEnv = {}
): NodeJS.ProcessEnv {
  return appendGitConfig(existingEnv, 'core.excludesFile', excludesFile)
}

/** Commands without an explicit timeout cannot occupy an agent forever. */
export const OPENPIPAL_DEFAULT_SHELL_TIMEOUT_SECONDS = 120
/** Long builds remain possible when explicitly requested, but not indefinitely. */
export const OPENPIPAL_MAX_SHELL_TIMEOUT_SECONDS = 600
/** Per stream; direct callers therefore retain at most 256 KiB across stdout/stderr. */
export const OPENPIPAL_MAX_CAPTURE_BYTES_PER_STREAM = OPENPIPAL_DEFAULT_MAX_CAPTURE_BYTES
/** Aggregate stdout + stderr budget, including bytes forwarded to tool callbacks. */
export const OPENPIPAL_MAX_TOTAL_OUTPUT_BYTES = 8 * 1024 * 1024
/** execute_code is intended for bounded computation rather than long-running services. */
export const OPENPIPAL_EXECUTE_CODE_TIMEOUT_SECONDS = 30

export interface OpenPipalExecutionPolicy {
  defaultTimeoutSeconds: number
  maxTimeoutSeconds: number
  maxCaptureBytesPerStream: number
  maxTotalOutputBytes: number
}

interface ActiveExecution {
  terminateAsAborted(): void
  done: Promise<void>
}

type TerminationReason = 'aborted' | 'timeout' | 'callback_error' | 'output_limit'

interface ResolvedShell {
  executable: string
  args: string[]
  commandFromStdin: boolean
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

function resolvePath(cwd: string, requestedPath: string): string {
  let normalized = requestedPath
  if (normalized === '~') {
    normalized = homedir()
  } else if (normalized.startsWith('~/') || (process.platform === 'win32' && normalized.startsWith('~\\'))) {
    normalized = path.join(homedir(), normalized.slice(2))
  } else if (normalized.startsWith('file://')) {
    try {
      normalized = fileURLToPath(normalized)
    } catch {
      // Preserve the public backend's non-throwing path contract. spawn() will
      // report a malformed working directory as a typed spawn_error below.
    }
  }
  return path.isAbsolute(normalized) ? path.resolve(normalized) : path.resolve(cwd, normalized)
}

function validatePolicy(policy: OpenPipalExecutionPolicy): void {
  for (const [name, value] of Object.entries({
    defaultTimeoutSeconds: policy.defaultTimeoutSeconds,
    maxTimeoutSeconds: policy.maxTimeoutSeconds
  })) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new TypeError(`${name} must be a finite positive number`)
    }
  }
  for (const [name, value] of Object.entries({
    maxCaptureBytesPerStream: policy.maxCaptureBytesPerStream,
    maxTotalOutputBytes: policy.maxTotalOutputBytes
  })) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new TypeError(`${name} must be a positive safe integer`)
    }
  }
  if (policy.defaultTimeoutSeconds > policy.maxTimeoutSeconds) {
    throw new TypeError('defaultTimeoutSeconds cannot exceed maxTimeoutSeconds')
  }
}

function resolveTimeoutSeconds(
  requested: number | undefined,
  policy: OpenPipalExecutionPolicy
): Result<number, ExecutionError> {
  const timeout = requested ?? policy.defaultTimeoutSeconds
  if (!Number.isFinite(timeout) || timeout <= 0) {
    return {
      ok: false,
      error: new ExecutionError('timeout', 'Invalid timeout: must be a finite positive number of seconds')
    }
  }
  if (timeout > policy.maxTimeoutSeconds) {
    return {
      ok: false,
      error: new ExecutionError(
        'timeout',
        `Invalid timeout: OpenPipal allows at most ${policy.maxTimeoutSeconds} seconds`
      )
    }
  }
  return { ok: true, value: timeout }
}

async function isExecutable(filePath: string): Promise<boolean> {
  try {
    await access(filePath, fsConstants.F_OK | fsConstants.X_OK)
    return true
  } catch {
    return false
  }
}

function isLegacyWslBash(filePath: string): boolean {
  const normalized = filePath.replace(/\//g, '\\').toLowerCase()
  return /^[a-z]:\\windows\\(?:system32|sysnative)\\bash\.exe$/.test(normalized)
}

async function findExecutableOnPath(
  executable: string,
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform
): Promise<string | undefined> {
  const pathValue = environment.PATH || environment.Path
  if (!pathValue) return undefined
  const pathApi = platform === 'win32' ? path.win32 : path.posix
  const delimiter = platform === 'win32' ? ';' : ':'
  for (const rawDirectory of pathValue.split(delimiter)) {
    const directory = rawDirectory.trim().replace(/^"|"$/g, '')
    if (!directory) continue
    const candidate = pathApi.join(directory, executable)
    if (await isExecutable(candidate)) return candidate
  }
  return undefined
}

async function resolveShellCommand(
  command: string,
  environment: NodeJS.ProcessEnv
): Promise<Result<ResolvedShell, ExecutionError>> {
  if (process.platform === 'win32') {
    const candidates: string[] = []
    if (environment.ProgramFiles) {
      candidates.push(path.win32.join(environment.ProgramFiles, 'Git', 'bin', 'bash.exe'))
    }
    if (environment['ProgramFiles(x86)']) {
      candidates.push(path.win32.join(environment['ProgramFiles(x86)'], 'Git', 'bin', 'bash.exe'))
    }
    for (const candidate of candidates) {
      if (await isExecutable(candidate)) {
        return {
          ok: true,
          value: { executable: candidate, args: ['-c', command], commandFromStdin: false }
        }
      }
    }

    const bashOnPath = await findExecutableOnPath('bash.exe', environment, 'win32')
    if (bashOnPath) {
      return {
        ok: true,
        value: isLegacyWslBash(bashOnPath)
          ? { executable: bashOnPath, args: ['-s'], commandFromStdin: true }
          : { executable: bashOnPath, args: ['-c', command], commandFromStdin: false }
      }
    }
    return {
      ok: false,
      error: new ExecutionError(
        'shell_unavailable',
        `No bash shell found. Searched Git Bash and PATH candidates:\n${candidates.join('\n')}`
      )
    }
  }

  if (await isExecutable('/bin/bash')) {
    return {
      ok: true,
      value: { executable: '/bin/bash', args: ['-c', command], commandFromStdin: false }
    }
  }
  const bashOnPath = await findExecutableOnPath('bash', environment, process.platform)
  if (bashOnPath) {
    return {
      ok: true,
      value: { executable: bashOnPath, args: ['-c', command], commandFromStdin: false }
    }
  }
  return {
    ok: true,
    value: { executable: 'sh', args: ['-c', command], commandFromStdin: false }
  }
}

function utf8Prefix(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return ''
  let bytes = 0
  let output = ''
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, 'utf8')
    if (bytes + characterBytes > maxBytes) break
    output += character
    bytes += characterBytes
  }
  return output
}

function killProcessTree(child: ChildProcess): void {
  const pid = child.pid
  if (!pid) return

  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/F', '/T', '/PID', String(pid)], {
        stdio: 'ignore',
        detached: true,
        windowsHide: true
      }).unref()
    } catch {
      try { child.kill('SIGKILL') } catch {
        // The child may already have exited.
      }
    }
    return
  }

  try {
    // Commands are detached into their own group, so this also terminates
    // grandchildren such as dev servers spawned by a shell script.
    process.kill(-pid, 'SIGKILL')
  } catch {
    try { child.kill('SIGKILL') } catch {
      // The process group or child may already have exited.
    }
  }
}

/**
 * Product-owned policy wrapper around pi-core's public Node execution backend.
 *
 * Filesystem operations continue to use the public NodeExecutionEnv. Process
 * execution is implemented here because the upstream exec() return path buffers
 * stdout and stderr without a ceiling. OpenPipal keeps bounded tail buffers,
 * supplies a finite timeout, kills the complete process group on cancellation,
 * and never inherits provider credentials.
 */
export class OpenPipalNodeExecutionEnv extends NodeExecutionEnv {
  private readonly safeEnv: Record<string, string>
  private readonly policy: OpenPipalExecutionPolicy
  private readonly activeExecutions = new Set<ActiveExecution>()
  /**
   * 只用来查 git 项目授权里的「本次对话」那一半。缺省 undefined = 只认持久授权，
   * 这正是子代理该有的保守面：子代理自带一整套工具，档位与本对话授权都不往下传。
   */
  private readonly conversationId?: string
  private closed = false

  constructor(
    cwd: string,
    policy: Partial<OpenPipalExecutionPolicy> = {},
    conversationId?: string
  ) {
    const safeEnv = Object.fromEntries(
      Object.entries(getSanitizedEnv())
        .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    )
    super({ cwd, shellEnv: safeEnv })
    this.safeEnv = safeEnv
    this.conversationId = conversationId
    this.policy = {
      defaultTimeoutSeconds: policy.defaultTimeoutSeconds ?? OPENPIPAL_DEFAULT_SHELL_TIMEOUT_SECONDS,
      maxTimeoutSeconds: policy.maxTimeoutSeconds ?? OPENPIPAL_MAX_SHELL_TIMEOUT_SECONDS,
      maxCaptureBytesPerStream: policy.maxCaptureBytesPerStream ?? OPENPIPAL_MAX_CAPTURE_BYTES_PER_STREAM,
      maxTotalOutputBytes: policy.maxTotalOutputBytes ?? OPENPIPAL_MAX_TOTAL_OUTPUT_BYTES
    }
    validatePolicy(this.policy)
  }

  override async exec(
    command: string,
    options?: ShellExecOptions
  ): Promise<Result<{ stdout: string; stderr: string; exitCode: number }, ExecutionError>> {
    if (this.closed || options?.abortSignal?.aborted) {
      return { ok: false, error: new ExecutionError('aborted', 'aborted') }
    }

    const timeoutResult = resolveTimeoutSeconds(options?.timeout, this.policy)
    if (!timeoutResult.ok) return timeoutResult

    let script: ReturnType<typeof createTemporaryCodeFile> | undefined
    let executableCommand = command
    const sandboxed = isSandboxed()
    try {
      if (sandboxed) {
        script = createTemporaryCodeFile('sh', command)
        executableCommand = await wrapCommandStrict(`bash ${shellQuote(script.path)}`)
        if (this.closed || options?.abortSignal?.aborted) {
          return { ok: false, error: new ExecutionError('aborted', 'aborted') }
        }
      }

      const cwd = options?.cwd ? resolvePath(this.cwd, options.cwd) : this.cwd
      try {
        await access(cwd, fsConstants.F_OK)
      } catch (error) {
        if (this.closed || options?.abortSignal?.aborted) {
          return { ok: false, error: new ExecutionError('aborted', 'aborted') }
        }
        const cause = toError(error)
        return {
          ok: false,
          error: new ExecutionError(
            'spawn_error',
            `Working directory does not exist: ${cwd}\nCannot execute bash commands.`,
            cause
          )
        }
      }

      if (this.closed || options?.abortSignal?.aborted) {
        return { ok: false, error: new ExecutionError('aborted', 'aborted') }
      }

      // git token 只在「这条命令真的要连远端」且「用户授权过这个项目」时才发下去。
      // 两个条件都要，是为了缩小暴露面：一个项目被授权后，`npm install` 的 postinstall
      // 脚本仍然看不到 token —— 那才是现实里最像样的外泄路径。
      // this.safeEnv 在构造时就被抹过了，留底只能从 process.env 现取。
      const allowGitCredentials = !!detectGitRemoteUse(command) && hasGitGrant(cwd, this.conversationId)
      const baseEnv = {
        // 沙箱下 `.git/hooks/*` 拒写，而 git init/clone 一定会拷模板里的 hooks 示例 ——
        // 不指个空模板，这两条命令在沙箱里必失败。放在最前面：用户自己设过就让用户的赢。
        ...(sandboxed ? { GIT_TEMPLATE_DIR: getGitTemplateDir() } : {}),
        ...(options?.inheritEnv === false ? {} : this.safeEnv),
        ...(allowGitCredentials ? pickGitCredentialEnv(process.env) : {}),
        ...options?.env,
        ...(sandboxed ? { OPENPIPAL_SANDBOXED: '1' } : {})
      }
      // dotenv 排除清单见 buildGitDotenvExcludeEnv。三处 GIT_CONFIG_* 注入必须**依次**算，
      // 每一处都拿上一处的结果当输入——都按 GIT_CONFIG_COUNT 顺延写位，
      // 谁看的是旧计数谁就会把前一条覆盖掉。
      const excludedEnv = sandboxed
        ? { ...baseEnv, ...buildGitDotenvExcludeEnv(getGitDotenvExcludesFile(), baseEnv) }
        : baseEnv
      // 身份护栏见 buildGitIdentityGuardEnv。必须排在凭据桥前面算，同一个理由。
      const guardedEnv = { ...excludedEnv, ...buildGitIdentityGuardEnv(excludedEnv) }
      // 凭据桥：主进程在沙箱外取到 token（`gh auth token` 等），只给这一条命令挂一个
      // 内联 credential helper。凭据文件继续拒读——放开 ~/.config/gh 等于把 token
      // 交给整个会话，而这样只交给"已授权项目里真要连远端"的那条命令。
      // 取不到 token 就什么都不注入，让 git 走它原本的通道，不伪造成功。
      const gitToken = allowGitCredentials ? await resolveGitToken() : null
      const childEnvironment = Object.fromEntries(
        Object.entries(sanitizeEnvironment({
          ...guardedEnv,
          ...(gitToken ? buildGitCredentialEnv(gitToken, guardedEnv) : {})
        }, { allowGitCredentials })).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
      )
      return await this.spawnBounded(executableCommand, cwd, timeoutResult.value, {
        ...options,
        env: childEnvironment,
        inheritEnv: false
      })
    } catch (error) {
      const cause = toError(error)
      return {
        ok: false,
        error: new ExecutionError('spawn_error', cause.message, cause)
      }
    } finally {
      script?.dispose()
    }
  }

  private async spawnBounded(
    command: string,
    cwd: string,
    timeoutSeconds: number,
    options: ShellExecOptions
  ): Promise<Result<{ stdout: string; stderr: string; exitCode: number }, ExecutionError>> {
    const stdout = new OpenPipalBoundedOutputCapture('stdout', this.policy.maxCaptureBytesPerStream)
    const stderr = new OpenPipalBoundedOutputCapture('stderr', this.policy.maxCaptureBytesPerStream)
    if (this.closed || options.abortSignal?.aborted) {
      return { ok: false, error: new ExecutionError('aborted', 'aborted') }
    }
    const shellResult = await resolveShellCommand(command, options.env || {})
    if (!shellResult.ok) return shellResult
    if (this.closed || options.abortSignal?.aborted) {
      return { ok: false, error: new ExecutionError('aborted', 'aborted') }
    }
    const shell = shellResult.value

    return await new Promise((resolvePromise) => {
      let child: ChildProcess
      let settled = false
      let terminationReason: TerminationReason | undefined
      let callbackError: Error | undefined
      let outputLimitObservedBytes: number | undefined
      let totalOutputBytes = 0
      const timeout = { id: undefined as ReturnType<typeof setTimeout> | undefined }
      let resolveDone!: () => void
      const done = new Promise<void>((resolve) => { resolveDone = resolve })

      const settle = (
        result: Result<{ stdout: string; stderr: string; exitCode: number }, ExecutionError>
      ): void => {
        if (settled) return
        settled = true
        if (timeout.id) clearTimeout(timeout.id)
        options.abortSignal?.removeEventListener('abort', onAbort)
        this.activeExecutions.delete(activeExecution)
        resolveDone()
        resolvePromise(result)
      }

      const terminate = (reason: TerminationReason, error?: Error): void => {
        if (!terminationReason) {
          terminationReason = reason
          callbackError = error
        }
        killProcessTree(child)
      }

      const onAbort = (): void => terminate('aborted')
      const activeExecution: ActiveExecution = {
        terminateAsAborted: onAbort,
        done
      }

      if (this.closed || options.abortSignal?.aborted) {
        settle({ ok: false, error: new ExecutionError('aborted', 'aborted') })
        return
      }

      try {
        child = spawn(shell.executable, shell.args, {
          cwd,
          detached: process.platform !== 'win32',
          env: options.env,
          stdio: [shell.commandFromStdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
          windowsHide: true
        })
      } catch (error) {
        const cause = toError(error)
        settle({ ok: false, error: new ExecutionError('spawn_error', cause.message, cause) })
        return
      }

      if (shell.commandFromStdin) {
        child.stdin?.on('error', () => undefined)
        child.stdin?.end(command)
      }

      this.activeExecutions.add(activeExecution)
      timeout.id = setTimeout(() => terminate('timeout'), timeoutSeconds * 1000)
      options.abortSignal?.addEventListener('abort', onAbort, { once: true })
      if (options.abortSignal?.aborted) onAbort()

      child.stdout?.setEncoding('utf8')
      child.stderr?.setEncoding('utf8')
      const handleOutput = (
        capture: OpenPipalBoundedOutputCapture,
        callback: ((chunk: string) => void) | undefined,
        chunk: string
      ): void => {
        if (terminationReason) return
        const chunkBytes = Buffer.byteLength(chunk, 'utf8')
        const remainingBytes = this.policy.maxTotalOutputBytes - totalOutputBytes
        const exceedsLimit = chunkBytes > remainingBytes
        const accepted = exceedsLimit ? utf8Prefix(chunk, remainingBytes) : chunk
        const acceptedBytes = Buffer.byteLength(accepted, 'utf8')
        if (acceptedBytes > 0) {
          capture.append(accepted)
          totalOutputBytes += acceptedBytes
        }
        try {
          if (accepted) callback?.(accepted)
        } catch (error) {
          terminate('callback_error', toError(error))
          return
        }
        if (exceedsLimit) {
          outputLimitObservedBytes = totalOutputBytes + (chunkBytes - acceptedBytes)
          terminate('output_limit')
        }
      }
      child.stdout?.on('data', (chunk: string) => handleOutput(stdout, options.onStdout, chunk))
      child.stderr?.on('data', (chunk: string) => handleOutput(stderr, options.onStderr, chunk))

      child.once('error', (error) => {
        settle({ ok: false, error: new ExecutionError('spawn_error', error.message, error) })
      })
      child.once('close', (code) => {
        if (terminationReason === 'callback_error') {
          const cause = callbackError ?? new Error('Shell output callback failed')
          settle({ ok: false, error: new ExecutionError('callback_error', cause.message, cause) })
          return
        }
        if (terminationReason === 'timeout') {
          settle({
            ok: false,
            error: new ExecutionError('timeout', `timeout:${timeoutSeconds}`)
          })
          return
        }
        if (terminationReason === 'output_limit') {
          settle({
            ok: false,
            error: new ExecutionError(
              'unknown',
              `Command output exceeded OpenPipal's stdout + stderr limit of ${this.policy.maxTotalOutputBytes} bytes (observed at least ${outputLimitObservedBytes ?? this.policy.maxTotalOutputBytes + 1} bytes); process terminated`
            )
          })
          return
        }
        if (terminationReason === 'aborted' || options.abortSignal?.aborted) {
          settle({ ok: false, error: new ExecutionError('aborted', 'aborted') })
          return
        }
        settle({
          ok: true,
          value: {
            stdout: stdout.value(),
            stderr: stderr.value(),
            exitCode: code ?? 0
          }
        })
      })
    })
  }

  override async cleanup(): Promise<void> {
    this.closed = true
    const pending = Array.from(this.activeExecutions)
    for (const execution of pending) execution.terminateAsAborted()

    if (pending.length > 0) {
      let timeoutId: ReturnType<typeof setTimeout> | undefined
      await Promise.race([
        Promise.allSettled(pending.map(execution => execution.done)),
        new Promise<void>((resolve) => {
          timeoutId = setTimeout(resolve, 1_000)
        })
      ])
      if (timeoutId) clearTimeout(timeoutId)
    }

    // Retain the public backend's best-effort cleanup for temporary files made
    // by read/bash capture helpers and for any future upstream resources.
    try { await super.cleanup() } catch {
      // Upstream cleanup is best effort; OpenPipal-owned executions are already settled.
    }
  }
}
