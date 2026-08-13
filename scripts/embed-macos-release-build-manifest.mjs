import { execFileSync, spawnSync } from 'node:child_process'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { constants as fsConstants, lstatSync, readFileSync, realpathSync } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { TextDecoder } from 'node:util'
import { fileURLToPath } from 'node:url'
import { Arch } from 'electron-builder'

const POLICY_PATH = 'config/macos-release-policy.json'
const RELEASE_CONFIG_PATH = 'electron-builder.release.yml'
const BASE_CONFIG_PATH = 'electron-builder.yml'
const HOOK_CANDIDATE_PATH = 'scripts/embed-macos-release-build-manifest.mjs'
const HOOK_PATH = fileURLToPath(import.meta.url)
const BUILD_MANIFEST_PATH = 'Contents/Resources/openpipal-release-build.json'
const FULL_COMMIT = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u
const MAX_POLICY_BYTES = 256 * 1024
const MAX_BUILD_MANIFEST_BYTES = 64 * 1024

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0
}

function sha256(content) {
  return createHash('sha256').update(content).digest('hex')
}

function git(repo, args, encoding = 'utf8') {
  try {
    return execFileSync('/usr/bin/git', args, {
      cwd: repo,
      encoding,
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch {
    throw new Error('RELEASE_CANDIDATE_GIT_FAILED')
  }
}

function gitSucceeds(repo, args) {
  const result = spawnSync('/usr/bin/git', args, {
    cwd: repo,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return result.status === 0
}

function assertNoDuplicateJsonKeys(text) {
  let index = 0
  const skipWhitespace = () => {
    while (index < text.length && /\s/u.test(text[index])) index += 1
  }
  const parseString = () => {
    if (text[index] !== '"') throw new Error('invalid-json-string')
    const start = index
    index += 1
    while (index < text.length) {
      if (text[index] === '"') {
        index += 1
        return JSON.parse(text.slice(start, index))
      }
      if (text[index] === '\\') index += 1
      index += 1
    }
    throw new Error('unterminated-json-string')
  }
  const parseValue = () => {
    skipWhitespace()
    if (text[index] === '{') {
      index += 1
      skipWhitespace()
      const keys = new Set()
      if (text[index] === '}') {
        index += 1
        return
      }
      while (index < text.length) {
        skipWhitespace()
        const key = parseString()
        if (keys.has(key)) throw new Error('duplicate-json-key')
        keys.add(key)
        skipWhitespace()
        if (text[index] !== ':') throw new Error('missing-json-colon')
        index += 1
        parseValue()
        skipWhitespace()
        if (text[index] === '}') {
          index += 1
          return
        }
        if (text[index] !== ',') throw new Error('missing-json-comma')
        index += 1
      }
      throw new Error('unterminated-json-object')
    }
    if (text[index] === '[') {
      index += 1
      skipWhitespace()
      if (text[index] === ']') {
        index += 1
        return
      }
      while (index < text.length) {
        parseValue()
        skipWhitespace()
        if (text[index] === ']') {
          index += 1
          return
        }
        if (text[index] !== ',') throw new Error('missing-json-comma')
        index += 1
      }
      throw new Error('unterminated-json-array')
    }
    if (text[index] === '"') {
      parseString()
      return
    }
    const scalar = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/u.exec(
      text.slice(index),
    )
    if (!scalar) throw new Error('invalid-json-value')
    index += scalar[0].length
  }
  parseValue()
  skipWhitespace()
  if (index !== text.length) throw new Error('trailing-json-data')
}

function parseCandidateJson(raw, code) {
  try {
    if (!Buffer.isBuffer(raw) || raw.length > MAX_POLICY_BYTES) throw new Error('invalid-size')
    const text = new TextDecoder('utf-8', { fatal: true }).decode(raw)
    assertNoDuplicateJsonKeys(text)
    return JSON.parse(text)
  } catch {
    throw new Error(code)
  }
}

function normalizeCandidatePath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\\')) {
    throw new Error('RELEASE_POLICY_SOURCE_PATH_INVALID')
  }
  if (path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) {
    throw new Error('RELEASE_POLICY_SOURCE_PATH_INVALID')
  }
  const normalized = path.posix.normalize(value)
  if (normalized !== value || normalized === '..' || normalized.startsWith('../')) {
    throw new Error('RELEASE_POLICY_SOURCE_PATH_INVALID')
  }
  return value
}

function readCandidateBlob(repo, candidate, candidatePath) {
  normalizeCandidatePath(candidatePath)
  return git(repo, ['show', `${candidate}^{commit}:${candidatePath}`], null)
}

function resolveCandidate(repo, candidate) {
  const resolved = git(repo, ['rev-parse', '--verify', `${candidate}^{commit}`]).trim()
  if (resolved !== candidate) throw new Error('RELEASE_CANDIDATE_NOT_EXACT')
  const tree = git(repo, ['rev-parse', `${candidate}^{tree}`]).trim()
  const output = git(repo, ['ls-tree', '-r', '-l', `${candidate}^{commit}`])
  const entries = output.length === 0
    ? []
    : output.replace(/\n$/u, '').split('\n').map(line => {
      const tab = line.indexOf('\t')
      const metadata = tab === -1 ? '' : line.slice(0, tab)
      const candidatePath = tab === -1 ? '' : line.slice(tab + 1)
      const match = /^(\d{6}) (blob|tree) ([0-9a-f]+)\s+(-|\d+)$/u.exec(metadata)
      if (!match || match[2] !== 'blob' || !candidatePath || candidatePath.startsWith('"')) {
        throw new Error('RELEASE_CANDIDATE_TREE_INVALID')
      }
      return { mode: match[1], objectId: match[3], size: Number(match[4]), path: candidatePath }
    })
  const canonical = entries
    .filter(entry => entry.path !== POLICY_PATH)
    .sort((left, right) => compareText(left.path, right.path))
    .map(entry => `${entry.mode} ${entry.objectId} ${entry.size}\t${entry.path}\n`)
    .join('')
  return { tree, contentSha256: sha256(canonical) }
}

function assertCleanCandidateCheckout(repo, candidate) {
  // These are binding snapshots, not a substitute for an external runner that excludes
  // untrusted same-UID writers for the full build and verification interval.
  if (!path.isAbsolute(repo)) throw new Error('RELEASE_REPO_NOT_ABSOLUTE')
  const topLevel = realpathSync(git(repo, ['rev-parse', '--show-toplevel']).trim())
  if (topLevel !== realpathSync(repo)) throw new Error('RELEASE_REPO_ROOT_MISMATCH')
  const head = git(repo, ['rev-parse', '--verify', 'HEAD^{commit}']).trim()
  if (head !== candidate) throw new Error('RELEASE_CANDIDATE_HEAD_MISMATCH')
  if (
    !gitSucceeds(repo, ['diff', '--quiet', '--exit-code', '--'])
    || !gitSucceeds(repo, ['diff', '--cached', '--quiet', '--exit-code', '--'])
  ) {
    throw new Error('RELEASE_CANDIDATE_TRACKED_DIRTY')
  }
  const untracked = git(repo, ['ls-files', '--others', '--exclude-standard', '-z'], null)
  if (untracked.length !== 0) throw new Error('RELEASE_CANDIDATE_UNTRACKED_DIRTY')
}

function architectureForBuilderArch(builderArch) {
  const name = Arch[builderArch]
  if (name === 'arm64') return 'arm64'
  if (name === 'x64') return 'x86_64'
  throw new Error('RELEASE_ARCHITECTURE_UNSUPPORTED')
}

function validateCandidatePolicy(policy) {
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) {
    throw new Error('RELEASE_POLICY_INVALID')
  }
  if (
    policy.schemaVersion !== 1
    || policy.buildManifestPath !== BUILD_MANIFEST_PATH
    || policy.app?.name !== 'OpenPipal.app'
    || !Array.isArray(policy.sourcePaths)
  ) {
    throw new Error('RELEASE_POLICY_INVALID')
  }
  const sourcePaths = policy.sourcePaths.map(normalizeCandidatePath)
  if (new Set(sourcePaths).size !== sourcePaths.length) {
    throw new Error('RELEASE_POLICY_SOURCE_PATH_INVALID')
  }
  for (const required of [
    POLICY_PATH,
    RELEASE_CONFIG_PATH,
    BASE_CONFIG_PATH,
    HOOK_CANDIDATE_PATH,
    'package.json',
    'package-lock.json',
    'scripts/generate-third-party-inventory.mjs',
    'scripts/verify-macos-release.mjs',
  ]) {
    if (!sourcePaths.includes(required)) throw new Error('RELEASE_POLICY_SOURCE_PATH_INVALID')
  }
  return { ...policy, sourcePaths }
}

export function createReleaseBuildManifest({ architecture, candidate, repo }) {
  if (!['arm64', 'x86_64'].includes(architecture)) {
    throw new Error('RELEASE_ARCHITECTURE_UNSUPPORTED')
  }
  if (typeof candidate !== 'string' || candidate.trim() !== candidate || !FULL_COMMIT.test(candidate)) {
    throw new Error('RELEASE_CANDIDATE_NOT_EXACT')
  }
  assertCleanCandidateCheckout(repo, candidate)
  const candidateFacts = resolveCandidate(repo, candidate)
  const policyRaw = readCandidateBlob(repo, candidate, POLICY_PATH)
  const policy = validateCandidatePolicy(parseCandidateJson(policyRaw, 'RELEASE_POLICY_INVALID'))
  const candidateHook = readCandidateBlob(repo, candidate, HOOK_CANDIDATE_PATH)
  const runningHookMetadata = lstatSync(HOOK_PATH)
  if (runningHookMetadata.isSymbolicLink() || !runningHookMetadata.isFile()) {
    throw new Error('RELEASE_BUILD_HOOK_NOT_REGULAR')
  }
  const runningHook = readFileSync(HOOK_PATH)
  if (!Buffer.from(candidateHook).equals(Buffer.from(runningHook))) {
    throw new Error('RELEASE_BUILD_HOOK_NOT_FROM_CANDIDATE')
  }
  const sourceSha256 = Object.fromEntries(policy.sourcePaths.map(candidatePath => [
    candidatePath,
    sha256(candidatePath === POLICY_PATH
      ? policyRaw
      : readCandidateBlob(repo, candidate, candidatePath)),
  ]))
  const manifest = {
    schemaVersion: 1,
    candidateCommit: candidate,
    candidateTree: candidateFacts.tree,
    candidateContentSha256: candidateFacts.contentSha256,
    architecture,
    sourceSha256,
  }
  const rendered = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`)
  if (rendered.length > MAX_BUILD_MANIFEST_BYTES) {
    throw new Error('RELEASE_BUILD_MANIFEST_TOO_LARGE')
  }
  assertCleanCandidateCheckout(repo, candidate)
  return { manifest, policy, rendered }
}

async function assertDirectory(directory, code) {
  const metadata = await lstat(directory)
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new Error(code)
}

export async function writeReleaseBuildManifest(context, environment = process.env) {
  if (context?.electronPlatformName !== 'darwin') throw new Error('RELEASE_PLATFORM_UNSUPPORTED')
  const repo = context?.packager?.projectDir
  const appOutDir = context?.appOutDir
  if (typeof repo !== 'string' || !path.isAbsolute(repo) || typeof appOutDir !== 'string' || !path.isAbsolute(appOutDir)) {
    throw new Error('RELEASE_BUILDER_CONTEXT_INVALID')
  }
  if (context.packager?.appInfo?.productFilename !== 'OpenPipal') {
    throw new Error('RELEASE_PRODUCT_NAME_MISMATCH')
  }
  const candidate = environment?.OPENPIPAL_RELEASE_CANDIDATE
  const architecture = architectureForBuilderArch(context.arch)
  const { policy, rendered } = createReleaseBuildManifest({ architecture, candidate, repo })
  const appPath = path.join(appOutDir, policy.app.name)
  const contentsPath = path.join(appPath, 'Contents')
  const resourcesPath = path.join(contentsPath, 'Resources')
  await assertDirectory(appPath, 'RELEASE_APP_BUNDLE_INVALID')
  await assertDirectory(contentsPath, 'RELEASE_CONTENTS_DIRECTORY_INVALID')
  await assertDirectory(resourcesPath, 'RELEASE_RESOURCES_DIRECTORY_INVALID')
  const canonicalAppOut = await realpath(appOutDir)
  const canonicalApp = await realpath(appPath)
  const canonicalContents = await realpath(contentsPath)
  const canonicalResources = await realpath(resourcesPath)
  if (
    canonicalApp !== path.join(canonicalAppOut, policy.app.name)
    || canonicalContents !== path.join(canonicalApp, 'Contents')
    || canonicalResources !== path.join(canonicalContents, 'Resources')
  ) {
    throw new Error('RELEASE_APP_BUNDLE_PATH_INVALID')
  }
  const manifestPath = path.join(appPath, ...policy.buildManifestPath.split('/'))
  if (path.dirname(manifestPath) !== resourcesPath) {
    throw new Error('RELEASE_BUILD_MANIFEST_PATH_INVALID')
  }
  const handle = await open(
    manifestPath,
    fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
    0o644,
  )
  try {
    await handle.chmod(0o644)
    await handle.writeFile(rendered)
    await handle.sync()
    const descriptor = await handle.stat()
    const pathMetadata = await lstat(manifestPath)
    if (
      !descriptor.isFile()
      || pathMetadata.isSymbolicLink()
      || !pathMetadata.isFile()
      || descriptor.dev !== pathMetadata.dev
      || descriptor.ino !== pathMetadata.ino
      || descriptor.size !== rendered.length
    ) {
      throw new Error('RELEASE_BUILD_MANIFEST_WRITE_MISMATCH')
    }
    const written = Buffer.alloc(rendered.length)
    const { bytesRead } = await handle.read(written, 0, written.length, 0)
    if (bytesRead !== written.length || !written.equals(rendered)) {
      throw new Error('RELEASE_BUILD_MANIFEST_WRITE_MISMATCH')
    }
  } finally {
    await handle.close()
  }
  assertCleanCandidateCheckout(repo, candidate)
  return manifestPath
}

export async function afterPack(context) {
  await writeReleaseBuildManifest(context)
}
