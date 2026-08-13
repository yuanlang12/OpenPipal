#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process'
import { Buffer } from 'node:buffer'
import { createHash, createPublicKey, verify as verifyCryptoSignature } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import { chmod, lstat, mkdir, mkdtemp, open, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { TextDecoder } from 'node:util'
import { fileURLToPath, pathToFileURL, URL } from 'node:url'

const SCRIPT_PATH = fileURLToPath(import.meta.url)
const SCRIPT_CANDIDATE_PATH = 'scripts/verify-macos-release.mjs'
const INVENTORY_SCRIPT_PATH = fileURLToPath(new URL('./generate-third-party-inventory.mjs', import.meta.url))
const INVENTORY_SCRIPT_CANDIDATE_PATH = 'scripts/generate-third-party-inventory.mjs'
const BUILD_MANIFEST_HOOK_PATH = fileURLToPath(new URL('./embed-macos-release-build-manifest.mjs', import.meta.url))
const BUILD_MANIFEST_HOOK_CANDIDATE_PATH = 'scripts/embed-macos-release-build-manifest.mjs'
const BUILD_MANIFEST_PATH = 'Contents/Resources/openpipal-release-build.json'
const RELEASE_BUILDER_CONFIG_PATH = 'electron-builder.release.yml'
const POLICY_PATH = 'config/macos-release-policy.json'
const FULL_COMMIT = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u
const SHA256 = /^[0-9a-f]{64}$/u
const TEAM_IDENTIFIER = /^[A-Z0-9]{10}$/u
const TRUST_POLICY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u
const ARCHITECTURES = ['arm64', 'x86_64']
const MAX_ERROR_PATHS = 20
const MAX_MANUAL_EVIDENCE_BYTES = 256 * 1024
const MAX_TRUST_BUNDLE_BYTES = 64 * 1024
const MAX_BUILD_MANIFEST_BYTES = 64 * 1024
const MAX_BUILD_MANIFEST_HOOK_BYTES = 512 * 1024
const TRUST_BUNDLE_DOMAIN = 'openpipal.macos-release.trust.v1'
const MANUAL_SIGNATURE_DOMAIN = 'openpipal.macos-release.manual-evidence.v1'
const MANDATORY_MANUAL_CHECK_IDS = [
  'ARM64_HARDWARE_FLOW',
  'DESIGN_ARTIFACT',
  'DMG_CONTAINED_APP_MATCH',
  'FRESH_INSTALL_AND_FIRST_LAUNCH',
  'LOCALIZED_PRIVACY_PROMPTS_EN',
  'LOCALIZED_PRIVACY_PROMPTS_ZH_HANS',
  'NATIVE_IMAGE_CANVAS_ESBUILD',
  'PHOTON_WASM',
  'RUNTIME_CHAT',
  'TCC_ACCESSIBILITY',
  'TCC_APPLE_EVENTS_FOCUS_PASTE',
  'TCC_CAMERA',
  'TCC_EXTERNAL_WINDOW_SCREEN_RECORDING',
  'TCC_LOCATION',
  'TCC_MICROPHONE',
  'X86_64_HARDWARE_FLOW',
]

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0
}

function sha256(content) {
  return createHash('sha256').update(content).digest('hex')
}

function stableObject(value) {
  if (Array.isArray(value)) return value.map(stableObject)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => compareText(left, right))
      .map(([key, child]) => [key, stableObject(child)]),
  )
}

function sameJson(left, right) {
  return JSON.stringify(stableObject(left)) === JSON.stringify(stableObject(right))
}

function assertNoDuplicateJsonKeys(text) {
  let index = 0
  const whitespace = /\s/u
  const skipWhitespace = () => {
    while (index < text.length && whitespace.test(text[index])) index += 1
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
    const scalar = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/u.exec(text.slice(index))
    if (!scalar) throw new Error('invalid-json-value')
    index += scalar[0].length
  }
  parseValue()
  skipWhitespace()
  if (index !== text.length) throw new Error('trailing-json-data')
}

function parseJson(content, code) {
  try {
    const text = Buffer.isBuffer(content) ? content.toString('utf8') : content
    assertNoDuplicateJsonKeys(text)
    return JSON.parse(text)
  } catch {
    throw new Error(code)
  }
}

function normalizeCandidatePath(value, label = 'path') {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\\')) {
    throw new Error(`INVALID_${label.toUpperCase()}`)
  }
  if (path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) {
    throw new Error(`INVALID_${label.toUpperCase()}`)
  }
  const normalized = path.posix.normalize(value)
  if (normalized !== value || normalized === '..' || normalized.startsWith('../')) {
    throw new Error(`INVALID_${label.toUpperCase()}`)
  }
  return value
}

function sortedUniqueStrings(value) {
  if (!Array.isArray(value) || value.some(entry => typeof entry !== 'string' || !entry)) {
    return null
  }
  const sorted = [...new Set(value)].sort(compareText)
  return sorted.length === value.length ? sorted : null
}

function isPending(value) {
  if (typeof value !== 'string') return true
  const normalized = value.trim()
  return normalized === '' || normalized === 'PENDING'
}

function normalizedApprovalIdentity(value) {
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  if (normalized === '' || normalized === 'PENDING' || normalized !== value) return null
  return normalized
}

function decodeCanonicalBase64(value) {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length % 4 !== 0
    || !/^[A-Za-z0-9+/]+={0,2}$/u.test(value)
  ) {
    return null
  }
  const decoded = Buffer.from(value, 'base64')
  return decoded.length > 0 && decoded.toString('base64') === value ? decoded : null
}

function manualSignerPublicKey(signer) {
  const der = decodeCanonicalBase64(signer?.publicKeySpkiBase64)
  if (!der) throw new Error('POLICY_MANUAL_SIGNERS_INVALID')
  const key = createPublicKey({ format: 'der', key: der, type: 'spki' })
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('POLICY_MANUAL_SIGNERS_INVALID')
  const canonicalDer = key.export({ format: 'der', type: 'spki' })
  if (!Buffer.from(canonicalDer).equals(der)) throw new Error('POLICY_MANUAL_SIGNERS_INVALID')
  return { der, key }
}

function createErrorCollector() {
  const groups = new Map()
  return {
    add(code, options = {}) {
      const architecture = options.architecture ?? ''
      const detail = options.detail ?? ''
      const manual = options.manual === true
      const key = `${code}\u0000${architecture}\u0000${detail}\u0000${manual}`
      const current = groups.get(key) ?? {
        architecture,
        code,
        count: 0,
        detail,
        manual,
        paths: [],
      }
      current.count += 1
      if (options.path && current.paths.length < MAX_ERROR_PATHS) current.paths.push(options.path)
      groups.set(key, current)
    },
    finish() {
      return [...groups.values()]
        .map(group => {
          const result = { code: group.code, count: group.count }
          if (group.architecture) result.architecture = group.architecture
          if (group.detail) result.detail = group.detail
          if (group.paths.length > 0) result.paths = [...new Set(group.paths)].sort(compareText)
          Object.defineProperty(result, 'manual', { value: group.manual, enumerable: false })
          return result
        })
        .sort((left, right) => {
          const leftKey = `${left.code}\u0000${left.architecture ?? ''}\u0000${left.detail ?? ''}`
          const rightKey = `${right.code}\u0000${right.architecture ?? ''}\u0000${right.detail ?? ''}`
          return compareText(leftKey, rightKey)
        })
    },
  }
}

function baseReport() {
  return {
    schemaVersion: 1,
    verifier: 'openpipal-macos-release',
    scope: 'F-06',
    verdict: 'FAIL',
    automatedVerdict: 'FAIL',
    manualVerdict: 'MISSING',
    evidenceOnly: true,
    publicReleaseClearance: false,
    candidate: { commit: null, tree: null, contentSha256: null, exact: false },
    policyBinding: {
      path: POLICY_PATH,
      sha256: null,
      loadedFromCandidate: false,
      runningBuildManifestHookMatchesCandidate: false,
      runningScriptMatchesCandidate: false,
      runningInventoryMatchesCandidate: false,
      matches: false,
    },
    protectedTrust: { matches: false, policyId: null, sha256: null },
    artifactSetBinding: {
      sha256: null,
      architectures: [],
      sameCandidate: false,
      sameBundleIdentifier: false,
      sameTeamIdentifier: false,
      matches: false,
    },
    stagingBinding: {
      cleanupComplete: false,
      finalMatches: false,
      frozen: false,
      initialMatches: false,
      privateMode: false,
    },
    artifacts: [],
    manualEvidence: {
      artifactSetBindingMatches: false,
      complete: false,
      checks: [],
      signaturesVerified: { approver: false, operator: false },
    },
    counts: { artifacts: 0, codeObjects: 0, manualChecks: 0, errors: 0 },
    errors: [],
  }
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
    throw new Error('CANDIDATE_OBJECT_READ_FAILED')
  }
}

function defaultResolveCandidate(repo, commit) {
  let resolved
  try {
    resolved = git(repo, ['rev-parse', '--verify', `${commit}^{commit}`]).trim()
  } catch {
    throw new Error('EXACT_CANDIDATE_REQUIRED')
  }
  if (resolved !== commit) throw new Error('EXACT_CANDIDATE_REQUIRED')
  const tree = git(repo, ['rev-parse', `${commit}^{tree}`]).trim()
  const output = git(repo, ['ls-tree', '-r', '-l', `${commit}^{commit}`])
  const entries = output.length === 0
    ? []
    : output.replace(/\n$/u, '').split('\n').map(line => {
      const tab = line.indexOf('\t')
      const metadata = tab === -1 ? '' : line.slice(0, tab)
      const candidatePath = tab === -1 ? '' : line.slice(tab + 1)
      const match = /^(\d{6}) (blob|tree) ([0-9a-f]+)\s+(-|\d+)$/u.exec(metadata)
      if (!match || match[2] !== 'blob' || !candidatePath || candidatePath.startsWith('"')) {
        throw new Error('CANDIDATE_OBJECT_READ_FAILED')
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

function defaultReadCandidateBlob(repo, commit, candidatePath) {
  return git(repo, ['show', `${commit}^{commit}:${candidatePath}`], null)
}

async function defaultRunTool(tool, args, options = {}) {
  const result = spawnSync(tool, args, {
    encoding: 'utf8',
    env: { ...process.env, LANG: 'C', LC_ALL: 'C' },
    input: options.input,
    maxBuffer: 32 * 1024 * 1024,
    timeout: options.timeout ?? 30_000,
  })
  return {
    exitCode: Number.isInteger(result.status) ? result.status : 127,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? (result.error ? result.error.message : ''),
  }
}

async function defaultCreatePrivateStagingDirectory() {
  const stagingRoot = await mkdtemp(path.join(tmpdir(), 'openpipal-macos-release-verify-'))
  await chmod(stagingRoot, 0o700)
  return stagingRoot
}

async function defaultCreatePrivateStagingSubdirectory(stagingDirectory) {
  await mkdir(stagingDirectory, { mode: 0o700, recursive: false })
}

async function defaultCopyArtifact(sourcePath, destinationPath) {
  const result = await defaultRunTool('/usr/bin/ditto', [
    '--rsrc',
    '--extattr',
    '--acl',
    sourcePath,
    destinationPath,
  ], { timeout: 120_000 })
  if (result.exitCode !== 0) throw new Error('STAGING_COPY_FAILED')
}

async function defaultRemovePrivateStagingDirectory(stagingRoot) {
  await rm(stagingRoot, { force: true, recursive: true })
}

function normalizeToolResult(result) {
  return {
    exitCode: Number.isInteger(result?.exitCode) ? result.exitCode : 127,
    stdout: typeof result?.stdout === 'string' ? result.stdout : '',
    stderr: typeof result?.stderr === 'string' ? result.stderr : '',
  }
}

function validatePolicy(policy, candidate, errors) {
  let valid = true
  const fail = code => {
    errors.add(code)
    valid = false
  }
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) {
    fail('MALFORMED_POLICY')
    return false
  }
  if (policy.schemaVersion !== 1) fail('UNSUPPORTED_POLICY_VERSION')
  if (!TRUST_POLICY_ID.test(policy.policyId ?? '')) fail('POLICY_ID_INVALID')
  if (policy.evidenceOnly !== true || policy.publicReleaseClearance !== false) {
    fail('POLICY_EVIDENCE_BOUNDARY_INVALID')
  }
  const review = policy.review
  const reviewOwner = normalizedApprovalIdentity(review?.owner)
  const reviewApprover = normalizedApprovalIdentity(review?.approver)
  if (
    !review
    || reviewOwner === null
    || reviewApprover === null
    || reviewOwner === reviewApprover
    || review.status !== 'APPROVED'
    || ![candidate.commit, 'SELF'].includes(review.candidate)
  ) {
    fail('POLICY_REVIEW_PENDING')
  }
  if (!SHA256.test(policy.candidateContentSha256 ?? '')) {
    fail(isPending(policy.candidateContentSha256)
      ? 'POLICY_CANDIDATE_CONTENT_PENDING'
      : 'POLICY_CANDIDATE_CONTENT_INVALID')
  } else if (policy.candidateContentSha256 !== candidate.contentSha256) {
    fail('POLICY_CANDIDATE_CONTENT_MISMATCH')
  }
  if (!TEAM_IDENTIFIER.test(policy.teamIdentifier ?? '')) {
    fail(isPending(policy.teamIdentifier) ? 'POLICY_TEAM_IDENTIFIER_PENDING' : 'POLICY_TEAM_IDENTIFIER_INVALID')
  }
  if (!sameJson(sortedUniqueStrings(policy.architectures), ARCHITECTURES)) {
    fail('POLICY_ARCHITECTURES_INVALID')
  }
  if (
    !policy.app
    || policy.app.name !== 'OpenPipal.app'
    || policy.app.bundleIdentifier !== 'com.openpipal.app'
    || policy.app.productName !== 'OpenPipal'
    || typeof policy.app.minimumSystemVersion !== 'string'
  ) {
    fail('POLICY_APP_CONTRACT_INVALID')
  }
  if (!sortedUniqueStrings(policy.app?.helperBundleIdentifiers)) fail('POLICY_HELPERS_INVALID')
  try {
    normalizeCandidatePath(policy.buildManifestPath, 'build_manifest_path')
    if (policy.buildManifestPath !== BUILD_MANIFEST_PATH) {
      throw new Error('POLICY_BUILD_MANIFEST_PATH_INVALID')
    }
  } catch {
    fail('POLICY_BUILD_MANIFEST_PATH_INVALID')
  }
  const sourcePaths = sortedUniqueStrings(policy.sourcePaths)
  if (!sourcePaths) {
    fail('POLICY_SOURCE_PATHS_INVALID')
  } else {
    try {
      sourcePaths.forEach(candidatePath => normalizeCandidatePath(candidatePath, 'source_path'))
    } catch {
      fail('POLICY_SOURCE_PATHS_INVALID')
    }
    for (const required of [
      POLICY_PATH,
      SCRIPT_CANDIDATE_PATH,
      INVENTORY_SCRIPT_CANDIDATE_PATH,
      BUILD_MANIFEST_HOOK_CANDIDATE_PATH,
      RELEASE_BUILDER_CONFIG_PATH,
      'electron-builder.yml',
      'package.json',
      'package-lock.json',
    ]) {
      if (!sourcePaths.includes(required)) fail('POLICY_SOURCE_PATHS_INVALID')
    }
  }
  if (!policy.entitlements || typeof policy.entitlements !== 'object') {
    fail('POLICY_ENTITLEMENTS_INVALID')
  } else {
    for (const role of ['main', 'helper']) {
      try {
        normalizeCandidatePath(policy.entitlements[role], `entitlements_${role}`)
      } catch {
        fail('POLICY_ENTITLEMENTS_INVALID')
      }
    }
    if (!sortedUniqueStrings(policy.entitlements.forbidden)) fail('POLICY_ENTITLEMENTS_INVALID')
  }
  if (!sortedUniqueStrings(policy.privacyKeys)) fail('POLICY_PRIVACY_KEYS_INVALID')
  if (!Array.isArray(policy.localizations) || policy.localizations.length !== 2) {
    fail('POLICY_LOCALIZATIONS_INVALID')
  } else {
    const locales = []
    for (const localization of policy.localizations) {
      if (!localization || typeof localization.locale !== 'string') {
        fail('POLICY_LOCALIZATIONS_INVALID')
        continue
      }
      locales.push(localization.locale)
      try {
        normalizeCandidatePath(localization.sourcePath, 'localization_source')
        normalizeCandidatePath(localization.bundlePath, 'localization_bundle')
      } catch {
        fail('POLICY_LOCALIZATIONS_INVALID')
      }
    }
    if (!sameJson(locales.sort(compareText), ['en', 'zh-Hans'])) fail('POLICY_LOCALIZATIONS_INVALID')
  }
  const manualCheckIds = sortedUniqueStrings(policy.manualCheckIds)
  if (
    !manualCheckIds
    || manualCheckIds.length === 0
    || MANDATORY_MANUAL_CHECK_IDS.some(id => !manualCheckIds.includes(id))
  ) {
    fail('POLICY_MANUAL_CHECKS_INVALID')
  }
  const manualEvidence = policy.manualEvidence
  const signerRoles = ['operator', 'approver']
  if (
    !manualEvidence
    || typeof manualEvidence !== 'object'
    || Array.isArray(manualEvidence)
    || !sameJson(Object.keys(manualEvidence).sort(compareText), [
      'approver',
      'operator',
      'schemaVersion',
      'signatureAlgorithm',
      'signatureDomain',
    ])
  ) {
    fail('POLICY_MANUAL_SIGNERS_INVALID')
  } else if (signerRoles.some(role => {
    const signer = manualEvidence[role]
    return isPending(signer?.identity)
      || isPending(signer?.keyId)
      || isPending(signer?.publicKeySpkiBase64)
  })) {
    fail('POLICY_MANUAL_SIGNERS_PENDING')
  } else {
    const signers = []
    if (
      manualEvidence.schemaVersion !== 3
      || manualEvidence.signatureDomain !== MANUAL_SIGNATURE_DOMAIN
      || manualEvidence.signatureAlgorithm !== 'Ed25519'
    ) {
      fail('POLICY_MANUAL_SIGNERS_INVALID')
    }
    for (const role of signerRoles) {
      const signer = manualEvidence[role]
      if (
        !signer
        || typeof signer !== 'object'
        || Array.isArray(signer)
        || !sameJson(Object.keys(signer).sort(compareText), [
          'identity',
          'keyId',
          'publicKeySpkiBase64',
        ])
        || normalizedApprovalIdentity(signer.identity) === null
        || normalizedApprovalIdentity(signer.keyId) === null
      ) {
        fail('POLICY_MANUAL_SIGNERS_INVALID')
        continue
      }
      try {
        const parsedSigner = { ...signer, ...manualSignerPublicKey(signer) }
        if (!SHA256.test(signer.keyId) || signer.keyId !== sha256(parsedSigner.der)) {
          throw new Error('POLICY_MANUAL_SIGNERS_INVALID')
        }
        signers.push(parsedSigner)
      } catch {
        fail('POLICY_MANUAL_SIGNERS_INVALID')
      }
    }
    if (
      signers.length === signerRoles.length
      && (
        signers[0].identity === signers[1].identity
        || signers[0].keyId === signers[1].keyId
        || signers[0].der.equals(signers[1].der)
      )
    ) {
      fail('POLICY_MANUAL_SIGNERS_INVALID')
    }
  }
  return valid
}

async function loadProtectedTrustBundle(dependencies, errors, report) {
  const trustPath = dependencies.environment?.OPENPIPAL_RELEASE_TRUST_BUNDLE
  const expectedSha256 = dependencies.environment?.OPENPIPAL_RELEASE_TRUST_SHA256
  if (trustPath === undefined || expectedSha256 === undefined) {
    errors.add('PROTECTED_TRUST_CONFIG_MISSING')
    return null
  }
  if (
    typeof trustPath !== 'string'
    || trustPath.trim() !== trustPath
    || !path.isAbsolute(trustPath)
    || typeof expectedSha256 !== 'string'
    || !SHA256.test(expectedSha256)
  ) {
    errors.add('PROTECTED_TRUST_CONFIG_INVALID')
    return null
  }
  let raw
  try {
    raw = await readPinnedRegularFile(trustPath, MAX_TRUST_BUNDLE_BYTES, dependencies)
  } catch {
    errors.add('PROTECTED_TRUST_BUNDLE_INVALID')
    return null
  }
  const actualSha256 = sha256(raw)
  report.protectedTrust.sha256 = actualSha256
  const externalHashMatches = actualSha256 === expectedSha256
  if (!externalHashMatches) errors.add('PROTECTED_TRUST_HASH_MISMATCH')
  let bundle
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(raw)
    bundle = parseJson(text, 'PROTECTED_TRUST_BUNDLE_INVALID')
  } catch {
    errors.add('PROTECTED_TRUST_BUNDLE_INVALID')
    return { bundle: null, externalHashMatches, raw }
  }
  return { bundle, externalHashMatches, raw }
}

function validateProtectedTrustBundle(loaded, context, errors, report) {
  if (!loaded?.bundle || typeof loaded.bundle !== 'object' || Array.isArray(loaded.bundle)) return false
  const bundle = loaded.bundle
  const contentSha256 = content => (
    typeof content === 'string' || Buffer.isBuffer(content) ? sha256(content) : null
  )
  let valid = true
  const fail = code => {
    errors.add(code)
    valid = false
  }
  if (
    !sameJson(Object.keys(bundle).sort(compareText), [
      'app',
      'buildManifestHookSha256',
      'candidatePolicySha256',
      'domain',
      'inventoryGeneratorSha256',
      'manualCheckIds',
      'manualEvidence',
      'policyId',
      'schemaVersion',
      'teamIdentifier',
      'verifierSha256',
    ])
    || bundle.schemaVersion !== 1
    || bundle.domain !== TRUST_BUNDLE_DOMAIN
    || !TRUST_POLICY_ID.test(bundle.policyId ?? '')
    || !SHA256.test(bundle.buildManifestHookSha256 ?? '')
    || !SHA256.test(bundle.candidatePolicySha256 ?? '')
    || !SHA256.test(bundle.verifierSha256 ?? '')
    || !SHA256.test(bundle.inventoryGeneratorSha256 ?? '')
    || !TEAM_IDENTIFIER.test(bundle.teamIdentifier ?? '')
    || !bundle.app
    || typeof bundle.app !== 'object'
    || Array.isArray(bundle.app)
    || !sameJson(Object.keys(bundle.app).sort(compareText), [
      'bundleIdentifier',
      'helperBundleIdentifiers',
    ])
  ) {
    fail('PROTECTED_TRUST_BUNDLE_INVALID')
  }
  const trustChecks = sortedUniqueStrings(bundle.manualCheckIds)
  if (
    !trustChecks
    || trustChecks.length === 0
    || MANDATORY_MANUAL_CHECK_IDS.some(id => !trustChecks.includes(id))
  ) {
    fail('PROTECTED_TRUST_BUNDLE_INVALID')
  }
  if (TRUST_POLICY_ID.test(bundle.policyId ?? '')) report.protectedTrust.policyId = bundle.policyId

  const policy = context.policy
  if (
    !policy
    || bundle.policyId !== policy.policyId
    || bundle.candidatePolicySha256 !== contentSha256(context.policyRaw)
    || bundle.teamIdentifier !== policy.teamIdentifier
    || bundle.app?.bundleIdentifier !== policy.app?.bundleIdentifier
    || !sameJson(bundle.app?.helperBundleIdentifiers, policy.app?.helperBundleIdentifiers)
    || !sameJson(bundle.manualCheckIds, policy.manualCheckIds)
    || !sameJson(bundle.manualEvidence, policy.manualEvidence)
  ) {
    fail('PROTECTED_TRUST_POLICY_MISMATCH')
  }
  if (
    bundle.verifierSha256 !== contentSha256(context.candidateVerifier)
    || bundle.verifierSha256 !== contentSha256(context.runningVerifier)
    || bundle.inventoryGeneratorSha256 !== contentSha256(context.candidateInventory)
    || bundle.inventoryGeneratorSha256 !== contentSha256(context.runningInventory)
    || bundle.buildManifestHookSha256 !== contentSha256(context.candidateBuildManifestHook)
    || bundle.buildManifestHookSha256 !== contentSha256(context.runningBuildManifestHook)
  ) {
    fail('PROTECTED_TRUST_RUNTIME_MISMATCH')
  }
  report.protectedTrust.matches = valid && loaded.externalHashMatches
  return report.protectedTrust.matches
}

function parseInfoPlistStrings(content) {
  const text = Buffer.isBuffer(content) ? content.toString('utf8') : content
  const result = {}
  for (const [index, line] of text.split(/\r?\n/u).entries()) {
    if (line.trim() === '') continue
    const match = line.match(/^("(?:\\.|[^"\\])*")\s*=\s*("(?:\\.|[^"\\])*");$/u)
    if (!match) throw new Error(`line-${index + 1}`)
    const key = JSON.parse(match[1])
    const value = JSON.parse(match[2])
    if (Object.hasOwn(result, key)) throw new Error(`duplicate-${key}`)
    result[key] = value
  }
  return result
}

function decodeXmlKey(value) {
  const decoded = value.replace(
    /&(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/gu,
    entity => {
      if (entity === '&amp;') return '&'
      if (entity === '&lt;') return '<'
      if (entity === '&gt;') return '>'
      if (entity === '&quot;') return '"'
      if (entity === '&apos;') return "'"
      const hexadecimal = entity.startsWith('&#x')
      const numeric = entity.slice(hexadecimal ? 3 : 2, -1)
      const codePoint = Number.parseInt(numeric, hexadecimal ? 16 : 10)
      if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) {
        throw new Error('INFO_PLIST_INVALID')
      }
      return String.fromCodePoint(codePoint)
    },
  )
  if (decoded.includes('&')) throw new Error('INFO_PLIST_INVALID')
  return decoded
}

function validateTopLevelPlistDictionary(content) {
  const text = Buffer.isBuffer(content) ? content.toString('utf8') : content
  if (!text.trimStart().startsWith('<?xml') || text.includes('\u0000')) {
    throw new Error('INFO_PLIST_INVALID')
  }
  const tokens = text.match(
    /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<key\s*>([\s\S]*?)<\/key\s*>|<\/?(?:dict|array)\s*>/gu,
  ) ?? []
  const containers = []
  const keys = new Set()
  let topDictionarySeen = false
  let topDictionaryClosed = false
  for (const token of tokens) {
    if (token.startsWith('<!--') || token.startsWith('<?') || token.startsWith('<!DOCTYPE')) continue
    if (token === '<dict>' || token === '<array>') {
      const kind = token === '<dict>' ? 'dict' : 'array'
      if (containers.length === 0) {
        if (topDictionarySeen || kind !== 'dict') throw new Error('INFO_PLIST_INVALID')
        topDictionarySeen = true
      }
      containers.push(kind)
      continue
    }
    if (token === '</dict>' || token === '</array>') {
      const kind = token === '</dict>' ? 'dict' : 'array'
      if (containers.pop() !== kind) throw new Error('INFO_PLIST_INVALID')
      if (containers.length === 0) topDictionaryClosed = true
      continue
    }
    if (token.startsWith('<key') && containers.length === 1 && containers[0] === 'dict') {
      const keyMatch = /^<key\s*>([\s\S]*?)<\/key\s*>$/u.exec(token)
      if (!keyMatch) throw new Error('INFO_PLIST_INVALID')
      const rawKey = keyMatch[1]
      if (rawKey.includes('<')) throw new Error('INFO_PLIST_INVALID')
      const key = decodeXmlKey(rawKey)
      if (keys.has(key)) throw new Error('INFO_PLIST_DUPLICATE_KEY')
      keys.add(key)
    }
  }
  if (!topDictionarySeen || !topDictionaryClosed || containers.length !== 0) {
    throw new Error('INFO_PLIST_INVALID')
  }
  return [...keys].sort(compareText)
}

function parseBooleanEntitlements(content) {
  const text = Buffer.isBuffer(content) ? content.toString('utf8') : content
  if (text.trim() === '') return {}
  const body = text
    .replace(/<\?xml[^>]*\?>/u, '')
    .replace(/<!DOCTYPE[^>]*>/u, '')
    .replace(/<plist\s+version="1\.0">/u, '')
    .replace(/<\/plist>/u, '')
    .replace(/<dict>/u, '')
    .replace(/<\/dict>/u, '')
    .replace(/<!--[\s\S]*?-->/gu, '')
  const result = {}
  for (const match of body.matchAll(/<key>([^<]+)<\/key>\s*<(true|false)\s*\/>/gu)) {
    if (Object.hasOwn(result, match[1])) throw new Error('duplicate-entitlement')
    result[match[1]] = match[2] === 'true'
  }
  const residual = body.replace(/<key>[^<]+<\/key>\s*<(?:true|false)\s*\/>/gu, '').trim()
  if (residual !== '') throw new Error('unsupported-entitlement-plist')
  return result
}

function parseCodesignDisplay(output) {
  const fields = new Map()
  let flags = []
  let embedded = null
  let adHoc = false
  for (const line of output.split(/\r?\n/u)) {
    const field = line.match(/^(Identifier|TeamIdentifier|CDHash)=(.*)$/u)
    if (field) {
      if (fields.has(field[1])) throw new Error('DUPLICATE_SIGNATURE_FIELD')
      fields.set(field[1], field[2])
    }
    const fullHash = line.match(/^CandidateCDHashFull sha256=([0-9a-f]+)$/u)
    if (fullHash) {
      if (fields.has('CandidateCDHashFull')) throw new Error('DUPLICATE_SIGNATURE_FIELD')
      fields.set('CandidateCDHashFull', fullHash[1])
    }
    const codeDirectory = line.match(/^CodeDirectory .* flags=0x[0-9a-f]+\(([^)]*)\)/iu)
    if (codeDirectory) {
      flags = codeDirectory[1] === 'none'
        ? []
        : codeDirectory[1].split(',').map(value => value.trim()).filter(Boolean)
      const location = line.match(/\slocation=([^\s]+)/u)?.[1]
      if (location) embedded = location === 'embedded'
      if (flags.includes('adhoc') || flags.includes('linker-signed')) adHoc = true
    }
    if (line === 'Signature=adhoc') adHoc = true
  }
  const fullHash = fields.get('CandidateCDHashFull')
  const cdHash = fields.get('CDHash')
  return {
    adHoc,
    cdHash: fullHash ?? cdHash ?? null,
    embedded,
    flags: [...new Set(flags)].sort(compareText),
    identifier: fields.get('Identifier') ?? null,
    teamIdentifier: fields.get('TeamIdentifier') ?? null,
  }
}

function entitlementDiagnosticsAreSafe(stderr, targetPath) {
  const lines = stderr.split(/\r?\n/u).filter(line => line !== '')
  return lines.length === 0
    || (lines.length === 1 && lines[0] === `Executable=${targetPath}`)
}

function compareVersions(left, right) {
  const parse = value => {
    if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*))*$/u.test(value)) return null
    return value.split('.').map(part => Number(part))
  }
  const leftParts = parse(left)
  const rightParts = parse(right)
  if (!leftParts || !rightParts) return null
  if ([...leftParts, ...rightParts].some(value => !Number.isSafeInteger(value))) return null
  const length = Math.max(leftParts.length, rightParts.length)
  for (let index = 0; index < length; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}

function helperBundlePath(relativePath) {
  const match = relativePath.match(/^(.*?\.app)\/Contents\/MacOS\/[^/]+$/u)
  return match?.[1] ?? null
}

function nestedBundlePaths(nativeBinaries) {
  const result = new Set()
  const bundlePattern = /^(.*?\.(?:app|appex|framework|plugin|xpc))(?:\/|$)/u
  for (const binary of nativeBinaries) {
    const match = binary.path.match(bundlePattern)
    if (match) result.add(match[1])
  }
  return [...result].sort(compareText)
}

function developerIdRequirement(teamIdentifier) {
  return `anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = "${teamIdentifier}"`
}

async function runCheckedTool(dependencies, tool, args, options = {}) {
  return normalizeToolResult(await dependencies.runTool(tool, args, options))
}

async function verifyExactSignature(targetPath, context, dependencies, errors) {
  const verify = await runCheckedTool(dependencies, '/usr/bin/codesign', [
    '--verify',
    '--strict',
    '--verbose=2',
    '--all-architectures',
    targetPath,
  ])
  if (verify.exitCode !== 0) {
    errors.add('CODESIGN_EXACT_VERIFY_FAILED', context)
  }
  const requirement = await runCheckedTool(dependencies, '/usr/bin/codesign', [
    '--verify',
    '--strict',
    '--verbose=2',
    '--all-architectures',
    `-R=${developerIdRequirement(context.teamIdentifier)}`,
    targetPath,
  ])
  if (requirement.exitCode !== 0) errors.add('DEVELOPER_ID_REQUIREMENT_FAILED', context)
  return verify.exitCode === 0 && requirement.exitCode === 0
}

function inspectSignatureMetadata(metadata, expected, context, errors) {
  if (metadata.adHoc) errors.add('ADHOC_SIGNATURE_FORBIDDEN', context)
  if (metadata.embedded !== true) errors.add('EMBEDDED_SIGNATURE_REQUIRED', context)
  if (!TEAM_IDENTIFIER.test(metadata.teamIdentifier ?? '')) {
    errors.add('TEAM_IDENTIFIER_MISSING', context)
  } else if (metadata.teamIdentifier !== expected.teamIdentifier) {
    errors.add('TEAM_IDENTIFIER_MISMATCH', context)
  }
  if (!metadata.cdHash || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(metadata.cdHash)) {
    errors.add('CDHASH_MISSING', context)
  }
  if (expected.requireRuntime && !metadata.flags.includes('runtime')) {
    errors.add('HARDENED_RUNTIME_MISSING', context)
  }
  if (expected.identifier && metadata.identifier !== expected.identifier) {
    errors.add('SIGNATURE_IDENTIFIER_MISMATCH', context)
  }
}

async function readPlistJson(filePath, context, dependencies, errors) {
  try {
    validateTopLevelPlistDictionary(await dependencies.readFile(filePath))
  } catch (error) {
    errors.add(error.message === 'INFO_PLIST_DUPLICATE_KEY'
      ? error.message
      : 'INFO_PLIST_INVALID', context)
    return null
  }
  const result = await runCheckedTool(
    dependencies,
    '/usr/bin/plutil',
    ['-convert', 'json', '-o', '-', filePath],
  )
  if (result.exitCode !== 0) {
    errors.add('INFO_PLIST_INVALID', context)
    return null
  }
  try {
    const value = JSON.parse(result.stdout)
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not-object')
    return value
  } catch {
    errors.add('INFO_PLIST_INVALID', context)
    return null
  }
}

async function inspectCodeObject(options) {
  const {
    absolutePath,
    architectures,
    context,
    dependencies,
    errors,
    expectedEntitlements,
    expectedIdentifier,
    policy,
    relativePath,
    role,
  } = options
  const exactVerified = await verifyExactSignature(
    absolutePath,
    { ...context, path: relativePath, teamIdentifier: policy.teamIdentifier },
    dependencies,
    errors,
  )
  const slices = []
  for (const architecture of [...architectures].sort(compareText)) {
    const sliceContext = { ...context, path: relativePath, detail: architecture }
    const display = await runCheckedTool(dependencies, '/usr/bin/codesign', [
      '-d',
      '--architecture',
      architecture,
      '--verbose=4',
      absolutePath,
    ])
    let metadata = {
      adHoc: false,
      cdHash: null,
      embedded: false,
      flags: [],
      identifier: null,
      teamIdentifier: null,
    }
    if (display.exitCode !== 0) {
      errors.add('SIGNATURE_METADATA_UNAVAILABLE', sliceContext)
    } else {
      try {
        metadata = parseCodesignDisplay(`${display.stdout}\n${display.stderr}`)
        inspectSignatureMetadata(
          metadata,
          {
            identifier: expectedIdentifier,
            requireRuntime: true,
            teamIdentifier: policy.teamIdentifier,
          },
          sliceContext,
          errors,
        )
      } catch (error) {
        errors.add(error.message === 'DUPLICATE_SIGNATURE_FIELD'
          ? error.message
          : 'SIGNATURE_METADATA_UNAVAILABLE', sliceContext)
      }
    }
    const entitlementResult = await runCheckedTool(dependencies, '/usr/bin/codesign', [
      '-d',
      '--architecture',
      architecture,
      '--entitlements',
      '-',
      '--xml',
      absolutePath,
    ])
    let entitlements = null
    if (
      entitlementResult.exitCode !== 0
      || !entitlementDiagnosticsAreSafe(entitlementResult.stderr, absolutePath)
    ) {
      errors.add('ENTITLEMENTS_EXTRACT_FAILED', sliceContext)
    } else {
      try {
        entitlements = parseBooleanEntitlements(entitlementResult.stdout)
        if (!sameJson(entitlements, expectedEntitlements)) {
          errors.add('ENTITLEMENTS_MISMATCH', sliceContext)
        }
        for (const forbidden of policy.entitlements.forbidden) {
          if (Object.hasOwn(entitlements, forbidden)) {
            errors.add('FORBIDDEN_ENTITLEMENT', { ...sliceContext, detail: forbidden })
          }
        }
      } catch {
        errors.add('ENTITLEMENTS_EXTRACT_FAILED', sliceContext)
      }
    }
    slices.push({
      architecture,
      cdHash: metadata.cdHash,
      entitlements,
      flags: metadata.flags,
      identifier: metadata.identifier,
      teamIdentifier: metadata.teamIdentifier,
    })
  }
  return {
    architectures: [...architectures].sort(compareText),
    exactVerified,
    path: relativePath,
    role,
    slices,
  }
}

async function fileExistsAsType(filePath, type, dependencies) {
  try {
    const metadata = await dependencies.lstat(filePath)
    if (metadata.isSymbolicLink()) return false
    return type === 'directory' ? metadata.isDirectory() : metadata.isFile()
  } catch {
    return false
  }
}

function regularFileIdentity(metadata) {
  return {
    ctimeMs: metadata.ctimeMs,
    device: metadata.dev,
    inode: metadata.ino,
    mode: metadata.mode,
    mtimeMs: metadata.mtimeMs,
    size: metadata.size,
  }
}

async function readPinnedRegularFile(filePath, maximumBytes, dependencies) {
  const pathBefore = await dependencies.lstat(filePath)
  if (pathBefore.isSymbolicLink() || !pathBefore.isFile()) throw new Error('REGULAR_FILE_REQUIRED')
  if (!Number.isSafeInteger(pathBefore.size) || pathBefore.size < 0 || pathBefore.size > maximumBytes) {
    throw new Error('REGULAR_FILE_SIZE_INVALID')
  }
  const handle = await dependencies.openFile(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
  try {
    const descriptorBefore = await handle.stat()
    if (
      !descriptorBefore.isFile()
      || !sameJson(regularFileIdentity(pathBefore), regularFileIdentity(descriptorBefore))
    ) {
      throw new Error('FILE_IDENTITY_CHANGED')
    }
    const content = Buffer.alloc(descriptorBefore.size)
    let position = 0
    while (position < content.length) {
      const { bytesRead } = await handle.read(content, position, content.length - position, position)
      if (bytesRead <= 0) throw new Error('FILE_CHANGED_DURING_READ')
      position += bytesRead
    }
    const trailing = await handle.read(Buffer.alloc(1), 0, 1, position)
    if (trailing.bytesRead !== 0) throw new Error('FILE_CHANGED_DURING_READ')
    const descriptorAfter = await handle.stat()
    const pathAfter = await dependencies.lstat(filePath)
    if (
      pathAfter.isSymbolicLink()
      || !pathAfter.isFile()
      || !sameJson(regularFileIdentity(descriptorBefore), regularFileIdentity(descriptorAfter))
      || !sameJson(regularFileIdentity(descriptorAfter), regularFileIdentity(pathAfter))
    ) {
      throw new Error('FILE_CHANGED_DURING_READ')
    }
    return content
  } finally {
    await handle.close()
  }
}

async function hashRegularFile(filePath, dependencies) {
  const pathBefore = await dependencies.lstat(filePath)
  if (pathBefore.isSymbolicLink() || !pathBefore.isFile()) throw new Error('REGULAR_FILE_REQUIRED')
  const handle = await dependencies.openFile(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
  try {
    const descriptorBefore = await handle.stat()
    if (
      !descriptorBefore.isFile()
      || !sameJson(regularFileIdentity(pathBefore), regularFileIdentity(descriptorBefore))
    ) {
      throw new Error('FILE_IDENTITY_CHANGED')
    }
    const hash = createHash('sha256')
    const buffer = Buffer.allocUnsafe(1024 * 1024)
    let position = 0
    while (position < descriptorBefore.size) {
      const length = Math.min(buffer.length, descriptorBefore.size - position)
      const { bytesRead } = await handle.read(buffer, 0, length, position)
      if (bytesRead <= 0) throw new Error('FILE_CHANGED_DURING_READ')
      hash.update(buffer.subarray(0, bytesRead))
      position += bytesRead
    }
    const trailing = await handle.read(buffer, 0, 1, position)
    if (trailing.bytesRead !== 0) throw new Error('FILE_CHANGED_DURING_READ')
    const descriptorAfter = await handle.stat()
    const pathAfter = await dependencies.lstat(filePath)
    if (
      pathAfter.isSymbolicLink()
      || !pathAfter.isFile()
      || !sameJson(regularFileIdentity(descriptorBefore), regularFileIdentity(descriptorAfter))
      || !sameJson(regularFileIdentity(descriptorAfter), regularFileIdentity(pathAfter))
    ) {
      throw new Error('FILE_CHANGED_DURING_READ')
    }
    return hash.digest('hex')
  } finally {
    await handle.close()
  }
}

async function defaultReadRunningBuildManifestHook() {
  return readPinnedRegularFile(BUILD_MANIFEST_HOOK_PATH, MAX_BUILD_MANIFEST_HOOK_BYTES, {
    lstat,
    openFile: open,
  })
}

async function captureArtifactDigests(appPath, dmgPath, dependencies) {
  if (
    !path.isAbsolute(appPath)
    || !path.isAbsolute(dmgPath)
    || !await fileExistsAsType(appPath, 'directory', dependencies)
    || !await fileExistsAsType(dmgPath, 'file', dependencies)
  ) {
    throw new Error('ARTIFACT_INPUT_INVALID')
  }
  const inventory = await dependencies.collectAppInventory(appPath)
  if (!SHA256.test(inventory?.contentSha256 ?? '')) throw new Error('APP_INVENTORY_FAILED')
  return {
    appContentSha256: inventory.contentSha256,
    dmgSha256: await hashRegularFile(dmgPath, dependencies),
  }
}

async function stageReleaseArtifacts(inputs, dependencies, errors, report) {
  const staging = {
    apps: {},
    baselines: {},
    dmgs: {},
    ready: true,
    root: null,
    sources: { apps: { ...inputs.apps }, dmgs: { ...inputs.dmgs } },
  }
  try {
    staging.root = await dependencies.createPrivateStagingDirectory()
    const metadata = await dependencies.lstat(staging.root)
    if (
      metadata.isSymbolicLink()
      || !metadata.isDirectory()
      || (metadata.mode & 0o777) !== 0o700
    ) {
      throw new Error('PRIVATE_STAGING_INVALID')
    }
    report.stagingBinding.privateMode = true
  } catch {
    errors.add('PRIVATE_STAGING_FAILED')
    staging.ready = false
    return staging
  }

  for (const architecture of ARCHITECTURES) {
    const context = { architecture }
    const sourceApp = inputs.apps[architecture]
    const sourceDmg = inputs.dmgs[architecture]
    const architectureRoot = path.join(staging.root, architecture)
    const stagedApp = path.join(architectureRoot, 'OpenPipal.app')
    const stagedDmg = path.join(architectureRoot, 'OpenPipal.dmg')
    staging.apps[architecture] = stagedApp
    staging.dmgs[architecture] = stagedDmg
    try {
      await dependencies.createPrivateStagingSubdirectory(architectureRoot)
      const architectureMetadata = await dependencies.lstat(architectureRoot)
      if (
        architectureMetadata.isSymbolicLink()
        || !architectureMetadata.isDirectory()
        || (architectureMetadata.mode & 0o777) !== 0o700
      ) {
        throw new Error('PRIVATE_STAGING_INVALID')
      }
    } catch {
      errors.add('PRIVATE_STAGING_FAILED', context)
      staging.ready = false
      continue
    }
    let before
    try {
      before = await captureArtifactDigests(sourceApp, sourceDmg, dependencies)
      staging.baselines[architecture] = before
    } catch {
      errors.add('SOURCE_ARTIFACT_INVALID', context)
      staging.ready = false
      continue
    }
    try {
      await dependencies.copyArtifact(sourceApp, stagedApp)
      await dependencies.copyArtifact(sourceDmg, stagedDmg)
    } catch {
      errors.add('STAGING_COPY_FAILED', context)
      staging.ready = false
      continue
    }
    try {
      const sourceAfterCopy = await captureArtifactDigests(sourceApp, sourceDmg, dependencies)
      const stagedAfterCopy = await captureArtifactDigests(stagedApp, stagedDmg, dependencies)
      if (!sameJson(sourceAfterCopy, before)) {
        errors.add('SOURCE_ARTIFACT_CHANGED_DURING_STAGING', context)
        staging.ready = false
      }
      if (!sameJson(stagedAfterCopy, before)) {
        errors.add('STAGING_COPY_MISMATCH', context)
        staging.ready = false
      }
    } catch {
      errors.add('STAGING_COPY_MISMATCH', context)
      staging.ready = false
    }
  }
  report.stagingBinding.initialMatches = staging.ready
  try {
    await dependencies.setPrivateStagingMode(staging.root, 0o500)
    const frozen = await dependencies.lstat(staging.root)
    if ((frozen.mode & 0o777) !== 0o500) throw new Error('PRIVATE_STAGING_FREEZE_FAILED')
    report.stagingBinding.frozen = true
  } catch {
    errors.add('PRIVATE_STAGING_FREEZE_FAILED')
    staging.ready = false
  }
  return staging
}

async function recheckStagedArtifacts(staging, dependencies, errors) {
  let matches = true
  for (const architecture of ARCHITECTURES) {
    const baseline = staging.baselines[architecture]
    if (!baseline) continue
    const context = { architecture }
    try {
      const currentSource = await captureArtifactDigests(
        staging.sources.apps[architecture],
        staging.sources.dmgs[architecture],
        dependencies,
      )
      if (!sameJson(currentSource, baseline)) {
        errors.add('SOURCE_ARTIFACT_CHANGED_DURING_VERIFICATION', context)
        matches = false
      }
    } catch {
      errors.add('SOURCE_ARTIFACT_CHANGED_DURING_VERIFICATION', context)
      matches = false
    }
    try {
      const currentStaged = await captureArtifactDigests(
        staging.apps[architecture],
        staging.dmgs[architecture],
        dependencies,
      )
      if (!sameJson(currentStaged, baseline)) {
        errors.add('STAGED_ARTIFACT_CHANGED_DURING_VERIFICATION', context)
        matches = false
      }
    } catch {
      errors.add('STAGED_ARTIFACT_CHANGED_DURING_VERIFICATION', context)
      matches = false
    }
  }
  return matches
}

async function cleanupPrivateStaging(stagingRoot, dependencies, errors, report) {
  if (typeof stagingRoot !== 'string') return
  try {
    await dependencies.setPrivateStagingMode(stagingRoot, 0o700)
  } catch {
    errors.add('PRIVATE_STAGING_CLEANUP_FAILED')
  }
  try {
    await dependencies.removePrivateStagingDirectory(stagingRoot)
  } catch {
    errors.add('PRIVATE_STAGING_CLEANUP_FAILED')
    return
  }
  try {
    await dependencies.lstat(stagingRoot)
    errors.add('PRIVATE_STAGING_CLEANUP_FAILED')
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      errors.add('PRIVATE_STAGING_CLEANUP_FAILED')
    } else {
      report.stagingBinding.cleanupComplete = true
    }
  }
}

function artifactSkeleton(architecture) {
  return {
    architecture,
    app: {
      name: null,
      contentSha256: null,
      bundleIdentifier: null,
      version: null,
      buildVersion: null,
      minimumSystemVersion: null,
      mainArchitectures: [],
      infoPlistSha256: null,
      buildManifestBinding: false,
      localizedPurposeStrings: [],
    },
    signature: {
      teamIdentifier: null,
      exactVerify: false,
      deepVerifySupplemental: false,
      gatekeeperAssess: false,
      staplerValidate: false,
      onlineNotarizationCheck: false,
      codeObjects: [],
    },
    dmg: {
      sha256: null,
      signatureVerified: false,
      staplerValidate: false,
      notaryLogHashMatches: false,
    },
  }
}

async function verifyAppArtifact(options) {
  const {
    appPath,
    architecture,
    candidate,
    candidateBlobs,
    dependencies,
    errors,
    packageManifest,
    policy,
  } = options
  const artifact = artifactSkeleton(architecture)
  const context = { architecture }
  if (!path.isAbsolute(appPath) || !await fileExistsAsType(appPath, 'directory', dependencies)) {
    errors.add('APP_BUNDLE_INVALID', context)
    return artifact
  }

  let inventoryBefore
  try {
    inventoryBefore = await dependencies.collectAppInventory(appPath)
  } catch {
    errors.add('APP_INVENTORY_FAILED', context)
    return artifact
  }
  artifact.app.name = inventoryBefore.app
  artifact.app.contentSha256 = inventoryBefore.contentSha256
  artifact.app.mainArchitectures = inventoryBefore.architecturePolicy.mainArchitectures
  if (inventoryBefore.app !== policy.app.name) errors.add('APP_NAME_MISMATCH', context)
  if (!sameJson(inventoryBefore.architecturePolicy.mainArchitectures, [architecture])) {
    errors.add('MAIN_ARCHITECTURE_MISMATCH', context)
  }

  for (const native of inventoryBefore.nativeBinaries.filter(binary => binary.source === 'asar')) {
    const entry = inventoryBefore.asarEntries.find(candidateEntry => candidateEntry.path === native.path)
    if (native.role !== 'wasm' && entry?.unpacked !== true) {
      errors.add('NATIVE_PACKED_IN_ASAR', { ...context, path: native.path })
    }
  }

  const manifestPath = path.join(appPath, ...policy.buildManifestPath.split('/'))
  let buildManifest = null
  let buildManifestParsed = false
  const manifestInventoryRecords = Array.isArray(inventoryBefore.files)
    ? inventoryBefore.files.filter(record => record?.path === policy.buildManifestPath)
    : []
  if (manifestInventoryRecords.length === 0) {
    errors.add('BUILD_MANIFEST_MISSING', context)
  } else if (
    manifestInventoryRecords.length !== 1
    || manifestInventoryRecords[0].symbolicLink === true
    || manifestInventoryRecords[0].executable !== false
    || !Number.isSafeInteger(manifestInventoryRecords[0].size)
    || manifestInventoryRecords[0].size < 0
    || manifestInventoryRecords[0].size > MAX_BUILD_MANIFEST_BYTES
    || !SHA256.test(manifestInventoryRecords[0].sha256 ?? '')
  ) {
    errors.add('BUILD_MANIFEST_INVALID', context)
  } else {
    try {
      const buildManifestRaw = await readPinnedRegularFile(
        manifestPath,
        MAX_BUILD_MANIFEST_BYTES,
        dependencies,
      )
      if (
        buildManifestRaw.length !== manifestInventoryRecords[0].size
        || sha256(buildManifestRaw) !== manifestInventoryRecords[0].sha256
      ) {
        throw new Error('BUILD_MANIFEST_INVENTORY_MISMATCH')
      }
      const buildManifestText = new TextDecoder('utf-8', { fatal: true }).decode(buildManifestRaw)
      buildManifest = parseJson(buildManifestText, 'BUILD_MANIFEST_INVALID')
      buildManifestParsed = true
    } catch (error) {
      errors.add(
        error.message === 'BUILD_MANIFEST_INVENTORY_MISMATCH'
          ? error.message
          : 'BUILD_MANIFEST_INVALID',
        context,
      )
    }
  }
  if (buildManifestParsed) {
    let binding = true
    const schemaValid = !(
      !buildManifest
      || typeof buildManifest !== 'object'
      || Array.isArray(buildManifest)
      || !sameJson(Object.keys(buildManifest).sort(compareText), [
        'architecture',
        'candidateCommit',
        'candidateContentSha256',
        'candidateTree',
        'schemaVersion',
        'sourceSha256',
      ])
      || buildManifest.schemaVersion !== 1
      || !buildManifest.sourceSha256
      || typeof buildManifest.sourceSha256 !== 'object'
      || Array.isArray(buildManifest.sourceSha256)
    )
    if (!schemaValid) {
      errors.add('BUILD_MANIFEST_INVALID', context)
      binding = false
    } else {
      if (buildManifest.candidateCommit !== candidate.commit || buildManifest.candidateTree !== candidate.tree) {
        errors.add('BUILD_MANIFEST_CANDIDATE_MISMATCH', context)
        binding = false
      }
      if (buildManifest.candidateContentSha256 !== candidate.contentSha256) {
        errors.add('BUILD_MANIFEST_CANDIDATE_CONTENT_MISMATCH', context)
        binding = false
      }
      if (buildManifest.architecture !== architecture) {
        errors.add('BUILD_MANIFEST_ARCH_MISMATCH', context)
        binding = false
      }
      const expectedSourceHashes = Object.fromEntries(
        policy.sourcePaths.map(candidatePath => [candidatePath, sha256(candidateBlobs.get(candidatePath))]),
      )
      if (!sameJson(buildManifest.sourceSha256, expectedSourceHashes)) {
        errors.add('BUILD_MANIFEST_SOURCE_HASH_MISMATCH', context)
        binding = false
      }
    }
    artifact.app.buildManifestBinding = binding
  }

  const infoPath = path.join(appPath, 'Contents', 'Info.plist')
  try {
    artifact.app.infoPlistSha256 = await hashRegularFile(infoPath, dependencies)
  } catch {
    errors.add('INFO_PLIST_INVALID', context)
  }
  const info = await readPlistJson(infoPath, context, dependencies, errors)
  const englishLocalization = policy.localizations.find(localization => localization.locale === 'en')
  let englishPurposeStrings = null
  if (englishLocalization) {
    try {
      englishPurposeStrings = parseInfoPlistStrings(candidateBlobs.get(englishLocalization.sourcePath))
    } catch {
      errors.add('LOCALIZATION_SOURCE_INVALID', { ...context, detail: 'en' })
    }
  }
  if (info) {
    artifact.app.bundleIdentifier = info.CFBundleIdentifier ?? null
    artifact.app.version = info.CFBundleShortVersionString ?? null
    artifact.app.buildVersion = info.CFBundleVersion ?? null
    artifact.app.minimumSystemVersion = info.LSMinimumSystemVersion ?? null
    if (info.CFBundleIdentifier !== policy.app.bundleIdentifier) {
      errors.add('BUNDLE_IDENTIFIER_MISMATCH', context)
    }
    if (info.CFBundleName !== policy.app.productName) errors.add('PRODUCT_NAME_MISMATCH', context)
    if (
      info.CFBundleShortVersionString !== packageManifest.version
      || info.CFBundleVersion !== packageManifest.version
    ) {
      errors.add('VERSION_MISMATCH', context)
    }
    const minimumVersionComparison = compareVersions(
      info.LSMinimumSystemVersion,
      policy.app.minimumSystemVersion,
    )
    if (minimumVersionComparison === null || minimumVersionComparison < 0) {
      errors.add('MINIMUM_SYSTEM_VERSION_MISMATCH', context)
    }
    if (Object.keys(info).some(key => /^\d+$/u.test(key) || key === 'length')) {
      errors.add('INFO_PLIST_INVALID', { ...context, detail: 'numeric-or-length-key' })
    }
    const presentPrivacyKeys = Object.keys(info)
      .filter(key => /^NS.*UsageDescription$/u.test(key))
      .sort(compareText)
    if (!sameJson(presentPrivacyKeys, [...policy.privacyKeys].sort(compareText))) {
      errors.add('PRIVACY_KEY_SET_MISMATCH', context)
    }
    if (
      englishPurposeStrings
      && policy.privacyKeys.some(key => info[key] !== englishPurposeStrings[key])
    ) {
      errors.add('PRIVACY_VALUE_MISMATCH', context)
    }
    if (policy.privacyKeys.some(key => typeof info[key] !== 'string' || info[key].trim() === '')) {
      errors.add('PRIVACY_VALUE_MISMATCH', context)
    }
  }

  for (const localization of [...policy.localizations].sort((left, right) => compareText(left.locale, right.locale))) {
    const localizedPath = path.join(appPath, ...localization.bundlePath.split('/'))
    const localizedRecord = {
      locale: localization.locale,
      sha256: null,
      sourceMatches: false,
      keysMatch: false,
    }
    try {
      const content = await dependencies.readFile(localizedPath)
      localizedRecord.sha256 = sha256(content)
      localizedRecord.sourceMatches = content.equals(candidateBlobs.get(localization.sourcePath))
      if (!localizedRecord.sourceMatches) {
        errors.add('LOCALIZATION_CONTENT_MISMATCH', { ...context, detail: localization.locale })
      }
      const parsed = parseInfoPlistStrings(content)
      localizedRecord.keysMatch = sameJson(
        Object.keys(parsed).sort(compareText),
        [...policy.privacyKeys].sort(compareText),
      )
      if (!localizedRecord.keysMatch) {
        errors.add('LOCALIZATION_KEY_SET_MISMATCH', { ...context, detail: localization.locale })
      }
      if (Object.values(parsed).some(value => typeof value !== 'string' || value.trim() === '')) {
        errors.add('LOCALIZATION_VALUE_INVALID', { ...context, detail: localization.locale })
      }
    } catch {
      errors.add('LOCALIZATION_MISSING', { ...context, detail: localization.locale })
    }
    artifact.app.localizedPurposeStrings.push(localizedRecord)
  }

  artifact.signature.exactVerify = await verifyExactSignature(
    appPath,
    { ...context, teamIdentifier: policy.teamIdentifier },
    dependencies,
    errors,
  )
  for (const bundlePath of nestedBundlePaths(inventoryBefore.nativeBinaries)) {
    await verifyExactSignature(
      path.join(appPath, ...bundlePath.split('/')),
      { ...context, path: bundlePath, teamIdentifier: policy.teamIdentifier },
      dependencies,
      errors,
    )
  }

  let mainEntitlements = {}
  let helperEntitlements = {}
  try {
    mainEntitlements = parseBooleanEntitlements(candidateBlobs.get(policy.entitlements.main))
    helperEntitlements = parseBooleanEntitlements(candidateBlobs.get(policy.entitlements.helper))
  } catch {
    errors.add('POLICY_ENTITLEMENTS_INVALID', context)
  }

  const helperIdentifiers = new Set()
  const filesystemNative = inventoryBefore.nativeBinaries
    .filter(binary => binary.source === 'filesystem' && binary.role !== 'wasm')
    .sort((left, right) => compareText(left.path, right.path))
  for (const binary of filesystemNative) {
    const helperPath = helperBundlePath(binary.path)
    let expectedEntitlements = {}
    let expectedIdentifier = null
    if (binary.role === 'main-executable') {
      expectedEntitlements = mainEntitlements
      expectedIdentifier = policy.app.bundleIdentifier
    } else if (helperPath) {
      const helperInfo = await readPlistJson(
        path.join(appPath, ...helperPath.split('/'), 'Contents', 'Info.plist'),
        { ...context, path: helperPath },
        dependencies,
        errors,
      )
      expectedIdentifier = helperInfo?.CFBundleIdentifier ?? null
      if (expectedIdentifier) helperIdentifiers.add(expectedIdentifier)
      if (!policy.app.helperBundleIdentifiers.includes(expectedIdentifier)) {
        errors.add('HELPER_BUNDLE_IDENTIFIER_MISMATCH', { ...context, path: helperPath })
      }
      expectedEntitlements = helperEntitlements
    }
    const codeObject = await inspectCodeObject({
      absolutePath: path.join(appPath, ...binary.path.split('/')),
      architectures: binary.architectures,
      context,
      dependencies,
      errors,
      expectedEntitlements,
      expectedIdentifier,
      policy,
      relativePath: binary.path,
      role: binary.role,
    })
    artifact.signature.codeObjects.push(codeObject)
  }
  if (!sameJson([...helperIdentifiers].sort(compareText), [...policy.app.helperBundleIdentifiers].sort(compareText))) {
    errors.add('HELPER_BUNDLE_SET_MISMATCH', context)
  }
  const mainCodeObject = artifact.signature.codeObjects.find(object => object.role === 'main-executable')
  artifact.signature.teamIdentifier = mainCodeObject?.slices[0]?.teamIdentifier ?? null

  const deep = await runCheckedTool(dependencies, '/usr/bin/codesign', [
    '--verify',
    '--deep',
    '--strict',
    '--verbose=2',
    '--all-architectures',
    appPath,
  ])
  artifact.signature.deepVerifySupplemental = deep.exitCode === 0
  if (deep.exitCode !== 0) errors.add('CODESIGN_DEEP_VERIFY_FAILED', context)

  try {
    const inventoryAfter = await dependencies.collectAppInventory(appPath)
    if (inventoryAfter.contentSha256 !== inventoryBefore.contentSha256) {
      errors.add('INPUT_CHANGED_DURING_VERIFICATION', context)
    }
  } catch {
    errors.add('INPUT_CHANGED_DURING_VERIFICATION', context)
  }
  return artifact
}

async function verifyDmgArtifact(options) {
  const { architecture, dependencies, dmgPath, errors, policy } = options
  const context = { architecture }
  const result = { sha256: null, signatureVerified: false, staplerValidate: false, notaryLogHashMatches: false }
  if (!path.isAbsolute(dmgPath) || !await fileExistsAsType(dmgPath, 'file', dependencies)) {
    errors.add('DMG_INVALID', context)
    return result
  }
  result.sha256 = await hashRegularFile(dmgPath, dependencies)
  result.signatureVerified = await verifyExactSignature(
    dmgPath,
    { ...context, teamIdentifier: policy.teamIdentifier },
    dependencies,
    errors,
  )
  const display = await runCheckedTool(dependencies, '/usr/bin/codesign', ['-d', '--verbose=4', dmgPath])
  if (display.exitCode !== 0) {
    errors.add('SIGNATURE_METADATA_UNAVAILABLE', context)
  } else {
    try {
      const metadata = parseCodesignDisplay(`${display.stdout}\n${display.stderr}`)
      inspectSignatureMetadata(
        metadata,
        { identifier: null, requireRuntime: false, teamIdentifier: policy.teamIdentifier },
        context,
        errors,
      )
    } catch {
      errors.add('SIGNATURE_METADATA_UNAVAILABLE', context)
    }
  }
  return result
}

export function computeArtifactSetSha256(candidateCommit, artifacts) {
  const canonical = artifacts
    .map(artifact => ({
      architecture: artifact.architecture,
      appContentSha256: artifact.app.contentSha256,
      dmgSha256: artifact.dmg.sha256,
    }))
    .sort((left, right) => compareText(left.architecture, right.architecture))
  return sha256(`${JSON.stringify({ candidateCommit, artifacts: canonical })}\n`)
}

export function canonicalManualEvidenceBytes(evidence, role) {
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
    throw new Error('MANUAL_EVIDENCE_INVALID')
  }
  if (
    !['operator', 'approver'].includes(role)
    || !TRUST_POLICY_ID.test(evidence.policyId ?? '')
    || !SHA256.test(evidence.trustBundleSha256 ?? '')
  ) {
    throw new Error('MANUAL_EVIDENCE_INVALID')
  }
  const unsigned = { ...evidence }
  delete unsigned.signatures
  if (Array.isArray(unsigned.checks)) {
    unsigned.checks = unsigned.checks
      .map(check => ({
        ...check,
        evidence: Array.isArray(check?.evidence)
          ? [...check.evidence].sort((left, right) => compareText(
            `${left?.path ?? ''}\u0000${left?.sha256 ?? ''}`,
            `${right?.path ?? ''}\u0000${right?.sha256 ?? ''}`,
          ))
          : check?.evidence,
      }))
      .sort((left, right) => compareText(left?.id ?? '', right?.id ?? ''))
  }
  const domain = Buffer.from(
    `OpenPipal/macOS-manual-evidence/v3\u0000${role}\u0000${evidence.policyId}\u0000${evidence.trustBundleSha256}\u0000`,
  )
  const canonical = Buffer.from(`${JSON.stringify(stableObject(unsigned))}\n`)
  return Buffer.concat([domain, canonical])
}

async function runOnlineChecks(options) {
  const {
    artifacts,
    dependencies,
    errors,
    notaryProfile,
    notarySubmissions,
    onlineNotary,
    policy,
    stagedApps,
    stagedDmgs,
  } = options
  if (onlineNotary !== true) {
    errors.add('ONLINE_NOTARY_REQUIRED')
    return
  }
  if (typeof notaryProfile !== 'string' || notaryProfile.length === 0) {
    errors.add('NOTARY_PROFILE_REQUIRED')
    return
  }
  for (const artifact of artifacts) {
    const architecture = artifact.architecture
    const context = { architecture }
    const submission = notarySubmissions?.[architecture]
    if (typeof submission !== 'string' || !/^[0-9a-f-]{36}$/iu.test(submission)) {
      errors.add('NOTARY_SUBMISSION_ID_MISSING', context)
      continue
    }
    const info = await runCheckedTool(dependencies, '/usr/bin/xcrun', [
      'notarytool',
      'info',
      submission,
      '--keychain-profile',
      notaryProfile,
      '--output-format',
      'json',
      '--no-progress',
    ], { timeout: 60_000 })
    let infoJson = null
    if (info.exitCode !== 0) {
      errors.add('NOTARY_INFO_FAILED', context)
    } else {
      try {
        infoJson = parseJson(info.stdout, 'NOTARY_INFO_FAILED')
      } catch {
        errors.add('NOTARY_INFO_FAILED', context)
      }
    }
    if (infoJson?.status !== 'Accepted') errors.add('NOTARY_STATUS_NOT_ACCEPTED', context)

    const log = await runCheckedTool(dependencies, '/usr/bin/xcrun', [
      'notarytool',
      'log',
      submission,
      '--keychain-profile',
      notaryProfile,
    ], { timeout: 60_000 })
    let logJson = null
    if (log.exitCode !== 0) {
      errors.add('NOTARY_LOG_INVALID', context)
    } else {
      try {
        logJson = parseJson(log.stdout, 'NOTARY_LOG_INVALID')
      } catch {
        errors.add('NOTARY_LOG_INVALID', context)
      }
    }
    artifact.dmg.notaryLogHashMatches =
      typeof logJson?.sha256 === 'string'
      && logJson.sha256.toLowerCase() === artifact.dmg.sha256
    if (!artifact.dmg.notaryLogHashMatches) errors.add('NOTARY_ARTIFACT_HASH_MISMATCH', context)

    const appPath = stagedApps[architecture]
    const dmgPath = stagedDmgs[architecture]
    const stapleResults = []
    const notarizationResults = []
    for (const targetPath of [appPath, dmgPath]) {
      const staple = await runCheckedTool(
        dependencies,
        '/usr/bin/xcrun',
        ['stapler', 'validate', '-v', targetPath],
        { timeout: 60_000 },
      )
      stapleResults.push(staple.exitCode === 0)
      if (staple.exitCode !== 0) errors.add('STAPLER_VALIDATE_FAILED', context)
      const notarization = await runCheckedTool(dependencies, '/usr/bin/codesign', [
        '--verify',
        '--check-notarization',
        '--strict',
        targetPath,
      ], { timeout: 60_000 })
      notarizationResults.push(notarization.exitCode === 0)
      if (notarization.exitCode !== 0) errors.add('ONLINE_NOTARIZATION_CHECK_FAILED', context)
    }
    artifact.signature.staplerValidate = stapleResults[0] === true
    artifact.signature.onlineNotarizationCheck = notarizationResults[0] === true
    artifact.dmg.staplerValidate = stapleResults[1] === true
    const spctl = await runCheckedTool(dependencies, '/usr/sbin/spctl', [
      '--assess',
      '--type',
      'execute',
      '--ignore-cache',
      '--no-cache',
      '--raw',
      appPath,
    ], { timeout: 60_000 })
    artifact.signature.gatekeeperAssess = spctl.exitCode === 0
    if (spctl.exitCode !== 0) errors.add('GATEKEEPER_ASSESS_FAILED', context)

    try {
      const afterApp = await dependencies.collectAppInventory(appPath)
      const afterDmg = await hashRegularFile(dmgPath, dependencies)
      if (afterApp.contentSha256 !== artifact.app.contentSha256 || afterDmg !== artifact.dmg.sha256) {
        errors.add('ARTIFACT_MUTATED_BY_CHECK', context)
      }
    } catch {
      errors.add('ARTIFACT_MUTATED_BY_CHECK', context)
    }
    if (artifact.signature.teamIdentifier !== policy.teamIdentifier) {
      errors.add('TEAM_IDENTIFIER_MISMATCH', context)
    }
  }
}

async function verifyManualEvidence(options) {
  const {
    artifactSetSha256,
    candidateCommit,
    dependencies,
    errors,
    manualEvidencePath,
    policy,
    report,
    trustBundleSha256,
  } = options
  if (typeof manualEvidencePath !== 'string' || !path.isAbsolute(manualEvidencePath)) {
    errors.add('MANUAL_EVIDENCE_MISSING', { manual: true })
    return
  }
  let evidence
  try {
    const raw = await readPinnedRegularFile(
      manualEvidencePath,
      MAX_MANUAL_EVIDENCE_BYTES,
      dependencies,
    )
    const text = new TextDecoder('utf-8', { fatal: true }).decode(raw)
    evidence = parseJson(text, 'MANUAL_EVIDENCE_INVALID')
  } catch (error) {
    errors.add(error?.code === 'ENOENT' ? 'MANUAL_EVIDENCE_MISSING' : 'MANUAL_EVIDENCE_INVALID', {
      manual: true,
    })
    return
  }
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
    errors.add('MANUAL_EVIDENCE_INVALID', { manual: true })
    return
  }
  let complete = true
  const reject = code => {
    errors.add(code, { manual: true })
    complete = false
  }
  if (!sameJson(Object.keys(evidence).sort(compareText), [
    'approver',
    'artifactSetSha256',
    'candidateCommit',
    'checks',
    'operator',
    'policyId',
    'schemaVersion',
    'signatureDomain',
    'signatures',
    'status',
    'trustBundleSha256',
  ])) {
    reject('MANUAL_EVIDENCE_INVALID')
  }
  const operator = normalizedApprovalIdentity(evidence.operator)
  const approver = normalizedApprovalIdentity(evidence.approver)
  if (
    evidence.schemaVersion !== 3
    || evidence.status !== 'APPROVED'
    || evidence.policyId !== policy.policyId
    || evidence.signatureDomain !== policy.manualEvidence.signatureDomain
    || evidence.signatureDomain !== MANUAL_SIGNATURE_DOMAIN
    || evidence.trustBundleSha256 !== trustBundleSha256
    || operator === null
    || approver === null
    || operator === approver
    || operator !== policy.manualEvidence.operator.identity
    || approver !== policy.manualEvidence.approver.identity
  ) {
    reject('MANUAL_EVIDENCE_INVALID')
  }
  if (
    !evidence.signatures
    || typeof evidence.signatures !== 'object'
    || Array.isArray(evidence.signatures)
    || !sameJson(Object.keys(evidence.signatures).sort(compareText), ['approver', 'operator'])
  ) {
    reject('MANUAL_SIGNATURE_INVALID')
  }
  for (const role of ['operator', 'approver']) {
    const signerPolicy = policy.manualEvidence[role]
    const signatureRecord = evidence.signatures?.[role]
    let verified
    try {
      const canonicalEvidence = canonicalManualEvidenceBytes(evidence, role)
      if (
        !signatureRecord
        || typeof signatureRecord !== 'object'
        || Array.isArray(signatureRecord)
        || !sameJson(Object.keys(signatureRecord).sort(compareText), [
          'algorithm',
          'keyId',
          'signatureBase64',
        ])
        || signatureRecord.algorithm !== policy.manualEvidence.signatureAlgorithm
        || signatureRecord.keyId !== signerPolicy.keyId
      ) {
        throw new Error('invalid-signature-record')
      }
      const signature = decodeCanonicalBase64(signatureRecord.signatureBase64)
      if (!signature || signature.length !== 64) throw new Error('invalid-signature-encoding')
      const { key } = manualSignerPublicKey(signerPolicy)
      verified = verifyCryptoSignature(null, canonicalEvidence, key, signature)
    } catch {
      verified = false
    }
    report.manualEvidence.signaturesVerified[role] = verified
    if (!verified) reject('MANUAL_SIGNATURE_INVALID')
  }
  if (evidence.candidateCommit !== candidateCommit || evidence.artifactSetSha256 !== artifactSetSha256) {
    reject('MANUAL_BINDING_MISMATCH')
  } else {
    report.manualEvidence.artifactSetBindingMatches = true
  }
  if (!Array.isArray(evidence.checks)) {
    reject('MANUAL_EVIDENCE_INVALID')
    return
  }
  const checkById = new Map()
  for (const check of evidence.checks) {
    if (
      !check
      || typeof check !== 'object'
      || Array.isArray(check)
      || !sameJson(Object.keys(check).sort(compareText), ['evidence', 'id', 'status'])
      || typeof check.id !== 'string'
      || checkById.has(check.id)
    ) {
      reject('MANUAL_EVIDENCE_INVALID')
      continue
    }
    checkById.set(check.id, check)
  }
  const evidenceRoot = path.dirname(manualEvidencePath)
  for (const id of [...policy.manualCheckIds].sort(compareText)) {
    const check = checkById.get(id)
    const checkRecord = { id, status: check?.status ?? 'MISSING', evidence: [] }
    if (!check || check.status !== 'PASS' || !Array.isArray(check.evidence) || check.evidence.length === 0) {
      errors.add('MANUAL_CHECK_NOT_APPROVED', { detail: id, manual: true })
      complete = false
      report.manualEvidence.checks.push(checkRecord)
      continue
    }
    const evidencePaths = new Set()
    for (const record of check.evidence) {
      let relativePath
      try {
        if (
          !record
          || typeof record !== 'object'
          || Array.isArray(record)
          || !sameJson(Object.keys(record).sort(compareText), ['path', 'sha256'])
        ) {
          throw new Error('invalid-evidence-record')
        }
        relativePath = normalizeCandidatePath(record?.path, 'evidence_path')
        if (evidencePaths.has(relativePath)) throw new Error('duplicate-evidence-path')
        evidencePaths.add(relativePath)
      } catch {
        errors.add('MANUAL_EVIDENCE_INVALID', { detail: id, manual: true })
        complete = false
        continue
      }
      let matches
      try {
        const absoluteEvidencePath = path.join(evidenceRoot, ...relativePath.split('/'))
        matches = SHA256.test(record.sha256 ?? '')
          && await hashRegularFile(absoluteEvidencePath, dependencies) === record.sha256
      } catch {
        matches = false
      }
      if (!matches) {
        errors.add('EVIDENCE_HASH_MISMATCH', { detail: id, manual: true, path: relativePath })
        complete = false
      }
      checkRecord.evidence.push({ path: relativePath, sha256: record.sha256 ?? null, matches })
    }
    checkRecord.evidence.sort((left, right) => compareText(left.path, right.path))
    report.manualEvidence.checks.push(checkRecord)
  }
  const unknownChecks = [...checkById.keys()].filter(id => !policy.manualCheckIds.includes(id))
  if (unknownChecks.length > 0) reject('MANUAL_EVIDENCE_INVALID')
  report.manualEvidence.complete = complete
  report.manualVerdict = complete ? 'PASS' : 'FAIL'
}

function dependencySet(overrides = {}) {
  return {
    collectAppInventory: null,
    copyArtifact: defaultCopyArtifact,
    createPrivateStagingDirectory: defaultCreatePrivateStagingDirectory,
    createPrivateStagingSubdirectory: defaultCreatePrivateStagingSubdirectory,
    environment: process.env,
    lstat,
    openFile: open,
    platform: process.platform,
    readCandidateBlob: defaultReadCandidateBlob,
    readFile,
    readRunningBuildManifestHook: defaultReadRunningBuildManifestHook,
    readRunningInventoryScript: () => readFile(INVENTORY_SCRIPT_PATH),
    readRunningScript: () => readFile(SCRIPT_PATH),
    removePrivateStagingDirectory: defaultRemovePrivateStagingDirectory,
    resolveCandidate: defaultResolveCandidate,
    runTool: defaultRunTool,
    setPrivateStagingMode: chmod,
    ...overrides,
  }
}

export async function verifyMacOSRelease(inputs, dependencyOverrides = {}) {
  const dependencies = dependencySet(dependencyOverrides)
  const report = baseReport()
  const errors = createErrorCollector()
  if (dependencies.platform !== 'darwin') errors.add('UNSUPPORTED_PLATFORM')
  if (!inputs || typeof inputs !== 'object') {
    errors.add('INVALID_ARGUMENTS')
    report.errors = errors.finish()
    report.counts.errors = report.errors.reduce((total, error) => total + error.count, 0)
    return report
  }
  const repo = inputs.repo
  const commit = inputs.candidate
  if (typeof repo !== 'string' || !path.isAbsolute(repo)) errors.add('INVALID_ARGUMENTS')
  if (!FULL_COMMIT.test(commit ?? '')) errors.add('EXACT_CANDIDATE_REQUIRED')

  let candidateResolved = false
  if (typeof repo === 'string' && path.isAbsolute(repo) && FULL_COMMIT.test(commit ?? '')) {
    try {
      const candidate = await dependencies.resolveCandidate(repo, commit)
      report.candidate = {
        commit,
        tree: candidate.tree,
        contentSha256: candidate.contentSha256 ?? null,
        exact: true,
      }
      candidateResolved = true
    } catch (error) {
      errors.add(error.message === 'EXACT_CANDIDATE_REQUIRED'
        ? error.message
        : 'CANDIDATE_OBJECT_READ_FAILED')
    }
  }

  let policy = null
  let policyRaw = null
  let candidateVerifier = null
  let runningVerifier = null
  let candidateInventory = null
  let runningInventory = null
  let candidateBuildManifestHook = null
  let runningBuildManifestHook = null
  if (candidateResolved) {
    try {
      policyRaw = await dependencies.readCandidateBlob(repo, commit, POLICY_PATH)
      policy = parseJson(policyRaw, 'MALFORMED_POLICY')
      report.policyBinding.loadedFromCandidate = true
      report.policyBinding.sha256 = sha256(policyRaw)
    } catch (error) {
      errors.add(error.message === 'MALFORMED_POLICY' ? error.message : 'POLICY_NOT_IN_CANDIDATE')
    }
    try {
      candidateVerifier = await dependencies.readCandidateBlob(repo, commit, SCRIPT_CANDIDATE_PATH)
      runningVerifier = await dependencies.readRunningScript()
      report.policyBinding.runningScriptMatchesCandidate = Buffer.from(candidateVerifier)
        .equals(Buffer.from(runningVerifier))
      if (!report.policyBinding.runningScriptMatchesCandidate) errors.add('VERIFIER_NOT_FROM_CANDIDATE')
    } catch {
      errors.add('VERIFIER_NOT_FROM_CANDIDATE')
    }
    try {
      candidateInventory = await dependencies.readCandidateBlob(
        repo,
        commit,
        INVENTORY_SCRIPT_CANDIDATE_PATH,
      )
      runningInventory = await dependencies.readRunningInventoryScript()
      report.policyBinding.runningInventoryMatchesCandidate = Buffer.from(candidateInventory)
        .equals(Buffer.from(runningInventory))
      if (!report.policyBinding.runningInventoryMatchesCandidate) {
        errors.add('INVENTORY_NOT_FROM_CANDIDATE')
      }
    } catch {
      errors.add('INVENTORY_NOT_FROM_CANDIDATE')
    }
    try {
      candidateBuildManifestHook = await dependencies.readCandidateBlob(
        repo,
        commit,
        BUILD_MANIFEST_HOOK_CANDIDATE_PATH,
      )
      runningBuildManifestHook = await dependencies.readRunningBuildManifestHook()
      report.policyBinding.runningBuildManifestHookMatchesCandidate = Buffer.from(
        candidateBuildManifestHook,
      ).equals(Buffer.from(runningBuildManifestHook))
      if (!report.policyBinding.runningBuildManifestHookMatchesCandidate) {
        errors.add('BUILD_MANIFEST_HOOK_NOT_FROM_CANDIDATE')
      }
    } catch {
      errors.add('BUILD_MANIFEST_HOOK_NOT_FROM_CANDIDATE')
    }
  }

  const policyValid = policy ? validatePolicy(policy, report.candidate, errors) : false
  const protectedTrust = await loadProtectedTrustBundle(dependencies, errors, report)
  const protectedTrustValid = validateProtectedTrustBundle(protectedTrust, {
    candidateBuildManifestHook,
    candidateInventory,
    candidateVerifier,
    policy,
    policyRaw,
    runningBuildManifestHook,
    runningInventory,
    runningVerifier,
  }, errors, report)
  report.policyBinding.matches =
    policyValid
    && protectedTrustValid
    && report.policyBinding.loadedFromCandidate
    && report.policyBinding.runningBuildManifestHookMatchesCandidate
    && report.policyBinding.runningScriptMatchesCandidate
    && report.policyBinding.runningInventoryMatchesCandidate

  if (report.policyBinding.matches && typeof dependencies.collectAppInventory !== 'function') {
    try {
      const inventoryModule = await import(pathToFileURL(INVENTORY_SCRIPT_PATH).href)
      dependencies.collectAppInventory = inventoryModule.collectAppInventory
    } catch {
      errors.add('INVENTORY_MODULE_LOAD_FAILED')
      report.policyBinding.matches = false
    }
  }

  const candidateBlobs = new Map()
  let packageManifest = null
  if (report.policyBinding.matches) {
    for (const candidatePath of policy.sourcePaths) {
      try {
        const content = candidatePath === POLICY_PATH
          ? policyRaw
          : await dependencies.readCandidateBlob(repo, commit, candidatePath)
        candidateBlobs.set(candidatePath, Buffer.from(content))
      } catch {
        errors.add('CANDIDATE_SOURCE_MISSING', { path: candidatePath })
      }
    }
    try {
      packageManifest = parseJson(candidateBlobs.get('package.json'), 'CANDIDATE_PACKAGE_INVALID')
      if (typeof packageManifest.version !== 'string' || !packageManifest.version) {
        throw new Error('CANDIDATE_PACKAGE_INVALID')
      }
    } catch {
      errors.add('CANDIDATE_PACKAGE_INVALID')
      packageManifest = null
    }
  }

  const inputArchitectures = Object.keys(inputs.apps ?? {}).sort(compareText)
  const dmgArchitectures = Object.keys(inputs.dmgs ?? {}).sort(compareText)
  if (!sameJson(inputArchitectures, ARCHITECTURES) || !sameJson(dmgArchitectures, ARCHITECTURES)) {
    errors.add('ARCHITECTURE_SET_MISMATCH')
  }

  if (
    report.policyBinding.matches
    && candidateBlobs.size === policy.sourcePaths.length
    && packageManifest
    && sameJson(inputArchitectures, ARCHITECTURES)
    && sameJson(dmgArchitectures, ARCHITECTURES)
  ) {
    const staging = await stageReleaseArtifacts(inputs, dependencies, errors, report)
    try {
      if (!staging.ready) {
        errors.add('AUTOMATED_CHECKS_INCOMPLETE')
        errors.add('MANUAL_EVIDENCE_UNVERIFIED', { manual: true })
      } else {
        for (const architecture of ARCHITECTURES) {
          const artifact = await verifyAppArtifact({
            appPath: staging.apps[architecture],
            architecture,
            candidate: report.candidate,
            candidateBlobs,
            dependencies,
            errors,
            packageManifest,
            policy,
          })
          artifact.dmg = await verifyDmgArtifact({
            architecture,
            dependencies,
            dmgPath: staging.dmgs[architecture],
            errors,
            policy,
          })
          report.artifacts.push(artifact)
        }
        const artifactSetSha256 = computeArtifactSetSha256(commit, report.artifacts)
        report.artifactSetBinding = {
          sha256: artifactSetSha256,
          architectures: report.artifacts.map(artifact => artifact.architecture).sort(compareText),
          sameCandidate: report.artifacts.every(artifact => artifact.app.buildManifestBinding),
          sameBundleIdentifier: report.artifacts.every(
            artifact => artifact.app.bundleIdentifier === policy.app.bundleIdentifier,
          ),
          sameTeamIdentifier: report.artifacts.every(
            artifact => artifact.signature.teamIdentifier === policy.teamIdentifier,
          ),
          matches: false,
        }
        report.artifactSetBinding.matches =
          report.artifactSetBinding.sameCandidate
          && report.artifactSetBinding.sameBundleIdentifier
          && report.artifactSetBinding.sameTeamIdentifier
          && sameJson(report.artifactSetBinding.architectures, ARCHITECTURES)

        await runOnlineChecks({
          artifacts: report.artifacts,
          dependencies,
          errors,
          notaryProfile: inputs.notaryProfile,
          notarySubmissions: inputs.notarySubmissions,
          onlineNotary: inputs.onlineNotary,
          policy,
          stagedApps: staging.apps,
          stagedDmgs: staging.dmgs,
        })
        await verifyManualEvidence({
          artifactSetSha256,
          candidateCommit: commit,
          dependencies,
          errors,
          manualEvidencePath: inputs.manualEvidence,
          policy,
          report,
          trustBundleSha256: report.protectedTrust.sha256,
        })
      }
    } catch {
      errors.add('VERIFICATION_INTERNAL_ERROR')
      errors.add('MANUAL_EVIDENCE_UNVERIFIED', { manual: true })
    } finally {
      const finalDigestsMatch = staging.root
        ? await recheckStagedArtifacts(staging, dependencies, errors)
        : false
      report.stagingBinding.finalMatches = staging.ready && finalDigestsMatch
      await cleanupPrivateStaging(staging.root, dependencies, errors, report)
    }
  } else {
    if (inputs.onlineNotary !== true) errors.add('ONLINE_NOTARY_REQUIRED')
    if (typeof inputs.manualEvidence !== 'string') {
      errors.add('MANUAL_EVIDENCE_MISSING', { manual: true })
    }
  }

  const finishedErrors = errors.finish()
  const automatedErrors = finishedErrors.filter(error => error.manual !== true)
  const manualErrors = finishedErrors.filter(error => error.manual === true)
  report.errors = finishedErrors.map(error => ({ ...error }))
  report.automatedVerdict = automatedErrors.length === 0 ? 'PASS' : 'FAIL'
  if (report.manualVerdict === 'MISSING' && manualErrors.length > 0) report.manualVerdict = 'FAIL'
  report.verdict = finishedErrors.length === 0 && report.manualVerdict === 'PASS' ? 'PASS' : 'FAIL'
  report.counts = {
    artifacts: report.artifacts.length,
    codeObjects: report.artifacts.reduce(
      (total, artifact) => total + artifact.signature.codeObjects.length,
      0,
    ),
    manualChecks: report.manualEvidence.checks.length,
    errors: finishedErrors.reduce((total, error) => total + error.count, 0),
  }
  return report
}

function parseMappedValue(value, target) {
  const separator = value.indexOf('=')
  if (separator <= 0 || separator === value.length - 1) throw new Error('INVALID_ARGUMENTS')
  const architecture = value.slice(0, separator)
  const mappedValue = value.slice(separator + 1)
  if (!ARCHITECTURES.includes(architecture) || Object.hasOwn(target, architecture)) {
    throw new Error('INVALID_ARGUMENTS')
  }
  target[architecture] = mappedValue
}

export function parseArguments(argv) {
  const result = {
    apps: {},
    dmgs: {},
    notarySubmissions: {},
    onlineNotary: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--online-notary') {
      if (result.onlineNotary) throw new Error('INVALID_ARGUMENTS')
      result.onlineNotary = true
      continue
    }
    const value = argv[index + 1]
    if (!value) throw new Error('INVALID_ARGUMENTS')
    index += 1
    if (argument === '--repo' && result.repo === undefined) result.repo = value
    else if (argument === '--candidate' && result.candidate === undefined) result.candidate = value
    else if (argument === '--manual-evidence' && result.manualEvidence === undefined) result.manualEvidence = value
    else if (argument === '--notary-profile' && result.notaryProfile === undefined) result.notaryProfile = value
    else if (argument === '--app') parseMappedValue(value, result.apps)
    else if (argument === '--dmg') parseMappedValue(value, result.dmgs)
    else if (argument === '--notary-submission') parseMappedValue(value, result.notarySubmissions)
    else throw new Error('INVALID_ARGUMENTS')
  }
  return result
}

function failureReport(code = 'INVALID_ARGUMENTS') {
  const report = baseReport()
  report.errors = [{ code, count: 1 }]
  report.counts.errors = 1
  return report
}

async function runCli() {
  let inputs
  try {
    inputs = parseArguments(process.argv.slice(2))
  } catch {
    const report = failureReport()
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    process.exitCode = 1
    return
  }
  let report
  try {
    report = await verifyMacOSRelease(inputs)
  } catch {
    report = failureReport('VERIFICATION_FAILED')
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  process.exitCode = report.verdict === 'PASS' ? 0 : 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runCli().catch(() => {
    const report = failureReport('VERIFICATION_FAILED')
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    process.exitCode = 1
  })
}
