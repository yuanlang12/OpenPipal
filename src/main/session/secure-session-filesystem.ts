import {
  constants as fsConstants,
  promises as fs,
  type Stats,
} from 'node:fs'
import path from 'node:path'
import {
  FileError,
  err,
  ok,
  type FileErrorCode,
  type FileInfo,
  type JsonlSessionRepoFileSystem,
  type Result,
} from '@earendil-works/pi-agent-core'

const NO_FOLLOW = fsConstants.O_NOFOLLOW || 0

function asError(value: unknown): Error {
  if (value instanceof Error) return value
  return new Error(String(value))
}

function fileErrorCode(error: NodeJS.ErrnoException): FileErrorCode {
  switch (error.code) {
    case 'ENOENT': return 'not_found'
    case 'EACCES':
    case 'EPERM':
    case 'ELOOP': return 'permission_denied'
    case 'ENOTDIR': return 'not_directory'
    case 'EISDIR': return 'is_directory'
    case 'EINVAL':
    case 'ENAMETOOLONG': return 'invalid'
    case 'ENOTSUP': return 'not_supported'
    default: return 'unknown'
  }
}

function normalizeFileError(error: unknown, addressedPath?: string): FileError {
  if (error instanceof FileError) return error
  const cause = asError(error) as NodeJS.ErrnoException
  return new FileError(
    fileErrorCode(cause),
    cause.message || 'Session filesystem operation failed',
    addressedPath,
    cause
  )
}

function kindOf(stats: Stats): FileInfo['kind'] {
  if (stats.isSymbolicLink()) return 'symlink'
  if (stats.isDirectory()) return 'directory'
  return 'file'
}

/**
 * Pi v4 owns the JSONL/tree semantics, while this adapter keeps OpenPipal's
 * local privacy boundary: every path is confined below one root, directories
 * are private, log leaves cannot be symlinks, and writes use O_NOFOLLOW.
 *
 * FileSystem methods intentionally return Result instead of throwing because
 * that is the public pi-agent-core filesystem contract.
 */
export class SecureSessionFileSystem implements JsonlSessionRepoFileSystem {
  readonly cwd: string
  readonly root: string
  private readonly rootReady: Promise<void>

  constructor(root: string) {
    if (!path.isAbsolute(root)) throw new Error('Session filesystem root must be absolute')
    this.root = path.resolve(root)
    this.cwd = this.root
    this.rootReady = this.initializeRoot()
  }

  private async initializeRoot(): Promise<void> {
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 })
    const info = await fs.lstat(this.root)
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new FileError('permission_denied', 'Session filesystem root must be a real directory', this.root)
    }
    await fs.chmod(this.root, 0o700)
  }

  private checkAbort(abortSignal?: AbortSignal): void {
    if (abortSignal?.aborted) {
      throw new FileError('aborted', 'Session filesystem operation was aborted')
    }
  }

  private addressed(input: string): string {
    const candidate = path.resolve(path.isAbsolute(input) ? input : path.join(this.cwd, input))
    if (candidate !== this.root && !candidate.startsWith(`${this.root}${path.sep}`)) {
      throw new FileError('permission_denied', 'Session path escapes the private data root', candidate)
    }
    return candidate
  }

  private async result<T>(
    operation: () => Promise<T>,
    addressedPath?: string
  ): Promise<Result<T, FileError>> {
    try {
      await this.rootReady
      return ok(await operation())
    } catch (error) {
      return err(normalizeFileError(error, addressedPath))
    }
  }

  private async inspectComponents(candidate: string, includeLeaf: boolean, allowMissing: boolean): Promise<void> {
    const relative = path.relative(this.root, candidate)
    if (!relative) return
    const parts = relative.split(path.sep)
    const count = includeLeaf ? parts.length : Math.max(0, parts.length - 1)
    let current = this.root

    for (let index = 0; index < count; index += 1) {
      current = path.join(current, parts[index])
      try {
        const info = await fs.lstat(current)
        if (info.isSymbolicLink()) {
          throw new FileError('permission_denied', 'Session paths may not contain symbolic links', current)
        }
        if (index < count - 1 && !info.isDirectory()) {
          throw new FileError('not_directory', 'Session path parent is not a directory', current)
        }
      } catch (error) {
        if (allowMissing && (error as NodeJS.ErrnoException)?.code === 'ENOENT') return
        throw error
      }
    }
  }

  private async createDirectory(candidate: string, recursive: boolean): Promise<void> {
    if (candidate === this.root) return
    if (!recursive) {
      await this.inspectComponents(candidate, false, false)
      await fs.mkdir(candidate, { mode: 0o700 })
      await fs.chmod(candidate, 0o700)
      return
    }

    const relative = path.relative(this.root, candidate)
    let current = this.root
    for (const part of relative.split(path.sep)) {
      if (!part) continue
      current = path.join(current, part)
      try {
        const info = await fs.lstat(current)
        if (!info.isDirectory() || info.isSymbolicLink()) {
          throw new FileError('permission_denied', 'Session directory path is not a real directory', current)
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error
        await fs.mkdir(current, { mode: 0o700 })
      }
      await fs.chmod(current, 0o700)
    }
  }

  private async openRegularFile(
    candidate: string,
    flags: number,
    allowMissingLeaf = false
  ): Promise<Awaited<ReturnType<typeof fs.open>>> {
    await this.inspectComponents(candidate, true, allowMissingLeaf)
    const handle = await fs.open(candidate, flags | NO_FOLLOW, 0o600)
    try {
      const info = await handle.stat()
      if (!info.isFile()) {
        throw new FileError('invalid', 'Session log leaf must be a regular file', candidate)
      }
      return handle
    } catch (error) {
      await handle.close()
      throw error
    }
  }

  async absolutePath(input: string, abortSignal?: AbortSignal): Promise<Result<string, FileError>> {
    return this.result(async () => {
      this.checkAbort(abortSignal)
      return this.addressed(input)
    }, input)
  }

  async joinPath(parts: string[], abortSignal?: AbortSignal): Promise<Result<string, FileError>> {
    return this.result(async () => {
      this.checkAbort(abortSignal)
      if (parts.length === 0) throw new FileError('invalid', 'Cannot join an empty path list')
      return this.addressed(path.resolve(parts[0], ...parts.slice(1)))
    })
  }

  async readTextFile(input: string, abortSignal?: AbortSignal): Promise<Result<string, FileError>> {
    let candidate: string | undefined
    return this.result(async () => {
      this.checkAbort(abortSignal)
      candidate = this.addressed(input)
      const handle = await this.openRegularFile(candidate, fsConstants.O_RDONLY)
      try {
        const content = await handle.readFile({ encoding: 'utf8' })
        this.checkAbort(abortSignal)
        return content
      } finally {
        await handle.close()
      }
    }, candidate ?? input)
  }

  async readTextLines(
    input: string,
    options: { maxLines?: number; abortSignal?: AbortSignal } = {}
  ): Promise<Result<string[], FileError>> {
    let candidate: string | undefined
    return this.result(async () => {
      this.checkAbort(options.abortSignal)
      if (options.maxLines !== undefined && (!Number.isInteger(options.maxLines) || options.maxLines <= 0)) {
        throw new FileError('invalid', 'maxLines must be a positive integer', input)
      }
      candidate = this.addressed(input)
      const handle = await this.openRegularFile(candidate, fsConstants.O_RDONLY)
      const decoder = new TextDecoder()
      const buffer = new Uint8Array(64 * 1024)
      const lines: string[] = []
      let pending = ''
      let position = 0
      try {
        while (true) {
          this.checkAbort(options.abortSignal)
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, position)
          if (bytesRead === 0) break
          position += bytesRead
          pending += decoder.decode(buffer.subarray(0, bytesRead), { stream: true })

          let newline = pending.indexOf('\n')
          while (newline >= 0) {
            const line = pending.slice(0, newline).replace(/\r$/, '')
            lines.push(line)
            pending = pending.slice(newline + 1)
            if (lines.length === options.maxLines) return lines
            newline = pending.indexOf('\n')
          }
        }
        pending += decoder.decode()
        if (pending.length > 0) lines.push(pending.replace(/\r$/, ''))
        return options.maxLines === undefined ? lines : lines.slice(0, options.maxLines)
      } finally {
        await handle.close()
      }
    }, candidate ?? input)
  }

  async writeFile(
    input: string,
    content: string | Uint8Array,
    abortSignal?: AbortSignal
  ): Promise<Result<void, FileError>> {
    let candidate: string | undefined
    return this.result(async () => {
      this.checkAbort(abortSignal)
      candidate = this.addressed(input)
      await this.createDirectory(path.dirname(candidate), true)
      await this.inspectComponents(candidate, true, true)
      const handle = await this.openRegularFile(
        candidate,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC,
        true
      )
      try {
        await handle.chmod(0o600)
        await handle.writeFile(content)
        this.checkAbort(abortSignal)
      } finally {
        await handle.close()
      }
    }, candidate ?? input)
  }

  async appendFile(
    input: string,
    content: string | Uint8Array,
    abortSignal?: AbortSignal
  ): Promise<Result<void, FileError>> {
    let candidate: string | undefined
    return this.result(async () => {
      this.checkAbort(abortSignal)
      candidate = this.addressed(input)
      await this.createDirectory(path.dirname(candidate), true)
      await this.inspectComponents(candidate, true, true)
      const handle = await this.openRegularFile(
        candidate,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_APPEND,
        true
      )
      try {
        await handle.chmod(0o600)
        await handle.writeFile(content)
        this.checkAbort(abortSignal)
      } finally {
        await handle.close()
      }
    }, candidate ?? input)
  }

  async renameFile(
    sourceInput: string,
    destinationInput: string,
    abortSignal?: AbortSignal
  ): Promise<Result<void, FileError>> {
    let source: string | undefined
    let destination: string | undefined
    return this.result(async () => {
      this.checkAbort(abortSignal)
      source = this.addressed(sourceInput)
      destination = this.addressed(destinationInput)
      await this.inspectComponents(source, true, false)
      if (!(await fs.lstat(source)).isFile()) {
        throw new FileError('invalid', 'Atomic session publication source must be a regular file', source)
      }
      await this.createDirectory(path.dirname(destination), true)
      await this.inspectComponents(destination, true, true)
      await fs.rename(source, destination)
      await fs.chmod(destination, 0o600)
      this.checkAbort(abortSignal)
    }, destination ?? source ?? destinationInput)
  }

  async fileInfo(input: string, abortSignal?: AbortSignal): Promise<Result<FileInfo, FileError>> {
    let candidate: string | undefined
    return this.result(async () => {
      this.checkAbort(abortSignal)
      candidate = this.addressed(input)
      await this.inspectComponents(candidate, false, false)
      const info = await fs.lstat(candidate)
      return {
        name: path.basename(candidate),
        path: candidate,
        kind: kindOf(info),
        size: info.size,
        mtimeMs: info.mtimeMs,
      }
    }, candidate ?? input)
  }

  async listDir(input: string, abortSignal?: AbortSignal): Promise<Result<FileInfo[], FileError>> {
    let candidate: string | undefined
    return this.result(async () => {
      this.checkAbort(abortSignal)
      candidate = this.addressed(input)
      await this.inspectComponents(candidate, true, false)
      const directory = await fs.lstat(candidate)
      if (!directory.isDirectory() || directory.isSymbolicLink()) {
        throw new FileError('not_directory', 'Session list target is not a real directory', candidate)
      }
      const names = await fs.readdir(candidate)
      const entries: FileInfo[] = []
      for (const name of names) {
        const child = path.join(candidate, name)
        const info = await fs.lstat(child)
        entries.push({
          name,
          path: child,
          kind: kindOf(info),
          size: info.size,
          mtimeMs: info.mtimeMs,
        })
      }
      return entries
    }, candidate ?? input)
  }

  async exists(input: string, abortSignal?: AbortSignal): Promise<Result<boolean, FileError>> {
    let candidate: string | undefined
    return this.result(async () => {
      this.checkAbort(abortSignal)
      candidate = this.addressed(input)
      await this.inspectComponents(candidate, false, true)
      try {
        await fs.lstat(candidate)
        return true
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return false
        throw error
      }
    }, candidate ?? input)
  }

  async createDir(
    input: string,
    options: { recursive?: boolean; abortSignal?: AbortSignal } = {}
  ): Promise<Result<void, FileError>> {
    let candidate: string | undefined
    return this.result(async () => {
      this.checkAbort(options.abortSignal)
      candidate = this.addressed(input)
      await this.createDirectory(candidate, options.recursive ?? true)
      this.checkAbort(options.abortSignal)
    }, candidate ?? input)
  }

  async remove(
    input: string,
    options: { recursive?: boolean; force?: boolean; abortSignal?: AbortSignal } = {}
  ): Promise<Result<void, FileError>> {
    let candidate: string | undefined
    return this.result(async () => {
      this.checkAbort(options.abortSignal)
      candidate = this.addressed(input)
      if (candidate === this.root) {
        throw new FileError('permission_denied', 'Refusing to remove the session filesystem root', candidate)
      }
      try {
        await this.inspectComponents(candidate, true, false)
      } catch (error) {
        if (options.force && (error as NodeJS.ErrnoException)?.code === 'ENOENT') return
        throw error
      }
      await fs.rm(candidate, {
        recursive: options.recursive ?? false,
        force: options.force ?? false,
      })
      this.checkAbort(options.abortSignal)
    }, candidate ?? input)
  }
}
