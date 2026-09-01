import path from 'node:path'
import { createRequire } from 'node:module'
import { Worker } from 'node:worker_threads'
import {
  DEFAULT_MAX_BYTES,
  formatSize,
  GREP_MAX_LINE_LENGTH,
  truncateHead,
  type AgentHarnessTool,
  type ExecutionToolContext,
  type TruncationResult
} from '@earendil-works/pi-agent-core'
import { Type } from 'typebox'

const GREP_DEFAULT_LIMIT = 100
const FIND_DEFAULT_LIMIT = 1000
const LS_DEFAULT_LIMIT = 500
const GREP_MAX_LIMIT = 1000
const FIND_MAX_LIMIT = 5000
const LS_MAX_LIMIT = 5000
const DEFAULT_MAX_TRAVERSED_ENTRIES = 50_000
const ABSOLUTE_MAX_TRAVERSED_ENTRIES = 200_000
const DEFAULT_MAX_GREP_FILE_BYTES = 4 * 1024 * 1024
const ABSOLUTE_MAX_GREP_FILE_BYTES = 16 * 1024 * 1024
const DEFAULT_SEARCH_TIMEOUT_MS = 8_000
const ABSOLUTE_MAX_SEARCH_TIMEOUT_MS = 30_000
const MAX_CONTEXT_LINES = 10
const MAX_PATTERN_LENGTH = 16 * 1024
const MAX_WORKER_RESULT_CHARS = 2 * DEFAULT_MAX_BYTES
const WORKER_OLD_GENERATION_MB = 64
const WORKER_YOUNG_GENERATION_MB = 16
const WORKER_STACK_MB = 4
const MAX_ACTIVE_SEARCH_WORKERS = 2
const MAX_QUEUED_SEARCH_WORKERS = 8

// grep 和 find 的 includeIgnored 说的是同一件事，两边逐字相同——这是模型读的提示词，
// 手工同步两份 400 字的说明迟早会漂，而漂了之后两个工具会对同一个开关说两种话。
const INCLUDE_IGNORED_DESCRIPTION =
  'Also search files excluded by .gitignore — dependencies (node_modules), build output (dist/out), '
  + 'generated code. Use it when the answer lives upstream: how a dependency actually behaves, '
  + 'what default a package ships, what a generated file contains. Off by default because these trees '
  + 'are huge; narrow with `path` when you turn it on. `.git` and credential files stay excluded either way.'

// Resolve once from the product's declared dependency. The worker receives the
// exact file path, so it never searches user-controlled cwd/node_modules paths.
const ignoreModulePath = createRequire(
  path.join(__dirname, 'openpipal-search-worker.cjs')
).resolve('ignore')

const grepSchema = Type.Object({
  pattern: Type.String({
    description: 'Search pattern (regex or literal string)',
    maxLength: MAX_PATTERN_LENGTH
  }),
  path: Type.Optional(
    Type.String({ description: 'Directory or file to search (default: current directory)' })
  ),
  glob: Type.Optional(
    Type.String({
      description: "Filter files by glob pattern, e.g. '*.ts' or '**/*.spec.ts'",
      maxLength: MAX_PATTERN_LENGTH
    })
  ),
  ignoreCase: Type.Optional(
    Type.Boolean({ description: 'Case-insensitive search (default: false)' })
  ),
  literal: Type.Optional(
    Type.Boolean({ description: 'Treat pattern as literal string instead of regex (default: false)' })
  ),
  context: Type.Optional(
    Type.Number({ description: `Lines before and after each match (default: 0, max: ${MAX_CONTEXT_LINES})` })
  ),
  limit: Type.Optional(
    Type.Number({ description: `Maximum matches to return (default: ${GREP_DEFAULT_LIMIT}, max: ${GREP_MAX_LIMIT})` })
  ),
  includeIgnored: Type.Optional(
    Type.Boolean({ description: INCLUDE_IGNORED_DESCRIPTION })
  )
})

const findSchema = Type.Object({
  pattern: Type.String({
    description: "Glob pattern to match files, e.g. '*.ts', '**/*.json', or 'src/**/*.spec.ts'",
    maxLength: MAX_PATTERN_LENGTH
  }),
  path: Type.Optional(
    Type.String({ description: 'Directory to search in (default: current directory)' })
  ),
  limit: Type.Optional(
    Type.Number({ description: `Maximum results (default: ${FIND_DEFAULT_LIMIT}, max: ${FIND_MAX_LIMIT})` })
  ),
  includeIgnored: Type.Optional(
    Type.Boolean({ description: INCLUDE_IGNORED_DESCRIPTION })
  )
})

const lsSchema = Type.Object({
  path: Type.Optional(Type.String({ description: 'Directory to list (default: current directory)' })),
  limit: Type.Optional(
    Type.Number({ description: `Maximum entries (default: ${LS_DEFAULT_LIMIT}, max: ${LS_MAX_LIMIT})` })
  )
})

export interface OpenPipalGrepToolDetails {
  matchLimitReached?: number
  scanLimitReached?: number
  largeFilesSkipped?: number
  truncation?: TruncationResult
  linesTruncated?: boolean
  contextLimitApplied?: number
  requestedLimitApplied?: number
  workerResultLimitReached?: number
}

export interface OpenPipalFindToolDetails {
  resultLimitReached?: number
  scanLimitReached?: number
  truncation?: TruncationResult
  requestedLimitApplied?: number
  workerResultLimitReached?: number
}

export interface OpenPipalLsToolDetails {
  entryLimitReached?: number
  truncation?: TruncationResult
  requestedLimitApplied?: number
  workerResultLimitReached?: number
}

export interface OpenPipalSearchToolLimits {
  /** Hard traversal ceiling so malformed or enormous trees cannot monopolize the Agent. */
  maxTraversedEntries?: number
  /** Text files above this size are skipped rather than materialized. */
  maxGrepFileBytes?: number
  /** Wall-clock ceiling for the isolated search worker. */
  timeoutMs?: number
}

interface WorkerGrepLine {
  lineNumber: number
  text: string
  isMatch: boolean
}

interface WorkerGrepMatch {
  displayPath: string
  lineNumber: number
  lines: WorkerGrepLine[]
}

interface WorkerGrepResult {
  operation: 'grep'
  matches: WorkerGrepMatch[]
  matchLimitReached: boolean
  scanLimitReached: boolean
  largeFilesSkipped: number
  linesTruncated: boolean
  resultBudgetReached: boolean
}

interface WorkerFindResult {
  operation: 'find'
  matches: string[]
  resultLimitReached: boolean
  scanLimitReached: boolean
  resultBudgetReached: boolean
}

interface WorkerLsResult {
  operation: 'ls'
  entries: string[]
  entryLimitReached: boolean
  resultBudgetReached: boolean
}

type SearchWorkerResult = WorkerGrepResult | WorkerFindResult | WorkerLsResult

interface SearchWorkerRequest {
  operation: 'grep' | 'find' | 'ls'
  rootPath: string
  rootDisplayName: string
  pattern?: string
  glob?: string
  ignoreCase?: boolean
  literal?: boolean
  contextLines?: number
  limit: number
  /** 放开 .gitignore（见 grep 工具描述）。`.git` 与凭据的排除不受影响——那两条在 walk 里硬编码。 */
  includeIgnored?: boolean
  maxTraversedEntries: number
  maxGrepFileBytes: number
  maxLineLength: number
  maxResultChars: number
}

interface WorkerMessage {
  ok: boolean
  value?: SearchWorkerResult
  error?: { code?: string; message?: string }
}

interface QueuedWorkerLease {
  signal: AbortSignal | undefined
  resolve: (release: () => void) => void
  reject: (error: Error) => void
  onAbort: () => void
}

class SearchWorkerPool {
  private active = 0
  private readonly queue: QueuedWorkerLease[] = []

  constructor(
    private readonly maxActive: number,
    private readonly maxQueued: number
  ) {}

  acquire(signal: AbortSignal | undefined): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(new Error('Operation aborted'))
    if (this.active < this.maxActive) {
      this.active += 1
      return Promise.resolve(this.createRelease())
    }
    if (this.queue.length >= this.maxQueued) {
      return Promise.reject(new Error(
        `Search worker queue is full (${this.maxQueued} pending). Try again after another search finishes`
      ))
    }
    return new Promise<() => void>((resolve, reject) => {
      const entry: QueuedWorkerLease = {
        signal,
        resolve,
        reject,
        onAbort: () => {
          signal?.removeEventListener('abort', entry.onAbort)
          const index = this.queue.indexOf(entry)
          if (index >= 0) this.queue.splice(index, 1)
          reject(new Error('Operation aborted'))
        }
      }
      this.queue.push(entry)
      signal?.addEventListener('abort', entry.onAbort, { once: true })
      // Close the race between the first check and listener installation.
      if (signal?.aborted) entry.onAbort()
    })
  }

  snapshot(): { active: number; queued: number; maxActive: number; maxQueued: number } {
    return {
      active: this.active,
      queued: this.queue.length,
      maxActive: this.maxActive,
      maxQueued: this.maxQueued
    }
  }

  private createRelease(): () => void {
    let released = false
    return () => {
      if (released) return
      released = true
      this.active = Math.max(0, this.active - 1)
      this.drain()
    }
  }

  private drain(): void {
    while (this.active < this.maxActive && this.queue.length > 0) {
      const entry = this.queue.shift()!
      entry.signal?.removeEventListener('abort', entry.onAbort)
      if (entry.signal?.aborted) {
        entry.reject(new Error('Operation aborted'))
        continue
      }
      this.active += 1
      entry.resolve(this.createRelease())
    }
  }
}

const searchWorkerPool = new SearchWorkerPool(
  MAX_ACTIVE_SEARCH_WORKERS,
  MAX_QUEUED_SEARCH_WORKERS
)

/** Read-only process diagnostics used by health checks and concurrency tests. */
export function getOpenPipalSearchWorkerPoolSnapshot(): {
  active: number
  queued: number
  maxActive: number
  maxQueued: number
} {
  return searchWorkerPool.snapshot()
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error('Operation aborted')
}

function boundedPositiveInteger(
  value: number | undefined,
  fallback: number,
  maximum: number
): number {
  if (value === undefined || !Number.isFinite(value)) return fallback
  return Math.min(maximum, Math.max(1, Math.floor(value)))
}

function boundedNonNegativeInteger(value: number | undefined, maximum: number): number {
  if (value === undefined || !Number.isFinite(value)) return 0
  return Math.min(maximum, Math.max(0, Math.floor(value)))
}

function wasClamped(value: number | undefined, applied: number): boolean {
  return value !== undefined && Number.isFinite(value) && Math.floor(value) !== applied
}

function assertPatternLength(value: string, label: string): void {
  if (value.length > MAX_PATTERN_LENGTH) {
    throw new Error(`${label} exceeds the ${MAX_PATTERN_LENGTH} character limit`)
  }
}

async function resolveSearchRoot(
  context: ExecutionToolContext,
  requestedPath: string,
  signal: AbortSignal | undefined
): Promise<{ canonicalPath: string; displayName: string }> {
  throwIfAborted(signal)
  const result = await context.env.absolutePath(requestedPath, signal)
  if (!result.ok) {
    if (result.error.code === 'aborted') throw new Error('Operation aborted')
    throw new Error(`Cannot resolve path: ${requestedPath}. ${result.error.message}`)
  }
  throwIfAborted(signal)
  const canonical = await context.env.canonicalPath(result.value, signal)
  if (!canonical.ok) {
    if (canonical.error.code === 'aborted') throw new Error('Operation aborted')
    throw new Error(`Cannot resolve canonical path: ${requestedPath}. ${canonical.error.message}`)
  }
  throwIfAborted(signal)
  return {
    canonicalPath: canonical.value,
    displayName: path.basename(result.value)
  }
}

function appendNotices(output: string, notices: string[]): string {
  return notices.length > 0 ? `${output}\n\n[${notices.join('. ')}]` : output
}

const SEARCH_WORKER_SOURCE = String.raw`
'use strict'
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const readline = require('node:readline')
const { parentPort, workerData } = require('node:worker_threads')

const GREP_IGNORE_FILE_NAMES = ['.gitignore', '.ignore', '.rgignore']
const FIND_IGNORE_FILE_NAMES = ['.gitignore', '.ignore', '.fdignore']
const MAX_IGNORE_FILE_BYTES = 256 * 1024

function isHardDeniedCredentialName(name) {
  return /^\.env/i.test(name)
}

function toPosix(value) {
  return value.replace(/\\/g, '/')
}

function compareStable(left, right) {
  const foldedLeft = left.toLowerCase()
  const foldedRight = right.toLowerCase()
  if (foldedLeft < foldedRight) return -1
  if (foldedLeft > foldedRight) return 1
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

function compareGrepMatch(left, right) {
  const byPath = compareStable(left.displayPath, right.displayPath)
  return byPath !== 0 ? byPath : left.lineNumber - right.lineNumber
}

function keepBest(state, item, limit, compare, cost) {
  const items = state.items
  let low = 0
  let high = items.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (compare(items[middle], item) <= 0) low = middle + 1
    else high = middle
  }
  items.splice(low, 0, item)
  state.chars += cost(item)
  if (items.length > limit) {
    state.chars -= cost(items.pop())
  }
  while (state.chars > state.maxChars && items.length > 0) {
    state.budgetReached = true
    state.chars -= cost(items.pop())
  }
}

function createResultState(maxChars) {
  return { items: [], chars: 0, maxChars, budgetReached: false }
}

function grepMatchCost(match) {
  let total = match.displayPath.length + 32
  for (const line of match.lines) total += match.displayPath.length + line.text.length + 32
  return total
}

function prefixIgnorePattern(line, prefix) {
  const trimmed = line.trim()
  if (!trimmed || (trimmed.startsWith('#') && !trimmed.startsWith('\\#'))) return undefined
  let pattern = line
  let negated = false
  if (pattern.startsWith('!')) {
    negated = true
    pattern = pattern.slice(1)
  }
  const anchored = pattern.startsWith('/')
  if (anchored) pattern = pattern.slice(1)
  // A slashless pattern in a nested ignore file applies at every depth below
  // that directory. Prefixing it directly would accidentally anchor it to one
  // level, so preserve gitignore semantics with a zero-or-more globstar.
  const pathPart = pattern.endsWith('/') ? pattern.slice(0, -1) : pattern
  const nestedBasenamePattern = prefix && !anchored && !pathPart.includes('/')
  const prefixed = prefix
    ? prefix + (nestedBasenamePattern ? '**/' : '') + pattern
    : pattern
  return negated ? '!' + prefixed : prefixed
}

async function pathExists(candidate) {
  try {
    await fsp.lstat(candidate)
    return true
  } catch {
    return false
  }
}

async function findIgnoreRoot(searchRoot) {
  let cursor = searchRoot
  while (true) {
    if (await pathExists(path.join(cursor, '.git'))) return cursor
    const parent = path.dirname(cursor)
    if (parent === cursor) return searchRoot
    cursor = parent
  }
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino
}

function isPathWithin(rootPath, candidatePath) {
  const relative = path.relative(rootPath, candidatePath)
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))
}

async function readSmallFileSafely(filePath, allowedRoot, maxBytes) {
  let fileHandle
  try {
    const beforeStat = await fsp.lstat(filePath)
    const beforeCanonical = await fsp.realpath(filePath)
    if (!beforeStat.isFile() || !isPathWithin(allowedRoot, beforeCanonical)) return undefined
    const noFollow = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0
    fileHandle = await fsp.open(filePath, fs.constants.O_RDONLY | noFollow)
    const openedStat = await fileHandle.stat()
    const afterOpenStat = await fsp.lstat(filePath)
    const afterOpenCanonical = await fsp.realpath(filePath)
    if (
      !openedStat.isFile() ||
      openedStat.size > maxBytes ||
      !sameIdentity(beforeStat, openedStat) ||
      !sameIdentity(openedStat, afterOpenStat) ||
      beforeCanonical !== afterOpenCanonical ||
      !isPathWithin(allowedRoot, afterOpenCanonical)
    ) return undefined

    const bytes = Buffer.allocUnsafe(maxBytes + 1)
    let offset = 0
    while (offset <= maxBytes) {
      const result = await fileHandle.read(bytes, offset, maxBytes + 1 - offset, offset)
      if (result.bytesRead === 0) break
      offset += result.bytesRead
    }
    if (offset > maxBytes) return undefined

    const finalOpenedStat = await fileHandle.stat()
    const finalPathStat = await fsp.lstat(filePath)
    const finalCanonical = await fsp.realpath(filePath)
    if (
      finalOpenedStat.size > maxBytes ||
      !sameIdentity(openedStat, finalOpenedStat) ||
      !sameIdentity(finalOpenedStat, finalPathStat) ||
      finalCanonical !== beforeCanonical ||
      !isPathWithin(allowedRoot, finalCanonical)
    ) return undefined
    return bytes.subarray(0, offset).toString('utf8')
  } catch {
    return undefined
  } finally {
    await fileHandle?.close().catch(() => undefined)
  }
}

async function addIgnoreRules(matcher, directoryPath, ignoreRoot, ignoreFileNames) {
  const relativeDirectory = toPosix(path.relative(ignoreRoot, directoryPath))
  const prefix = relativeDirectory ? relativeDirectory + '/' : ''
  for (const filename of ignoreFileNames) {
    const ignorePath = path.join(directoryPath, filename)
    try {
      const content = await readSmallFileSafely(ignorePath, ignoreRoot, MAX_IGNORE_FILE_BYTES)
      if (content === undefined) continue
      for (const sourceLine of content.split(/\r?\n/)) {
        const pattern = prefixIgnorePattern(sourceLine, prefix)
        if (!pattern) continue
        try {
          matcher.add(pattern)
        } catch {
          // One malformed ignore line must not take down the whole search.
        }
      }
    } catch {
      // Missing/unreadable ignore files are equivalent to no local rules.
    }
  }
}

async function preloadAncestorIgnoreRules(matcher, ignoreRoot, searchRoot, ignoreFileNames) {
  const directories = []
  let cursor = searchRoot
  while (cursor !== ignoreRoot) {
    directories.unshift(cursor)
    const parent = path.dirname(cursor)
    if (parent === cursor) return
    cursor = parent
  }
  directories.unshift(ignoreRoot)
  for (const directory of directories.slice(0, -1)) {
    await addIgnoreRules(matcher, directory, ignoreRoot, ignoreFileNames)
  }
}

function statsKind(stats) {
  if (stats.isDirectory()) return 'directory'
  if (stats.isFile()) return 'file'
  if (stats.isSymbolicLink()) return 'symlink'
  return 'other'
}

async function* walkDescendants(
  searchRoot,
  ignoreRoot,
  matcher,
  state,
  directoryPath,
  required,
  ignoreFileNames
) {
  let beforeStat
  let beforeCanonical
  try {
    beforeStat = await fsp.lstat(directoryPath)
    beforeCanonical = await fsp.realpath(directoryPath)
    if (!beforeStat.isDirectory() || !isPathWithin(searchRoot, beforeCanonical)) {
      if (required) throw new Error('Search root is not a safe directory: ' + directoryPath)
      return
    }
  } catch (error) {
    if (required) throw error
    return
  }
  let directory
  try {
    directory = await fsp.opendir(directoryPath, { bufferSize: 32 })
    const afterOpenStat = await fsp.lstat(directoryPath)
    const afterOpenCanonical = await fsp.realpath(directoryPath)
    if (
      !afterOpenStat.isDirectory() ||
      !sameIdentity(beforeStat, afterOpenStat) ||
      beforeCanonical !== afterOpenCanonical ||
      !isPathWithin(searchRoot, afterOpenCanonical)
    ) {
      await directory.close().catch(() => undefined)
      if (required) throw new Error('Search directory changed while being opened: ' + directoryPath)
      return
    }
  } catch (error) {
    if (required) throw error
    return
  }
  await addIgnoreRules(matcher, directoryPath, ignoreRoot, ignoreFileNames)

  for await (const entry of directory) {
    if (state.traversedEntries >= state.maxTraversedEntries) {
      state.limitReached = true
      return
    }
    state.traversedEntries += 1
    if (entry.name === '.git' || isHardDeniedCredentialName(entry.name)) continue

    const absolutePath = path.join(directoryPath, entry.name)
    let entryStat
    let canonicalEntry
    try {
      entryStat = await fsp.lstat(absolutePath)
      canonicalEntry = await fsp.realpath(absolutePath)
      if (!isPathWithin(searchRoot, canonicalEntry)) continue
    } catch {
      continue
    }
    const kind = statsKind(entryStat)
    const relativePath = toPosix(path.relative(searchRoot, absolutePath))
    const ignoreRelativePath = toPosix(path.relative(ignoreRoot, absolutePath))
    const ignorePath = kind === 'directory' ? ignoreRelativePath + '/' : ignoreRelativePath
    if (matcher.ignores(ignorePath)) continue

    const value = { absolutePath, relativePath, name: entry.name, kind }
    yield value
    // Recursive symlinks are deliberately not followed. An explicitly selected
    // root symlink is resolved before traversal, so root file/dir symlinks work.
    if (kind === 'directory') {
      yield* walkDescendants(
        searchRoot,
        ignoreRoot,
        matcher,
        state,
        absolutePath,
        false,
        ignoreFileNames
      )
      if (state.limitReached) return
    }
  }
}

function createGlobMatcher(pattern) {
  if (pattern.length > workerData.request.maxPatternLength) {
    throw Object.assign(new Error('Glob pattern is too long'), { code: 'invalid_glob' })
  }
  const normalizedPattern = toPosix(pattern)
  const matchRelativePath = normalizedPattern.includes('/')
  try {
    // Validate eagerly so empty directories still report malformed patterns.
    path.posix.matchesGlob('', normalizedPattern)
  } catch (error) {
    throw Object.assign(new Error('Invalid glob pattern: ' + error.message), { code: 'invalid_glob' })
  }
  return (relativePath, basename) => {
    const candidate = matchRelativePath ? relativePath : basename
    return path.posix.matchesGlob(candidate, normalizedPattern)
  }
}

function compileGrepRegex(pattern, ignoreCase) {
  let source = pattern
  let caseInsensitive = ignoreCase
  // ripgrep accepts this common PCRE-style leading mode switch even without
  // PCRE2. Translate it only inside the isolated worker; arbitrary inline mode
  // groups remain unsupported and fail as normal JavaScript regex syntax.
  if (source.startsWith('(?i)')) {
    source = source.slice(4)
    caseInsensitive = true
  }
  return new RegExp(source, caseInsensitive ? 'i' : undefined)
}

function clippedLine(line, maxLineLength) {
  if (line.length <= maxLineLength) return { text: line, truncated: false }
  return {
    text: line.slice(0, maxLineLength) + '... [truncated]',
    truncated: true
  }
}

async function scanTextFile(filePath, displayPath, request, matchState, allowedRoot) {
  let fileHandle
  let initialStat
  let beforeStat
  let beforeCanonical
  try {
    beforeStat = await fsp.lstat(filePath)
    beforeCanonical = await fsp.realpath(filePath)
    if (!beforeStat.isFile() || !isPathWithin(allowedRoot, beforeCanonical)) {
      return { skippedLarge: false, linesTruncated: false, matchCount: 0 }
    }
    const noFollow = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0
    fileHandle = await fsp.open(filePath, fs.constants.O_RDONLY | noFollow)
    initialStat = await fileHandle.stat()
    const afterOpenStat = await fsp.lstat(filePath)
    const afterOpenCanonical = await fsp.realpath(filePath)
    if (
      !sameIdentity(beforeStat, initialStat) ||
      !sameIdentity(initialStat, afterOpenStat) ||
      beforeCanonical !== afterOpenCanonical ||
      !isPathWithin(allowedRoot, afterOpenCanonical)
    ) {
      await fileHandle.close().catch(() => undefined)
      return { skippedLarge: false, linesTruncated: false, matchCount: 0 }
    }
  } catch {
    await fileHandle?.close().catch(() => undefined)
    return { skippedLarge: false, linesTruncated: false, matchCount: 0 }
  }
  if (!initialStat.isFile()) {
    await fileHandle.close().catch(() => undefined)
    return { skippedLarge: false, linesTruncated: false, matchCount: 0 }
  }
  if (initialStat.size > request.maxGrepFileBytes) {
    await fileHandle.close().catch(() => undefined)
    return { skippedLarge: true, linesTruncated: false, matchCount: 0 }
  }

  const before = []
  const pending = []
  const fileMatches = createResultState(request.maxResultChars)
  let matchCount = 0
  let lineNumber = 0
  let binary = false
  let linesTruncated = false
  const stream = fileHandle.createReadStream({
    encoding: 'utf8',
    autoClose: false,
    start: 0,
    end: request.maxGrepFileBytes
  })
  const reader = readline.createInterface({ input: stream, crlfDelay: Infinity })
  let readFailed = false
  let finalStat = initialStat
  try {
    for await (const line of reader) {
      lineNumber += 1
      if (line.includes('\0')) {
        binary = true
        break
      }
      const clipped = clippedLine(line, request.maxLineLength)
      if (clipped.truncated) linesTruncated = true

      for (let index = pending.length - 1; index >= 0; index -= 1) {
        const item = pending[index]
        item.lines.push({ lineNumber, text: clipped.text, isMatch: false })
        item.remaining -= 1
        if (item.remaining === 0) {
          keepBest(fileMatches, item, request.limit, compareGrepMatch, grepMatchCost)
          pending.splice(index, 1)
        }
      }

      const candidate = request.ignoreCase && request.literal ? line.toLowerCase() : line
      const matchesLine = request.literal
        ? candidate.includes(request.literalPattern)
        : request.compiledRegex.test(line)
      if (matchesLine) {
        matchCount = Math.min(request.limit + 1, matchCount + 1)
        const item = {
          displayPath,
          lineNumber,
          lines: before.concat([{ lineNumber, text: clipped.text, isMatch: true }]),
          remaining: request.contextLines
        }
        if (item.remaining === 0) {
          keepBest(fileMatches, item, request.limit, compareGrepMatch, grepMatchCost)
        }
        else pending.push(item)
      }

      before.push({ lineNumber, text: clipped.text, isMatch: false })
      if (before.length > request.contextLines) before.shift()
    }
    // The descriptor is no-follow and pins the inode, so this also detects a
    // file that grew beyond the configured ceiling while it was being read.
    finalStat = await fileHandle.stat()
    const finalPathStat = await fsp.lstat(filePath)
    const finalCanonical = await fsp.realpath(filePath)
    if (
      !sameIdentity(initialStat, finalStat) ||
      !sameIdentity(finalStat, finalPathStat) ||
      finalCanonical !== beforeCanonical ||
      !isPathWithin(allowedRoot, finalCanonical)
    ) readFailed = true
  } catch {
    // Files can disappear or lose permissions during a repository scan. Match
    // the historical grep behavior by skipping that file, not the whole tree.
    readFailed = true
  } finally {
    reader.close()
    stream.destroy()
    await fileHandle.close().catch(() => undefined)
  }

  if (readFailed) return { skippedLarge: false, linesTruncated: false, matchCount: 0 }

  for (const item of pending) {
    keepBest(fileMatches, item, request.limit, compareGrepMatch, grepMatchCost)
  }
  if (binary) return { skippedLarge: false, linesTruncated: false, matchCount: 0 }
  if (finalStat.size > request.maxGrepFileBytes) {
    return { skippedLarge: true, linesTruncated: false, matchCount: 0 }
  }
  for (const match of fileMatches.items) {
    keepBest(matchState, match, request.limit, compareGrepMatch, grepMatchCost)
  }
  if (fileMatches.budgetReached) matchState.budgetReached = true
  return { skippedLarge: false, linesTruncated, matchCount }
}

async function runGrep(rootPath, rootStat, request) {
  if (request.pattern.length > workerData.request.maxPatternLength) {
    throw Object.assign(new Error('Search pattern is too long'), { code: 'invalid_pattern' })
  }
  // Compile before traversal so invalid expressions fail even for empty trees.
  if (!request.literal) {
    try {
      request.compiledRegex = compileGrepRegex(request.pattern, request.ignoreCase)
    } catch (error) {
      throw Object.assign(new Error('Invalid regular expression: ' + error.message), {
        code: 'invalid_regex'
      })
    }
  }
  request.literalPattern = request.ignoreCase && request.literal
    ? request.pattern.toLowerCase()
    : request.pattern
  const globMatcher = request.glob ? createGlobMatcher(request.glob) : undefined
  const matches = createResultState(request.maxResultChars)
  let matchCount = 0
  let largeFilesSkipped = 0
  let linesTruncated = false
  const state = {
    traversedEntries: 0,
    maxTraversedEntries: request.maxTraversedEntries,
    limitReached: false
  }

  if (rootStat.isFile()) {
    const displayName = request.rootDisplayName
    if (!globMatcher || globMatcher(displayName, displayName)) {
      const scanned = await scanTextFile(
        rootPath,
        displayName,
        request,
        matches,
        path.dirname(rootPath)
      )
      matchCount = scanned.matchCount
      if (scanned.skippedLarge) largeFilesSkipped += 1
      linesTruncated = scanned.linesTruncated
    }
  } else if (rootStat.isDirectory()) {
    const ignoreFactoryModule = require(workerData.ignoreModulePath)
    const ignoreFactory = ignoreFactoryModule.default || ignoreFactoryModule
    const matcher = ignoreFactory()
    const ignoreRoot = await findIgnoreRoot(rootPath)
    // includeIgnored 时不加载任何忽略文件——空规则集的 matcher 对谁都返回 false，
    // 不必在 walk 里再开一条分支。**.git 与 .env* 的排除不在这一层**：
    // 它们在 walkDescendants 里硬编码跳过（entry.name === '.git' 那一行），
    // 所以放开 .gitignore 动不到它们。
    // ignoreRoot 仍要算——walkDescendants 里的 ignoreRelativePath 依赖它。
    // 注意这一整块住在 worker 的模板字符串里，注释里**不能出现反引号**（会截断字符串）。
    const ignoreNames = request.includeIgnored ? [] : GREP_IGNORE_FILE_NAMES
    await preloadAncestorIgnoreRules(matcher, ignoreRoot, rootPath, ignoreNames)
    for await (const entry of walkDescendants(
      rootPath,
      ignoreRoot,
      matcher,
      state,
      rootPath,
      true,
      ignoreNames
    )) {
      if (entry.kind !== 'file') continue
      if (globMatcher && !globMatcher(entry.relativePath, entry.name)) continue
      const scanned = await scanTextFile(
        entry.absolutePath,
        entry.relativePath,
        request,
        matches,
        rootPath
      )
      matchCount = Math.min(request.limit + 1, matchCount + scanned.matchCount)
      if (scanned.skippedLarge) largeFilesSkipped += 1
      if (scanned.linesTruncated) linesTruncated = true
    }
  } else {
    throw Object.assign(new Error('Not a regular file or directory: ' + rootPath), {
      code: 'invalid_root'
    })
  }

  matches.items.sort(compareGrepMatch)
  return {
    operation: 'grep',
    matches: matches.items,
    matchLimitReached: matchCount >= request.limit,
    scanLimitReached: state.limitReached,
    largeFilesSkipped,
    linesTruncated,
    resultBudgetReached: matches.budgetReached
  }
}

async function runFind(rootPath, rootStat, request) {
  if (!rootStat.isDirectory()) {
    throw Object.assign(new Error('Not a directory: ' + rootPath), { code: 'not_directory' })
  }
  const matchesGlob = createGlobMatcher(request.pattern)
  const ignoreFactoryModule = require(workerData.ignoreModulePath)
  const ignoreFactory = ignoreFactoryModule.default || ignoreFactoryModule
  const matcher = ignoreFactory()
  const ignoreRoot = await findIgnoreRoot(rootPath)
  // includeIgnored 时不加载任何忽略文件——空规则集的 matcher 对谁都返回 false，
  // 不必在 walk 里再开一条分支。**.git 与 .env* 的排除不在这一层**：
  // 它们在 walkDescendants 里硬编码跳过（entry.name === '.git' 那一行），
  // 所以放开 .gitignore 动不到它们。
  const ignoreNames = request.includeIgnored ? [] : FIND_IGNORE_FILE_NAMES
  await preloadAncestorIgnoreRules(matcher, ignoreRoot, rootPath, ignoreNames)
  const state = {
    traversedEntries: 0,
    maxTraversedEntries: request.maxTraversedEntries,
    limitReached: false
  }
  const matches = createResultState(request.maxResultChars)
  let matchCount = 0
  for await (const entry of walkDescendants(
    rootPath,
    ignoreRoot,
    matcher,
    state,
    rootPath,
    true,
    ignoreNames
  )) {
    if (!matchesGlob(entry.relativePath, entry.name)) continue
    matchCount = Math.min(request.limit + 1, matchCount + 1)
    const display = entry.relativePath + (entry.kind === 'directory' ? '/' : '')
    keepBest(matches, display, request.limit, compareStable, value => value.length + 1)
  }
  matches.items.sort(compareStable)
  return {
    operation: 'find',
    matches: matches.items,
    resultLimitReached: matchCount >= request.limit,
    scanLimitReached: state.limitReached,
    resultBudgetReached: matches.budgetReached
  }
}

async function runLs(rootPath, rootStat, request) {
  if (!rootStat.isDirectory()) {
    throw Object.assign(new Error('Not a directory: ' + rootPath), { code: 'not_directory' })
  }
  const entries = createResultState(request.maxResultChars)
  let entryCount = 0
  const beforeStat = await fsp.lstat(rootPath)
  const beforeCanonical = await fsp.realpath(rootPath)
  const directory = await fsp.opendir(rootPath, { bufferSize: 32 })
  const afterOpenStat = await fsp.lstat(rootPath)
  const afterOpenCanonical = await fsp.realpath(rootPath)
  if (
    !sameIdentity(beforeStat, afterOpenStat) ||
    beforeCanonical !== afterOpenCanonical ||
    !isPathWithin(rootPath, afterOpenCanonical)
  ) {
    await directory.close().catch(() => undefined)
    throw new Error('List directory changed while being opened: ' + rootPath)
  }
  for await (const entry of directory) {
    if (isHardDeniedCredentialName(entry.name)) continue
    const entryPath = path.join(rootPath, entry.name)
    let entryStat
    try {
      entryStat = await fsp.lstat(entryPath)
      const canonicalEntry = await fsp.realpath(entryPath)
      if (!isPathWithin(rootPath, canonicalEntry)) continue
    } catch {
      continue
    }
    entryCount = Math.min(request.limit + 1, entryCount + 1)
    const display = entry.name + (entryStat.isDirectory() ? '/' : '')
    keepBest(entries, display, request.limit, compareStable, value => value.length + 1)
  }
  entries.items.sort(compareStable)
  return {
    operation: 'ls',
    entries: entries.items,
    entryLimitReached: entryCount >= request.limit,
    resultBudgetReached: entries.budgetReached
  }
}

async function run() {
  const request = workerData.request
  let rootPath
  let rootStat
  try {
    // The host already canonicalized an explicitly selected root symlink.
    // Re-check identity around worker startup so a replaced canonical target
    // fails closed before traversal.
    const beforeCanonical = await fsp.realpath(request.rootPath)
    const beforeStat = await fsp.lstat(beforeCanonical)
    const afterCanonical = await fsp.realpath(beforeCanonical)
    const afterStat = await fsp.lstat(beforeCanonical)
    if (
      beforeCanonical !== afterCanonical ||
      !sameIdentity(beforeStat, afterStat) ||
      (!afterStat.isFile() && !afterStat.isDirectory())
    ) throw new Error('Search root changed while being resolved')
    rootPath = afterCanonical
    rootStat = afterStat
  } catch (error) {
    throw Object.assign(new Error('Path not found: ' + request.rootPath), {
      code: error && error.code ? error.code : 'not_found'
    })
  }
  if (isHardDeniedCredentialName(path.basename(rootPath))) {
    throw Object.assign(new Error('Credential files are excluded from search'), {
      code: 'credential_path_denied'
    })
  }
  if (request.operation === 'grep') return runGrep(rootPath, rootStat, request)
  if (request.operation === 'find') return runFind(rootPath, rootStat, request)
  if (request.operation === 'ls') return runLs(rootPath, rootStat, request)
  throw Object.assign(new Error('Unknown search operation'), { code: 'invalid_operation' })
}

run().then(
  value => parentPort.postMessage({ ok: true, value }),
  error => parentPort.postMessage({
    ok: false,
    error: {
      code: error && error.code ? String(error.code) : 'search_failed',
      message: error && error.message ? String(error.message) : String(error)
    }
  })
)
`

async function runSearchWorker(
  request: SearchWorkerRequest,
  signal: AbortSignal | undefined,
  timeoutMs: number
): Promise<SearchWorkerResult> {
  throwIfAborted(signal)
  const releaseWorkerLease = await searchWorkerPool.acquire(signal)
  try {
    return await new Promise<SearchWorkerResult>((resolve, reject) => {
      const worker = new Worker(SEARCH_WORKER_SOURCE, {
        eval: true,
        workerData: {
          ignoreModulePath,
          request: { ...request, maxPatternLength: MAX_PATTERN_LENGTH }
        },
        resourceLimits: {
          maxOldGenerationSizeMb: WORKER_OLD_GENERATION_MB,
          maxYoungGenerationSizeMb: WORKER_YOUNG_GENERATION_MB,
          stackSizeMb: WORKER_STACK_MB
        }
      })
      let settled = false

      const cleanup = (): void => {
        clearTimeout(timeout)
        signal?.removeEventListener('abort', onAbort)
      }
      const fail = (error: Error): void => {
        if (settled) return
        settled = true
        cleanup()
        void worker.terminate().then(
          () => reject(error),
          () => reject(error)
        )
      }
      const succeed = (value: SearchWorkerResult): void => {
        if (settled) return
        settled = true
        cleanup()
        void worker.terminate().then(
          () => resolve(value),
          (error) => reject(new Error(`Search worker shutdown failed: ${error.message}`))
        )
      }
      const onAbort = (): void => fail(new Error('Operation aborted'))
      const timeout = setTimeout(() => {
        fail(new Error(`Search timed out after ${timeoutMs}ms`))
      }, timeoutMs)

      signal?.addEventListener('abort', onAbort, { once: true })
      worker.once('message', (message: WorkerMessage) => {
        if (settled) return
        if (!message.ok || !message.value) {
          fail(new Error(message.error?.message || 'Search worker failed'))
          return
        }
        succeed(message.value)
      })
      worker.once('error', (error) => fail(new Error(`Search worker failed: ${error.message}`)))
      worker.once('exit', (code) => {
        if (!settled) fail(new Error(`Search worker exited before returning a result (code ${code})`))
      })
      // Close the small race between the pre-spawn check and listener install.
      if (signal?.aborted) onAbort()
    })
  } finally {
    releaseWorkerLease()
  }
}

function resolveLimits(limits: OpenPipalSearchToolLimits): {
  maxTraversedEntries: number
  maxGrepFileBytes: number
  timeoutMs: number
} {
  return {
    maxTraversedEntries: boundedPositiveInteger(
      limits.maxTraversedEntries,
      DEFAULT_MAX_TRAVERSED_ENTRIES,
      ABSOLUTE_MAX_TRAVERSED_ENTRIES
    ),
    maxGrepFileBytes: boundedPositiveInteger(
      limits.maxGrepFileBytes,
      DEFAULT_MAX_GREP_FILE_BYTES,
      ABSOLUTE_MAX_GREP_FILE_BYTES
    ),
    timeoutMs: boundedPositiveInteger(
      limits.timeoutMs,
      DEFAULT_SEARCH_TIMEOUT_MS,
      ABSOLUTE_MAX_SEARCH_TIMEOUT_MS
    )
  }
}

export function createOpenPipalGrepTool<
  TContext extends ExecutionToolContext = ExecutionToolContext
>(limits: OpenPipalSearchToolLimits = {}): AgentHarnessTool<TContext, typeof grepSchema, OpenPipalGrepToolDetails | undefined> {
  const resolvedLimits = resolveLimits(limits)
  return {
    name: 'grep',
    label: 'grep',
    description: `Search file contents in an isolated, bounded worker. Respects .gitignore, .ignore, and .rgignore by default — set includeIgnored to also search dependencies and build output. Output is truncated to ${GREP_DEFAULT_LIMIT} matches or ${DEFAULT_MAX_BYTES / 1024}KB. Long lines are truncated to ${GREP_MAX_LINE_LENGTH} chars.`,
    parameters: grepSchema,
    async execute(
      _toolCallId,
      {
        pattern,
        path: requestedPath,
        glob,
        ignoreCase = false,
        literal = false,
        context: requestedContext,
        limit: requestedLimit,
        includeIgnored = false
      },
      signal,
      _onUpdate,
      context
    ) {
      assertPatternLength(pattern, 'Search pattern')
      if (glob) assertPatternLength(glob, 'Glob pattern')
      const searchRoot = await resolveSearchRoot(context, requestedPath || '.', signal)
      const effectiveLimit = boundedPositiveInteger(
        requestedLimit,
        GREP_DEFAULT_LIMIT,
        GREP_MAX_LIMIT
      )
      const contextLines = boundedNonNegativeInteger(requestedContext, MAX_CONTEXT_LINES)
      const result = await runSearchWorker({
        operation: 'grep',
        rootPath: searchRoot.canonicalPath,
        rootDisplayName: searchRoot.displayName,
        pattern,
        glob,
        ignoreCase,
        literal,
        contextLines,
        limit: effectiveLimit,
        includeIgnored,
        maxTraversedEntries: resolvedLimits.maxTraversedEntries,
        maxGrepFileBytes: resolvedLimits.maxGrepFileBytes,
        maxLineLength: GREP_MAX_LINE_LENGTH,
        maxResultChars: MAX_WORKER_RESULT_CHARS
      }, signal, resolvedLimits.timeoutMs)
      if (result.operation !== 'grep') throw new Error('Search worker returned an invalid result')

      const details: OpenPipalGrepToolDetails = {}
      const notices: string[] = []
      if (result.matchLimitReached) {
        details.matchLimitReached = effectiveLimit
        notices.push(`${effectiveLimit} matches limit reached. Refine the pattern for more precision`)
      }
      if (result.scanLimitReached) {
        details.scanLimitReached = resolvedLimits.maxTraversedEntries
        notices.push(`${resolvedLimits.maxTraversedEntries} scanned entries limit reached. Narrow the path`)
      }
      if (result.largeFilesSkipped > 0) {
        details.largeFilesSkipped = result.largeFilesSkipped
        notices.push(`${result.largeFilesSkipped} files over ${formatSize(resolvedLimits.maxGrepFileBytes)} skipped`)
      }
      if (result.linesTruncated) {
        details.linesTruncated = true
        notices.push(`Some lines truncated to ${GREP_MAX_LINE_LENGTH} chars. Use read to see full lines`)
      }
      if (result.resultBudgetReached) {
        details.workerResultLimitReached = MAX_WORKER_RESULT_CHARS
        notices.push('Isolated search result budget reached. Refine the pattern')
      }
      if (wasClamped(requestedContext, contextLines)) {
        details.contextLimitApplied = contextLines
        notices.push(`Context clamped to ${contextLines} lines`)
      }
      if (wasClamped(requestedLimit, effectiveLimit)) {
        details.requestedLimitApplied = effectiveLimit
        notices.push(`Result limit clamped to ${effectiveLimit}`)
      }

      if (result.matches.length === 0) {
        return {
          content: [{ type: 'text', text: appendNotices('No matches found', notices) }],
          details: Object.keys(details).length > 0 ? details : undefined
        }
      }

      const outputLines: string[] = []
      for (const match of result.matches) {
        for (const line of match.lines) {
          const separator = line.isMatch ? ':' : '-'
          outputLines.push(`${match.displayPath}${separator}${line.lineNumber}${separator} ${line.text}`)
        }
      }
      const truncation = truncateHead(outputLines.join('\n'), {
        maxLines: Number.MAX_SAFE_INTEGER
      })
      if (truncation.truncated) {
        details.truncation = truncation
        notices.push(`${formatSize(DEFAULT_MAX_BYTES)} output limit reached`)
      }
      return {
        content: [{ type: 'text', text: appendNotices(truncation.content, notices) }],
        details: Object.keys(details).length > 0 ? details : undefined
      }
    }
  }
}

export function createOpenPipalFindTool<
  TContext extends ExecutionToolContext = ExecutionToolContext
>(limits: Pick<OpenPipalSearchToolLimits, 'maxTraversedEntries' | 'timeoutMs'> = {}): AgentHarnessTool<TContext, typeof findSchema, OpenPipalFindToolDetails | undefined> {
  const resolvedLimits = resolveLimits(limits)
  return {
    name: 'find',
    label: 'find',
    description: `Search file names in an isolated, bounded worker. Respects .gitignore, .ignore, and .fdignore by default — set includeIgnored to also search dependencies and build output. Output is truncated to ${FIND_DEFAULT_LIMIT} results or ${DEFAULT_MAX_BYTES / 1024}KB.`,
    parameters: findSchema,
    async execute(
      _toolCallId,
      { pattern, path: requestedPath, limit: requestedLimit, includeIgnored = false },
      signal,
      _onUpdate,
      context
    ) {
      assertPatternLength(pattern, 'Glob pattern')
      const searchRoot = await resolveSearchRoot(context, requestedPath || '.', signal)
      const effectiveLimit = boundedPositiveInteger(
        requestedLimit,
        FIND_DEFAULT_LIMIT,
        FIND_MAX_LIMIT
      )
      const result = await runSearchWorker({
        operation: 'find',
        rootPath: searchRoot.canonicalPath,
        rootDisplayName: searchRoot.displayName,
        pattern,
        limit: effectiveLimit,
        includeIgnored,
        maxTraversedEntries: resolvedLimits.maxTraversedEntries,
        maxGrepFileBytes: resolvedLimits.maxGrepFileBytes,
        maxLineLength: GREP_MAX_LINE_LENGTH,
        maxResultChars: MAX_WORKER_RESULT_CHARS
      }, signal, resolvedLimits.timeoutMs)
      if (result.operation !== 'find') throw new Error('Search worker returned an invalid result')

      const details: OpenPipalFindToolDetails = {}
      const notices: string[] = []
      if (result.resultLimitReached) {
        details.resultLimitReached = effectiveLimit
        notices.push(`${effectiveLimit} results limit reached. Refine the pattern for more precision`)
      }
      if (result.scanLimitReached) {
        details.scanLimitReached = resolvedLimits.maxTraversedEntries
        notices.push(`${resolvedLimits.maxTraversedEntries} scanned entries limit reached. Narrow the path`)
      }
      if (result.resultBudgetReached) {
        details.workerResultLimitReached = MAX_WORKER_RESULT_CHARS
        notices.push('Isolated search result budget reached. Refine the pattern')
      }
      if (wasClamped(requestedLimit, effectiveLimit)) {
        details.requestedLimitApplied = effectiveLimit
        notices.push(`Result limit clamped to ${effectiveLimit}`)
      }

      if (result.matches.length === 0) {
        return {
          content: [{ type: 'text', text: appendNotices('No files found matching pattern', notices) }],
          details: Object.keys(details).length > 0 ? details : undefined
        }
      }
      const truncation = truncateHead(result.matches.join('\n'), {
        maxLines: Number.MAX_SAFE_INTEGER
      })
      if (truncation.truncated) {
        details.truncation = truncation
        notices.push(`${formatSize(DEFAULT_MAX_BYTES)} output limit reached`)
      }
      return {
        content: [{ type: 'text', text: appendNotices(truncation.content, notices) }],
        details: Object.keys(details).length > 0 ? details : undefined
      }
    }
  }
}

export function createOpenPipalLsTool<
  TContext extends ExecutionToolContext = ExecutionToolContext
>(limits: Pick<OpenPipalSearchToolLimits, 'timeoutMs'> = {}): AgentHarnessTool<TContext, typeof lsSchema, OpenPipalLsToolDetails | undefined> {
  const resolvedLimits = resolveLimits(limits)
  return {
    name: 'ls',
    label: 'ls',
    description: `List a directory in an isolated, bounded worker. Results are stable and capped at ${LS_MAX_LIMIT} entries.`,
    parameters: lsSchema,
    async execute(
      _toolCallId,
      { path: requestedPath, limit: requestedLimit },
      signal,
      _onUpdate,
      context
    ) {
      const searchRoot = await resolveSearchRoot(context, requestedPath || '.', signal)
      const effectiveLimit = boundedPositiveInteger(requestedLimit, LS_DEFAULT_LIMIT, LS_MAX_LIMIT)
      const result = await runSearchWorker({
        operation: 'ls',
        rootPath: searchRoot.canonicalPath,
        rootDisplayName: searchRoot.displayName,
        limit: effectiveLimit,
        maxTraversedEntries: resolvedLimits.maxTraversedEntries,
        maxGrepFileBytes: resolvedLimits.maxGrepFileBytes,
        maxLineLength: GREP_MAX_LINE_LENGTH,
        maxResultChars: MAX_WORKER_RESULT_CHARS
      }, signal, resolvedLimits.timeoutMs)
      if (result.operation !== 'ls') throw new Error('Search worker returned an invalid result')
      if (result.entries.length === 0) {
        return { content: [{ type: 'text', text: '(empty directory)' }], details: undefined }
      }

      const details: OpenPipalLsToolDetails = {}
      const notices: string[] = []
      if (result.entryLimitReached) {
        details.entryLimitReached = effectiveLimit
        notices.push(`${effectiveLimit} entries limit reached`)
      }
      if (result.resultBudgetReached) {
        details.workerResultLimitReached = MAX_WORKER_RESULT_CHARS
        notices.push('Isolated listing result budget reached. Narrow the directory')
      }
      if (wasClamped(requestedLimit, effectiveLimit)) {
        details.requestedLimitApplied = effectiveLimit
        notices.push(`Result limit clamped to ${effectiveLimit}`)
      }
      const truncation = truncateHead(result.entries.join('\n'), {
        maxLines: Number.MAX_SAFE_INTEGER
      })
      if (truncation.truncated) {
        details.truncation = truncation
        notices.push(`${formatSize(DEFAULT_MAX_BYTES)} output limit reached`)
      }
      return {
        content: [{ type: 'text', text: appendNotices(truncation.content, notices) }],
        details: Object.keys(details).length > 0 ? details : undefined
      }
    }
  }
}
