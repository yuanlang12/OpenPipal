import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import { cp, lstat, mkdir, mkdtemp, open, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  canonicalManualEvidenceBytes,
  computeArtifactSetSha256,
  parseArguments,
  verifyMacOSRelease,
} from '../../scripts/verify-macos-release.mjs'

const COMMIT = 'a'.repeat(40)
const TREE = 'b'.repeat(40)
const CANDIDATE_CONTENT_SHA256 = 'c'.repeat(64)
const TEAM_ID = 'ABCDEFGHIJ'
const SUBMISSIONS = {
  arm64: '11111111-1111-1111-1111-111111111111',
  x86_64: '22222222-2222-2222-2222-222222222222',
}
const MANUAL_CHECK_IDS = [
  'DMG_CONTAINED_APP_MATCH',
  'FRESH_INSTALL_AND_FIRST_LAUNCH',
  'LOCALIZED_PRIVACY_PROMPTS_EN',
  'LOCALIZED_PRIVACY_PROMPTS_ZH_HANS',
  'TCC_MICROPHONE',
  'TCC_CAMERA',
  'TCC_LOCATION',
  'TCC_APPLE_EVENTS_FOCUS_PASTE',
  'TCC_ACCESSIBILITY',
  'TCC_EXTERNAL_WINDOW_SCREEN_RECORDING',
  'NATIVE_IMAGE_CANVAS_ESBUILD',
  'PHOTON_WASM',
  'RUNTIME_CHAT',
  'DESIGN_ARTIFACT',
  'ARM64_HARDWARE_FLOW',
  'X86_64_HARDWARE_FLOW',
]
const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { force: true, recursive: true })))
})

function digest(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex')
}

async function writeFixture(root: string, relativePath: string, content: string | Buffer) {
  const absolutePath = path.join(root, ...relativePath.split('/'))
  await mkdir(path.dirname(absolutePath), { recursive: true })
  await writeFile(absolutePath, content)
  return absolutePath
}

function entitlementPlist(keys: string[]): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<plist version="1.0">',
    '<dict>',
    ...keys.flatMap(key => [`<key>${key}</key>`, '<true/>']),
    '</dict>',
    '</plist>',
    '',
  ].join('\n')
}

function plistStrings(values: Record<string, string>): string {
  return `${Object.entries(values)
    .map(([key, value]) => `${JSON.stringify(key)} = ${JSON.stringify(value)};`)
    .join('\n')}\n`
}

function infoPlistXml(duplicateBundleIdentifier = false): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<plist version="1.0">',
    '<dict>',
    '<key>CFBundleIdentifier</key>',
    '<string>com.openpipal.app</string>',
    ...(duplicateBundleIdentifier
      ? ['<key >CFBundleIdentifier</key >', '<string>com.openpipal.duplicate</string>']
      : []),
    '<key>CFBundleName</key>',
    '<string>OpenPipal</string>',
    '</dict>',
    '</plist>',
    '',
  ].join('\n')
}

function helperFixtures(architecture: string) {
  return [
    ['OpenPipal Helper.app', 'OpenPipal Helper', 'com.openpipal.app.helper'],
    ['OpenPipal Helper (GPU).app', 'OpenPipal Helper (GPU)', 'com.openpipal.app.helper.GPU'],
    ['OpenPipal Helper (Plugin).app', 'OpenPipal Helper (Plugin)', 'com.openpipal.app.helper.Plugin'],
    ['OpenPipal Helper (Renderer).app', 'OpenPipal Helper (Renderer)', 'com.openpipal.app.helper.Renderer'],
  ].map(([bundle, executable, identifier]) => ({
    architectures: [architecture],
    identifier,
    path: `Contents/Frameworks/${bundle}/Contents/MacOS/${executable}`,
    role: 'executable',
    source: 'filesystem',
  }))
}

interface FixtureOptions {
  afterDigest?: string
  candidateContentMismatch?: boolean
  codesignDisplay?: (target: string, architecture: string | null, base: string) => string
  duplicateInfoKey?: boolean
  emptyPurpose?: boolean
  entitlementWarning?: boolean
  entitlementFor?: (target: string, base: string) => string
  exactFailurePath?: string
  extraPrivacyKey?: boolean
  invalidMinimumVersion?: boolean
  localizedMismatch?: boolean
  online?: boolean
  manualIdentityWhitespace?: boolean
  manualDuplicateKey?: boolean
  manualPolicyKeyIdMismatch?: boolean
  manualPolicyPending?: boolean
  manualSignatureDomainMismatch?: boolean
  manualSignatureTruncated?: boolean
  manualUnsigned?: boolean
  policyPending?: boolean
  policyPendingWhitespace?: boolean
  policyIdentityWhitespace?: boolean
  policyDuplicateKey?: boolean
  sourceSwapDuringCopy?: boolean
  stagingCopyMismatch?: boolean
  staplerFailure?: boolean
}

interface BuildManifestFixture {
  architecture: string
  candidateCommit: string
  candidateContentSha256: string
  candidateTree?: string
  schemaVersion: number
  sourceSha256: Record<string, string>
  untrusted?: boolean
}

async function createReleaseFixture(options: FixtureOptions = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'openpipal-macos-release-test-'))
  temporaryRoots.push(root)
  const repo = path.join(root, 'repo')
  const output = path.join(root, 'output')
  const evidenceRoot = path.join(root, 'evidence')
  await Promise.all([mkdir(repo), mkdir(output), mkdir(evidenceRoot)])

  const privacyKeys = [
    'NSAppleEventsUsageDescription',
    'NSCameraUsageDescription',
    'NSLocationUsageDescription',
    'NSLocationWhenInUseUsageDescription',
    'NSMicrophoneUsageDescription',
    'NSScreenCaptureUsageDescription',
  ]
  const englishValues = Object.fromEntries(privacyKeys.map(key => [key, `English purpose for ${key}`]))
  const chineseValues = Object.fromEntries(privacyKeys.map(key => [key, `中文用途说明 ${key}`]))
  const english = plistStrings(englishValues)
  const chinese = plistStrings(chineseValues)
  const mainEntitlements = entitlementPlist([
    'com.apple.security.automation.apple-events',
    'com.apple.security.cs.allow-jit',
  ])
  const helperEntitlements = entitlementPlist(['com.apple.security.cs.allow-jit'])
  const scriptBlob = Buffer.from('candidate verifier fixture\n')
  const inventoryScriptBlob = Buffer.from('candidate inventory fixture\n')
  const buildManifestHookBlob = Buffer.from('candidate build manifest hook fixture\n')
  const packageJson = Buffer.from('{"name":"openpipal","version":"1.1.7"}\n')
  const packageLock = Buffer.from('{"name":"openpipal","version":"1.1.7","lockfileVersion":3}\n')
  const builder = Buffer.from('appId: com.openpipal.app\n')
  const releaseBuilder = Buffer.from('extends: ./electron-builder.yml\n')
  const operatorKeys = generateKeyPairSync('ed25519')
  const approverKeys = generateKeyPairSync('ed25519')
  const exportPublicKey = (publicKey: typeof operatorKeys.publicKey) => Buffer.from(publicKey.export({
    format: 'der',
    type: 'spki',
  }))
  const operatorPublicKey = exportPublicKey(operatorKeys.publicKey)
  const approverPublicKey = exportPublicKey(approverKeys.publicKey)
  const operatorKeyId = digest(operatorPublicKey)
  const approverKeyId = digest(approverPublicKey)

  const policy = {
    schemaVersion: 1,
    policyId: 'fixture-policy',
    evidenceOnly: true,
    publicReleaseClearance: false,
    candidateContentSha256: options.policyPending || options.policyPendingWhitespace
      ? options.policyPendingWhitespace ? ' PENDING ' : 'PENDING'
      : options.candidateContentMismatch ? 'd'.repeat(64) : CANDIDATE_CONTENT_SHA256,
    review: {
      owner: options.policyIdentityWhitespace
        ? 'release-owner '
        : options.policyPending || options.policyPendingWhitespace
        ? options.policyPendingWhitespace ? ' PENDING ' : 'PENDING'
        : 'release-owner',
      approver: options.policyIdentityWhitespace
        ? 'release-owner'
        : options.policyPending || options.policyPendingWhitespace ? 'PENDING' : 'release-approver',
      candidate: 'SELF',
      status: options.policyPending || options.policyPendingWhitespace ? 'PENDING' : 'APPROVED',
    },
    teamIdentifier: options.policyPending || options.policyPendingWhitespace
      ? options.policyPendingWhitespace ? ' PENDING ' : 'PENDING'
      : TEAM_ID,
    architectures: ['arm64', 'x86_64'],
    app: {
      name: 'OpenPipal.app',
      bundleIdentifier: 'com.openpipal.app',
      productName: 'OpenPipal',
      minimumSystemVersion: '12.0',
      helperBundleIdentifiers: [
        'com.openpipal.app.helper',
        'com.openpipal.app.helper.GPU',
        'com.openpipal.app.helper.Plugin',
        'com.openpipal.app.helper.Renderer',
      ],
    },
    buildManifestPath: 'Contents/Resources/openpipal-release-build.json',
    sourcePaths: [
      'config/macos-release-policy.json',
      'electron-builder.release.yml',
      'electron-builder.yml',
      'package-lock.json',
      'package.json',
      'resources/entitlements.mac.inherit.plist',
      'resources/entitlements.mac.plist',
      'resources/mac/en.lproj/InfoPlist.strings',
      'resources/mac/zh-Hans.lproj/InfoPlist.strings',
      'scripts/embed-macos-release-build-manifest.mjs',
      'scripts/generate-third-party-inventory.mjs',
      'scripts/verify-macos-release.mjs',
    ],
    entitlements: {
      main: 'resources/entitlements.mac.plist',
      helper: 'resources/entitlements.mac.inherit.plist',
      forbidden: [
        'com.apple.security.app-sandbox',
        'com.apple.security.cs.allow-unsigned-executable-memory',
        'com.apple.security.cs.debugger',
        'com.apple.security.cs.disable-library-validation',
        'com.apple.security.get-task-allow',
        'com.apple.security.inherit',
      ],
    },
    privacyKeys,
    localizations: [
      {
        locale: 'en',
        sourcePath: 'resources/mac/en.lproj/InfoPlist.strings',
        bundlePath: 'Contents/Resources/en.lproj/InfoPlist.strings',
      },
      {
        locale: 'zh-Hans',
        sourcePath: 'resources/mac/zh-Hans.lproj/InfoPlist.strings',
        bundlePath: 'Contents/Resources/zh-Hans.lproj/InfoPlist.strings',
      },
    ],
    manualCheckIds: MANUAL_CHECK_IDS,
    manualEvidence: {
      schemaVersion: 3,
      signatureDomain: 'openpipal.macos-release.manual-evidence.v1',
      signatureAlgorithm: 'Ed25519',
      operator: {
        identity: options.manualPolicyPending ? 'PENDING' : 'qa-operator',
        keyId: options.manualPolicyPending
          ? 'PENDING'
          : options.manualPolicyKeyIdMismatch ? 'd'.repeat(64) : operatorKeyId,
        publicKeySpkiBase64: options.manualPolicyPending
          ? 'PENDING'
          : operatorPublicKey.toString('base64'),
      },
      approver: {
        identity: options.manualPolicyPending ? 'PENDING' : 'qa-approver',
        keyId: options.manualPolicyPending ? 'PENDING' : approverKeyId,
        publicKeySpkiBase64: options.manualPolicyPending
          ? 'PENDING'
          : approverPublicKey.toString('base64'),
      },
    },
  }
  let policyText = `${JSON.stringify(policy, null, 2)}\n`
  if (options.policyDuplicateKey) {
    policyText = policyText.replace('{\n', '{\n  "schemaVersion": 99,\n')
  }
  const policyRaw = Buffer.from(policyText)
  const candidateBlobs = new Map<string, Buffer>([
    ['config/macos-release-policy.json', policyRaw],
    ['electron-builder.release.yml', releaseBuilder],
    ['electron-builder.yml', builder],
    ['package-lock.json', packageLock],
    ['package.json', packageJson],
    ['resources/entitlements.mac.inherit.plist', Buffer.from(helperEntitlements)],
    ['resources/entitlements.mac.plist', Buffer.from(mainEntitlements)],
    ['resources/mac/en.lproj/InfoPlist.strings', Buffer.from(english)],
    ['resources/mac/zh-Hans.lproj/InfoPlist.strings', Buffer.from(chinese)],
    ['scripts/embed-macos-release-build-manifest.mjs', buildManifestHookBlob],
    ['scripts/generate-third-party-inventory.mjs', inventoryScriptBlob],
    ['scripts/verify-macos-release.mjs', scriptBlob],
  ])
  const sourceSha256 = Object.fromEntries(
    policy.sourcePaths.map(candidatePath => [candidatePath, digest(candidateBlobs.get(candidatePath)!)]),
  )
  const trustBundle = {
    schemaVersion: 1,
    domain: 'openpipal.macos-release.trust.v1',
    policyId: policy.policyId,
    candidatePolicySha256: digest(policyRaw),
    buildManifestHookSha256: digest(buildManifestHookBlob),
    verifierSha256: digest(scriptBlob),
    inventoryGeneratorSha256: digest(inventoryScriptBlob),
    teamIdentifier: policy.teamIdentifier,
    app: {
      bundleIdentifier: policy.app.bundleIdentifier,
      helperBundleIdentifiers: policy.app.helperBundleIdentifiers,
    },
    manualCheckIds: policy.manualCheckIds,
    manualEvidence: policy.manualEvidence,
  }
  const trustRaw = Buffer.from(`${JSON.stringify(trustBundle, null, 2)}\n`)
  const trustPath = await writeFixture(root, 'protected/release-trust.json', trustRaw)
  const trustSha256 = digest(trustRaw)

  const apps: Record<string, string> = {}
  const dmgs: Record<string, string> = {}
  const inventories = new Map<string, Record<string, unknown>>()
  const appDigests: Record<string, string> = {}
  const dmgDigests: Record<string, string> = {}
  for (const architecture of ['arm64', 'x86_64']) {
    const appPath = path.join(output, architecture, 'OpenPipal.app')
    apps[architecture] = appPath
    await writeFixture(
      appPath,
      'Contents/Info.plist',
      infoPlistXml(options.duplicateInfoKey && architecture === 'arm64'),
    )
    const buildManifestRaw = Buffer.from(`${JSON.stringify({
        schemaVersion: 1,
        candidateCommit: COMMIT,
        candidateTree: TREE,
        candidateContentSha256: CANDIDATE_CONTENT_SHA256,
        architecture,
        sourceSha256,
      }, null, 2)}\n`)
    await writeFixture(appPath, 'Contents/Resources/openpipal-release-build.json', buildManifestRaw)
    await writeFixture(appPath, 'Contents/Resources/en.lproj/InfoPlist.strings', english)
    await writeFixture(
      appPath,
      'Contents/Resources/zh-Hans.lproj/InfoPlist.strings',
      options.localizedMismatch && architecture === 'arm64' ? `${chinese} ` : chinese,
    )
    await writeFixture(appPath, 'Contents/MacOS/OpenPipal', `main-${architecture}`)
    for (const helper of helperFixtures(architecture)) {
      const bundlePath = helper.path.split('/Contents/MacOS/')[0]
      await writeFixture(appPath, `${bundlePath}/Contents/Info.plist`, infoPlistXml())
      await writeFixture(appPath, helper.path, helper.identifier)
    }
    const contentSha256 = digest(`app-${architecture}`)
    appDigests[architecture] = contentSha256
    inventories.set(appPath, {
      app: 'OpenPipal.app',
      architecturePolicy: {
        mainArchitectures: [architecture],
        rule: 'each-mach-o-native-covers-all-main-architectures',
      },
      asarEntries: [],
      contentSha256,
      files: [{
        executable: false,
        path: 'Contents/Resources/openpipal-release-build.json',
        sha256: digest(buildManifestRaw),
        size: buildManifestRaw.length,
      }],
      nativeBinaries: [
        {
          architectures: [architecture],
          path: 'Contents/MacOS/OpenPipal',
          role: 'main-executable',
          source: 'filesystem',
        },
        ...helperFixtures(architecture).map(({ identifier: _identifier, ...helper }) => helper),
      ],
      resources: [],
    })
    const dmgPath = await writeFixture(output, `openpipal-${architecture}.dmg`, `dmg-${architecture}`)
    dmgs[architecture] = dmgPath
    dmgDigests[architecture] = digest(`dmg-${architecture}`)
  }

  const helperIdentifierForPath = (target: string) => {
    if (target.includes('Helper (GPU).app')) return 'com.openpipal.app.helper.GPU'
    if (target.includes('Helper (Plugin).app')) return 'com.openpipal.app.helper.Plugin'
    if (target.includes('Helper (Renderer).app')) return 'com.openpipal.app.helper.Renderer'
    return 'com.openpipal.app.helper'
  }
  const displayFor = (target: string, architecture: string | null) => {
    const isDmg = target.endsWith('.dmg')
    const identifier = isDmg
      ? 'com.openpipal.dmg'
      : target.includes('Helper')
        ? helperIdentifierForPath(target)
        : 'com.openpipal.app'
    const flags = isDmg ? 'none' : 'runtime'
    const base = [
      `Identifier=${identifier}`,
      `CodeDirectory v=20500 size=100 flags=0x10000(${flags}) hashes=1+0 location=embedded`,
      `CandidateCDHashFull sha256=${digest(`${target}-${architecture ?? 'none'}`)}`,
      'Signature size=9000',
      `TeamIdentifier=${TEAM_ID}`,
    ].join('\n')
    return options.codesignDisplay?.(target, architecture, base) ?? base
  }
  const entitlementFor = (target: string) => {
    const base = target.includes('Helper')
      ? helperEntitlements
      : target.includes('/Contents/MacOS/OpenPipal')
        ? mainEntitlements
        : entitlementPlist([])
    return options.entitlementFor?.(target, base) ?? base
  }
  const plutilInfo = (target: string) => {
    if (target.includes('Helper')) return { CFBundleIdentifier: helperIdentifierForPath(target) }
    return {
      CFBundleIdentifier: 'com.openpipal.app',
      CFBundleName: 'OpenPipal',
      CFBundleShortVersionString: '1.1.7',
      CFBundleVersion: '1.1.7',
      CFBundleExecutable: 'OpenPipal',
      LSMinimumSystemVersion: options.invalidMinimumVersion ? '12.0beta' : '12.0',
      ...englishValues,
      ...(options.extraPrivacyKey ? { NSBluetoothAlwaysUsageDescription: 'Extra unapproved purpose' } : {}),
      ...(options.emptyPurpose ? { NSMicrophoneUsageDescription: '' } : {}),
    }
  }
  const toolArtifactTargets: string[] = []
  const runTool = async (tool: string, args: string[]) => {
    const target = args.at(-1) ?? ''
    if (path.isAbsolute(target)) toolArtifactTargets.push(target)
    if (tool === '/usr/bin/plutil') {
      return { exitCode: 0, stdout: JSON.stringify(plutilInfo(target)), stderr: '' }
    }
    if (tool === '/usr/bin/codesign') {
      if (args.includes('--entitlements')) {
        const warning = options.entitlementWarning && target.includes('/Contents/MacOS/OpenPipal')
          ? 'warning: binary contains an invalid entitlements blob. The OS will ignore these entitlements.\n'
          : ''
        return {
          exitCode: 0,
          stdout: entitlementFor(target),
          stderr: `Executable=${target}\n${warning}`,
        }
      }
      if (args.includes('--verbose=4')) {
        const index = args.indexOf('--architecture')
        const architecture = index === -1 ? null : args[index + 1]
        return { exitCode: 0, stdout: '', stderr: displayFor(target, architecture) }
      }
      if (options.exactFailurePath && target.includes(options.exactFailurePath) && !args.includes('--deep')) {
        return { exitCode: 1, stdout: '', stderr: 'fixture exact verification failure' }
      }
      return { exitCode: 0, stdout: '', stderr: '' }
    }
    if (tool === '/usr/bin/xcrun') {
      if (args[0] === 'notarytool' && args[1] === 'info') {
        return { exitCode: 0, stdout: '{"status":"Accepted"}', stderr: '' }
      }
      if (args[0] === 'notarytool' && args[1] === 'log') {
        const architecture = args[2] === SUBMISSIONS.arm64 ? 'arm64' : 'x86_64'
        return {
          exitCode: 0,
          stdout: JSON.stringify({ status: 'Accepted', sha256: dmgDigests[architecture] }),
          stderr: '',
        }
      }
      if (args[0] === 'stapler' && options.staplerFailure) {
        return { exitCode: 66, stdout: '', stderr: 'missing ticket' }
      }
      return { exitCode: 0, stdout: '', stderr: '' }
    }
    if (tool === '/usr/sbin/spctl') return { exitCode: 0, stdout: '<plist/>', stderr: '' }
    throw new Error(`Unexpected tool: ${tool}`)
  }

  const artifactSetSha256 = computeArtifactSetSha256(COMMIT, ['arm64', 'x86_64'].map(architecture => ({
    architecture,
    app: { contentSha256: appDigests[architecture] },
    dmg: { sha256: dmgDigests[architecture] },
  })))
  const evidenceContent = 'manual fixture evidence\n'
  await writeFixture(evidenceRoot, 'proof.txt', evidenceContent)
  const manualEvidence = path.join(evidenceRoot, 'manual.json')
  const evidence: Record<string, unknown> = {
    schemaVersion: 3,
    signatureDomain: options.manualSignatureDomainMismatch
      ? 'openpipal.macos-release.manual-evidence.other'
      : policy.manualEvidence.signatureDomain,
    trustBundleSha256: trustSha256,
    policyId: policy.policyId,
    candidateCommit: COMMIT,
    artifactSetSha256,
    operator: options.manualIdentityWhitespace ? ' qa ' : 'qa-operator',
    approver: options.manualIdentityWhitespace ? 'qa' : 'qa-approver',
    status: 'APPROVED',
    checks: policy.manualCheckIds.map(id => ({
      id,
      status: 'PASS',
      evidence: [{ path: 'proof.txt', sha256: digest(evidenceContent) }],
    })),
  }
  if (!options.manualUnsigned) {
    const operatorCanonical = canonicalManualEvidenceBytes(evidence, 'operator')
    const approverCanonical = canonicalManualEvidenceBytes(evidence, 'approver')
    const operatorSignature = sign(null, operatorCanonical, operatorKeys.privateKey)
    evidence.signatures = {
      operator: {
        algorithm: 'Ed25519',
        keyId: operatorKeyId,
        signatureBase64: (options.manualSignatureTruncated
          ? operatorSignature.subarray(0, 63)
          : operatorSignature).toString('base64'),
      },
      approver: {
        algorithm: 'Ed25519',
        keyId: approverKeyId,
        signatureBase64: sign(null, approverCanonical, approverKeys.privateKey).toString('base64'),
      },
    }
  }
  let manualEvidenceText = `${JSON.stringify(evidence, null, 2)}\n`
  if (options.manualDuplicateKey) {
    manualEvidenceText = manualEvidenceText.replace('{\n', '{\n  "status": "REJECTED",\n')
  }
  await writeFile(manualEvidence, manualEvidenceText)

  const stagedAppPaths = new Set<string>()
  const inventoryReadCounts = new Map<string, number>()
  const dependencies = {
    environment: {
      OPENPIPAL_RELEASE_TRUST_BUNDLE: trustPath,
      OPENPIPAL_RELEASE_TRUST_SHA256: trustSha256,
    },
    platform: 'darwin',
    resolveCandidate: async () => ({ tree: TREE, contentSha256: CANDIDATE_CONTENT_SHA256 }),
    readCandidateBlob: async (_repo: string, _commit: string, candidatePath: string) => {
      const content = candidateBlobs.get(candidatePath)
      if (!content) throw new Error('missing candidate blob')
      return content
    },
    readRunningBuildManifestHook: async () => buildManifestHookBlob,
    readRunningInventoryScript: async () => inventoryScriptBlob,
    readRunningScript: async () => scriptBlob,
    copyArtifact: async (sourcePath: string, destinationPath: string) => {
      const sourceInventory = inventories.get(sourcePath)
      if (sourceInventory && options.sourceSwapDuringCopy && sourcePath === apps.arm64) {
        const mainExecutable = path.join(sourcePath, 'Contents', 'MacOS', 'OpenPipal')
        const original = await readFile(mainExecutable)
        await writeFile(mainExecutable, 'copy-time replacement')
        try {
          await cp(sourcePath, destinationPath, { errorOnExist: true, force: false, recursive: true })
        } finally {
          await writeFile(mainExecutable, original)
        }
      } else {
        await cp(sourcePath, destinationPath, { errorOnExist: true, force: false, recursive: true })
      }
      if (sourceInventory) {
        const stagedInventory = structuredClone(sourceInventory)
        if (
          (options.sourceSwapDuringCopy || options.stagingCopyMismatch)
          && sourcePath === apps.arm64
        ) {
          stagedInventory.contentSha256 = 'f'.repeat(64)
        }
        inventories.set(destinationPath, stagedInventory)
        stagedAppPaths.add(destinationPath)
      }
    },
    collectAppInventory: async (appPath: string) => {
      const readCount = (inventoryReadCounts.get(appPath) ?? 0) + 1
      inventoryReadCounts.set(appPath, readCount)
      const inventory = inventories.get(appPath)
      if (!inventory) throw new Error('missing inventory')
      const result = structuredClone(inventory)
      result.app = path.basename(appPath)
      if (options.afterDigest && stagedAppPaths.has(appPath) && readCount > 3) {
        result.contentSha256 = options.afterDigest
      }
      return result
    },
    runTool,
    lstat: async (filePath: string) => (await import('node:fs/promises')).lstat(filePath),
    readFile,
  }
  const inputs = {
    repo,
    candidate: COMMIT,
    apps,
    dmgs,
    manualEvidence,
    onlineNotary: options.online ?? true,
    notaryProfile: 'OPENPIPAL_RELEASE',
    notarySubmissions: SUBMISSIONS,
  }
  return {
    dependencies,
    candidateBlobs,
    inventories,
    inputs,
    operatorPrivateKey: operatorKeys.privateKey,
    policy,
    stagedAppPaths,
    toolArtifactTargets,
    trustBundle,
    trustPath,
    trustRaw,
    trustSha256,
  }
}

type ReleaseFixture = Awaited<ReturnType<typeof createReleaseFixture>>

async function replaceBuildManifest(
  fixture: ReleaseFixture,
  architecture: 'arm64' | 'x86_64',
  content: Buffer | string | null,
  recordOverrides: Record<string, unknown> = {},
) {
  const appPath = fixture.inputs.apps[architecture]
  const manifestPath = path.join(appPath, 'Contents', 'Resources', 'openpipal-release-build.json')
  const inventory = fixture.inventories.get(appPath) as {
    files: Array<Record<string, unknown>>
  }
  if (content === null) {
    await unlink(manifestPath)
    inventory.files = []
    return manifestPath
  }
  const raw = Buffer.isBuffer(content) ? content : Buffer.from(content)
  await writeFile(manifestPath, raw)
  inventory.files = [{
    executable: false,
    path: 'Contents/Resources/openpipal-release-build.json',
    sha256: digest(raw),
    size: raw.length,
    ...recordOverrides,
  }]
  return manifestPath
}

describe('macOS release verifier', () => {
  it('accepts only a fully bound simulated two-architecture release', async () => {
    const fixture = await createReleaseFixture()
    const report = await verifyMacOSRelease(fixture.inputs, fixture.dependencies)
    const signedEvidence = JSON.parse(await readFile(fixture.inputs.manualEvidence, 'utf8'))

    expect(report.errors).toEqual([])
    expect(report.verdict).toBe('PASS')
    expect(report.automatedVerdict).toBe('PASS')
    expect(report.manualVerdict).toBe('PASS')
    expect(report.publicReleaseClearance).toBe(false)
    expect(report.protectedTrust).toEqual({
      matches: true,
      policyId: 'fixture-policy',
      sha256: fixture.trustSha256,
    })
    expect(report.policyBinding.runningBuildManifestHookMatchesCandidate).toBe(true)
    expect(report.artifactSetBinding).toMatchObject({
      architectures: ['arm64', 'x86_64'],
      matches: true,
      sameCandidate: true,
      sameTeamIdentifier: true,
    })
    expect(report.counts.codeObjects).toBe(10)
    expect(report.artifacts.map(artifact => artifact.app.name)).toEqual(['OpenPipal.app', 'OpenPipal.app'])
    expect([...fixture.stagedAppPaths].every(staged => path.basename(staged) === 'OpenPipal.app')).toBe(true)
    expect(report.stagingBinding).toEqual({
      cleanupComplete: true,
      finalMatches: true,
      frozen: true,
      initialMatches: true,
      privateMode: true,
    })
    const sourceArtifacts = [
      ...Object.values(fixture.inputs.apps),
      ...Object.values(fixture.inputs.dmgs),
    ]
    const stagingRoots = [...new Set([...fixture.stagedAppPaths].map(staged => path.dirname(staged)))]
    expect(fixture.toolArtifactTargets.length).toBeGreaterThan(0)
    expect(fixture.toolArtifactTargets.every(target => (
      sourceArtifacts.every(source => target !== source && !target.startsWith(`${source}${path.sep}`))
      && stagingRoots.some(root => target.startsWith(`${root}${path.sep}`))
    ))).toBe(true)
    expect(JSON.stringify(report)).not.toContain(path.dirname(fixture.inputs.repo))
    expect(JSON.stringify(report)).not.toContain(fixture.policy.manualEvidence.operator.publicKeySpkiBase64)
    expect(canonicalManualEvidenceBytes(signedEvidence, 'operator')).not.toEqual(
      canonicalManualEvidenceBytes(signedEvidence, 'approver'),
    )
    expect(() => canonicalManualEvidenceBytes(signedEvidence, 'reviewer')).toThrow('MANUAL_EVIDENCE_INVALID')
    for (const stagingRoot of stagingRoots) {
      await expect(lstat(stagingRoot)).rejects.toMatchObject({ code: 'ENOENT' })
    }
  })

  it('rejects missing, oversized, malformed UTF-8, and non-regular build manifests', async () => {
    const missing = await createReleaseFixture()
    await replaceBuildManifest(missing, 'arm64', null)
    const missingReport = await verifyMacOSRelease(missing.inputs, missing.dependencies)
    expect(missingReport.errors.map(error => error.code)).toContain('BUILD_MANIFEST_MISSING')

    const oversized = await createReleaseFixture()
    await replaceBuildManifest(oversized, 'arm64', Buffer.alloc((64 * 1024) + 1, 0x20))
    const oversizedReport = await verifyMacOSRelease(oversized.inputs, oversized.dependencies)
    expect(oversizedReport.errors.map(error => error.code)).toContain('BUILD_MANIFEST_INVALID')

    const invalidUtf8 = await createReleaseFixture()
    await replaceBuildManifest(invalidUtf8, 'arm64', Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x31, 0x7d]))
    const invalidUtf8Report = await verifyMacOSRelease(invalidUtf8.inputs, invalidUtf8.dependencies)
    expect(invalidUtf8Report.errors.map(error => error.code)).toContain('BUILD_MANIFEST_INVALID')

    const linked = await createReleaseFixture()
    const linkedPath = await replaceBuildManifest(linked, 'arm64', null)
    const targetPath = await writeFixture(
      linked.inputs.apps.arm64,
      'Contents/Resources/build-manifest-target.json',
      '{}\n',
    )
    await symlink(path.basename(targetPath), linkedPath)
    const linkedInventory = linked.inventories.get(linked.inputs.apps.arm64) as {
      files: Array<Record<string, unknown>>
    }
    linkedInventory.files = [{
      path: 'Contents/Resources/openpipal-release-build.json',
      symbolicLink: true,
      target: path.basename(targetPath),
    }]
    const linkedReport = await verifyMacOSRelease(linked.inputs, linked.dependencies)
    expect(linkedReport.errors.map(error => error.code)).toContain('BUILD_MANIFEST_INVALID')
    for (const report of [missingReport, oversizedReport, invalidUtf8Report, linkedReport]) {
      expect(report.verdict).toBe('FAIL')
      expect(report.artifactSetBinding.sameCandidate).toBe(false)
    }
  })

  it('rejects duplicate, unknown, and missing build manifest fields', async () => {
    const duplicate = await createReleaseFixture()
    const duplicatePath = path.join(
      duplicate.inputs.apps.arm64,
      'Contents/Resources/openpipal-release-build.json',
    )
    const duplicateRaw = (await readFile(duplicatePath, 'utf8')).replace(
      '{\n',
      '{\n  "schemaVersion": 99,\n',
    )
    await replaceBuildManifest(duplicate, 'arm64', duplicateRaw)
    const duplicateReport = await verifyMacOSRelease(duplicate.inputs, duplicate.dependencies)

    const unknown = await createReleaseFixture()
    const unknownPath = path.join(
      unknown.inputs.apps.arm64,
      'Contents/Resources/openpipal-release-build.json',
    )
    const unknownManifest = JSON.parse(await readFile(unknownPath, 'utf8'))
    unknownManifest.untrusted = true
    await replaceBuildManifest(unknown, 'arm64', `${JSON.stringify(unknownManifest)}\n`)
    const unknownReport = await verifyMacOSRelease(unknown.inputs, unknown.dependencies)

    const missing = await createReleaseFixture()
    const missingPath = path.join(
      missing.inputs.apps.arm64,
      'Contents/Resources/openpipal-release-build.json',
    )
    const missingManifest = JSON.parse(await readFile(missingPath, 'utf8'))
    delete missingManifest.candidateTree
    await replaceBuildManifest(missing, 'arm64', `${JSON.stringify(missingManifest)}\n`)
    const missingReport = await verifyMacOSRelease(missing.inputs, missing.dependencies)

    for (const report of [duplicateReport, unknownReport, missingReport]) {
      expect(report.verdict).toBe('FAIL')
      expect(report.errors.map(error => error.code)).toContain('BUILD_MANIFEST_INVALID')
      expect(report.artifactSetBinding.sameCandidate).toBe(false)
    }

    for (const falsyJson of ['null', 'false', '0', '""']) {
      const fixture = await createReleaseFixture()
      await replaceBuildManifest(fixture, 'arm64', `${falsyJson}\n`)
      const report = await verifyMacOSRelease(fixture.inputs, fixture.dependencies)
      expect(report.verdict).toBe('FAIL')
      expect(report.errors.map(error => error.code)).toContain('BUILD_MANIFEST_INVALID')
      expect(report.artifactSetBinding.sameCandidate).toBe(false)
    }
  })

  it('binds the same-fd build manifest bytes to the inventory record', async () => {
    const fixture = await createReleaseFixture()
    const manifestPath = path.join(
      fixture.inputs.apps.arm64,
      'Contents/Resources/openpipal-release-build.json',
    )
    const raw = await readFile(manifestPath)
    await replaceBuildManifest(fixture, 'arm64', raw, { sha256: 'f'.repeat(64) })
    const report = await verifyMacOSRelease(fixture.inputs, fixture.dependencies)

    expect(report.verdict).toBe('FAIL')
    expect(report.errors.map(error => error.code)).toContain('BUILD_MANIFEST_INVENTORY_MISMATCH')
    expect(report.artifactSetBinding.sameCandidate).toBe(false)

    const executable = await createReleaseFixture()
    const executablePath = path.join(
      executable.inputs.apps.arm64,
      'Contents/Resources/openpipal-release-build.json',
    )
    const executableRaw = await readFile(executablePath)
    await replaceBuildManifest(executable, 'arm64', executableRaw, { executable: true })
    const executableReport = await verifyMacOSRelease(executable.inputs, executable.dependencies)
    expect(executableReport.verdict).toBe('FAIL')
    expect(executableReport.errors.map(error => error.code)).toContain('BUILD_MANIFEST_INVALID')
  })

  it('rejects candidate, architecture, content, and source hash mismatches in the build manifest', async () => {
    const mutations: Array<[string, (manifest: BuildManifestFixture) => void]> = [
      ['BUILD_MANIFEST_CANDIDATE_MISMATCH', manifest => { manifest.candidateCommit = 'd'.repeat(40) }],
      ['BUILD_MANIFEST_CANDIDATE_MISMATCH', manifest => { manifest.candidateTree = 'd'.repeat(40) }],
      ['BUILD_MANIFEST_CANDIDATE_CONTENT_MISMATCH', manifest => {
        manifest.candidateContentSha256 = 'd'.repeat(64)
      }],
      ['BUILD_MANIFEST_ARCH_MISMATCH', manifest => { manifest.architecture = 'x86_64' }],
      ['BUILD_MANIFEST_SOURCE_HASH_MISMATCH', manifest => {
        manifest.sourceSha256['package.json'] = 'd'.repeat(64)
      }],
    ]
    for (const [expectedCode, mutate] of mutations) {
      const fixture = await createReleaseFixture()
      const manifestPath = path.join(
        fixture.inputs.apps.arm64,
        'Contents/Resources/openpipal-release-build.json',
      )
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as BuildManifestFixture
      mutate(manifest)
      await replaceBuildManifest(fixture, 'arm64', `${JSON.stringify(manifest)}\n`)
      const report = await verifyMacOSRelease(fixture.inputs, fixture.dependencies)
      expect(report.verdict).toBe('FAIL')
      expect(report.errors.map(error => error.code)).toContain(expectedCode)
    }
  })

  it('fails closed while the candidate policy remains pending', async () => {
    const fixture = await createReleaseFixture({ policyPending: true })
    const report = await verifyMacOSRelease(fixture.inputs, fixture.dependencies)
    const codes = report.errors.map(error => error.code)

    expect(report.verdict).toBe('FAIL')
    expect(codes).toContain('POLICY_REVIEW_PENDING')
    expect(codes).toContain('POLICY_TEAM_IDENTIFIER_PENDING')
  })

  it('normalizes whitespace before deciding that policy fields are pending', async () => {
    const fixture = await createReleaseFixture({ policyPendingWhitespace: true })
    const report = await verifyMacOSRelease(fixture.inputs, fixture.dependencies)
    const codes = report.errors.map(error => error.code)

    expect(report.verdict).toBe('FAIL')
    expect(codes).toContain('POLICY_REVIEW_PENDING')
    expect(codes).toContain('POLICY_TEAM_IDENTIFIER_PENDING')
    expect(codes).toContain('POLICY_CANDIDATE_CONTENT_PENDING')
  })

  it('rejects a SELF review copied onto different non-policy candidate content', async () => {
    const fixture = await createReleaseFixture({ candidateContentMismatch: true })
    const report = await verifyMacOSRelease(fixture.inputs, fixture.dependencies)

    expect(report.verdict).toBe('FAIL')
    expect(report.errors.map(error => error.code)).toContain('POLICY_CANDIDATE_CONTENT_MISMATCH')
    expect(report.artifacts).toEqual([])
  })

  it('requires protected trust configuration outside candidate-controlled arguments', async () => {
    const fixture = await createReleaseFixture()
    const report = await verifyMacOSRelease(fixture.inputs, {
      ...fixture.dependencies,
      environment: {},
    })

    expect(report.verdict).toBe('FAIL')
    expect(report.errors.map(error => error.code)).toContain('PROTECTED_TRUST_CONFIG_MISSING')
    expect(report.protectedTrust.matches).toBe(false)
    expect(report.artifacts).toEqual([])
  })

  it('rejects a protected trust bundle whose externally supplied hash is wrong', async () => {
    const fixture = await createReleaseFixture()
    const report = await verifyMacOSRelease(fixture.inputs, {
      ...fixture.dependencies,
      environment: {
        ...fixture.dependencies.environment,
        OPENPIPAL_RELEASE_TRUST_SHA256: '0'.repeat(64),
      },
    })

    expect(report.verdict).toBe('FAIL')
    expect(report.errors.map(error => error.code)).toContain('PROTECTED_TRUST_HASH_MISMATCH')
    expect(report.protectedTrust.matches).toBe(false)
    expect(report.artifacts).toEqual([])
  })

  it('rejects candidate-created signer keys not authorized by protected trust', async () => {
    const fixture = await createReleaseFixture()
    const attackerPolicy = structuredClone(fixture.policy)
    const makeSigner = (identity: string) => {
      const { publicKey } = generateKeyPairSync('ed25519')
      const der = Buffer.from(publicKey.export({ format: 'der', type: 'spki' }))
      return {
        identity,
        keyId: digest(der),
        publicKeySpkiBase64: der.toString('base64'),
      }
    }
    attackerPolicy.manualEvidence.operator = makeSigner('attacker-operator')
    attackerPolicy.manualEvidence.approver = makeSigner('attacker-approver')
    fixture.candidateBlobs.set(
      'config/macos-release-policy.json',
      Buffer.from(`${JSON.stringify(attackerPolicy, null, 2)}\n`),
    )
    const report = await verifyMacOSRelease(fixture.inputs, fixture.dependencies)

    expect(report.verdict).toBe('FAIL')
    expect(report.errors.map(error => error.code)).toContain('PROTECTED_TRUST_POLICY_MISMATCH')
    expect(report.artifacts).toEqual([])
  })

  it('rejects a candidate policy that clears mandatory manual checks', async () => {
    const fixture = await createReleaseFixture()
    const weakenedPolicy = structuredClone(fixture.policy)
    weakenedPolicy.manualCheckIds = []
    fixture.candidateBlobs.set(
      'config/macos-release-policy.json',
      Buffer.from(`${JSON.stringify(weakenedPolicy, null, 2)}\n`),
    )
    const report = await verifyMacOSRelease(fixture.inputs, fixture.dependencies)

    expect(report.verdict).toBe('FAIL')
    expect(report.errors.map(error => error.code)).toContain('POLICY_MANUAL_CHECKS_INVALID')
    expect(report.errors.map(error => error.code)).toContain('PROTECTED_TRUST_POLICY_MISMATCH')
    expect(report.artifacts).toEqual([])
  })

  it('requires the release builder config and build manifest hook in policy source paths', async () => {
    for (const requiredPath of [
      'electron-builder.release.yml',
      'scripts/embed-macos-release-build-manifest.mjs',
    ]) {
      const fixture = await createReleaseFixture()
      const weakenedPolicy = structuredClone(fixture.policy)
      weakenedPolicy.sourcePaths = weakenedPolicy.sourcePaths.filter(
        candidatePath => candidatePath !== requiredPath,
      )
      fixture.candidateBlobs.set(
        'config/macos-release-policy.json',
        Buffer.from(`${JSON.stringify(weakenedPolicy, null, 2)}\n`),
      )
      const report = await verifyMacOSRelease(fixture.inputs, fixture.dependencies)

      expect(report.verdict).toBe('FAIL')
      expect(report.errors.map(error => error.code)).toContain('POLICY_SOURCE_PATHS_INVALID')
      expect(report.artifacts).toEqual([])
    }
  })

  it('rejects duplicate-key, symlink, and oversized protected trust bundles', async () => {
    const duplicateFixture = await createReleaseFixture()
    const duplicateRaw = Buffer.from(
      duplicateFixture.trustRaw.toString('utf8').replace('{\n', '{\n  "schemaVersion": 99,\n'),
    )
    await writeFile(duplicateFixture.trustPath, duplicateRaw)
    const duplicateReport = await verifyMacOSRelease(duplicateFixture.inputs, {
      ...duplicateFixture.dependencies,
      environment: {
        ...duplicateFixture.dependencies.environment,
        OPENPIPAL_RELEASE_TRUST_SHA256: digest(duplicateRaw),
      },
    })

    const symlinkFixture = await createReleaseFixture()
    const trustLink = path.join(path.dirname(symlinkFixture.trustPath), 'trust-link.json')
    await symlink(symlinkFixture.trustPath, trustLink)
    const symlinkReport = await verifyMacOSRelease(symlinkFixture.inputs, {
      ...symlinkFixture.dependencies,
      environment: {
        ...symlinkFixture.dependencies.environment,
        OPENPIPAL_RELEASE_TRUST_BUNDLE: trustLink,
      },
    })

    const oversizedFixture = await createReleaseFixture()
    const oversizedRaw = Buffer.alloc((64 * 1024) + 1, 0x20)
    await writeFile(oversizedFixture.trustPath, oversizedRaw)
    const oversizedReport = await verifyMacOSRelease(oversizedFixture.inputs, {
      ...oversizedFixture.dependencies,
      environment: {
        ...oversizedFixture.dependencies.environment,
        OPENPIPAL_RELEASE_TRUST_SHA256: digest(oversizedRaw),
      },
    })

    for (const report of [duplicateReport, symlinkReport, oversizedReport]) {
      expect(report.verdict).toBe('FAIL')
      expect(report.errors.map(error => error.code)).toContain('PROTECTED_TRUST_BUNDLE_INVALID')
      expect(report.artifacts).toEqual([])
    }
  })

  it('rejects fatal UTF-8 errors in protected trust and manual evidence', async () => {
    const invalidUtf8 = Buffer.from([0xc3, 0x28])
    const trustFixture = await createReleaseFixture()
    await writeFile(trustFixture.trustPath, invalidUtf8)
    const trustReport = await verifyMacOSRelease(trustFixture.inputs, {
      ...trustFixture.dependencies,
      environment: {
        ...trustFixture.dependencies.environment,
        OPENPIPAL_RELEASE_TRUST_SHA256: digest(invalidUtf8),
      },
    })

    const manualFixture = await createReleaseFixture()
    await writeFile(manualFixture.inputs.manualEvidence, invalidUtf8)
    const manualReport = await verifyMacOSRelease(manualFixture.inputs, manualFixture.dependencies)

    expect(trustReport.errors.map(error => error.code)).toContain('PROTECTED_TRUST_BUNDLE_INVALID')
    expect(trustReport.artifacts).toEqual([])
    expect(manualReport.errors.map(error => error.code)).toContain('MANUAL_EVIDENCE_INVALID')
    expect(manualReport.verdict).toBe('FAIL')
  })

  it('rejects an ad-hoc display even when exact and deep command stubs succeed', async () => {
    const fixture = await createReleaseFixture({
      codesignDisplay: (target, _architecture, base) => target.includes('/Contents/MacOS/OpenPipal')
        ? base.replace('(runtime)', '(adhoc,linker-signed,runtime)').replace('Signature size=9000', 'Signature=adhoc')
        : base,
    })
    const report = await verifyMacOSRelease(fixture.inputs, fixture.dependencies)

    expect(report.verdict).toBe('FAIL')
    expect(report.errors.map(error => error.code)).toContain('ADHOC_SIGNATURE_FORBIDDEN')
  })

  it('does not let a deep pass hide an individually failing native object', async () => {
    const fixture = await createReleaseFixture({ exactFailurePath: 'Helper (GPU)' })
    const report = await verifyMacOSRelease(fixture.inputs, fixture.dependencies)

    expect(report.verdict).toBe('FAIL')
    expect(report.errors.map(error => error.code)).toContain('CODESIGN_EXACT_VERIFY_FAILED')
    expect(report.artifacts.every(artifact => artifact.signature.deepVerifySupplemental)).toBe(true)
  })

  it('inspects every universal Mach-O slice instead of trusting the host slice', async () => {
    const fixture = await createReleaseFixture({
      codesignDisplay: (target, architecture, base) =>
        target.includes('universal.node') && architecture === 'x86_64'
          ? base.replace(`TeamIdentifier=${TEAM_ID}`, 'TeamIdentifier=ZZZZZZZZZZ')
          : base,
    })
    const originalInventory = fixture.dependencies.collectAppInventory
    const dependencies = {
      ...fixture.dependencies,
      collectAppInventory: async (appPath: string) => {
        const inventory = await originalInventory(appPath) as {
          nativeBinaries: Array<Record<string, unknown>>
        }
        if (appPath.endsWith('/arm64/OpenPipal.app')) {
          inventory.nativeBinaries.push({
            architectures: ['arm64', 'x86_64'],
            path: 'Contents/Resources/universal.node',
            role: 'node-addon',
            source: 'filesystem',
          })
        }
        return inventory
      },
    }
    const report = await verifyMacOSRelease(fixture.inputs, dependencies)

    expect(report.verdict).toBe('FAIL')
    expect(report.errors.map(error => error.code)).toContain('TEAM_IDENTIFIER_MISMATCH')
    const universal = report.artifacts[0].signature.codeObjects.find(
      object => object.path === 'Contents/Resources/universal.node',
    )
    expect(universal?.slices.map(slice => slice.architecture)).toEqual(['arm64', 'x86_64'])
  })

  it('rejects a helper entitlement outside its committed role contract', async () => {
    const fixture = await createReleaseFixture({
      entitlementFor: (target, base) => target.includes('Helper (Renderer)')
        ? entitlementPlist(['com.apple.security.cs.allow-jit', 'com.apple.security.get-task-allow'])
        : base,
    })
    const report = await verifyMacOSRelease(fixture.inputs, fixture.dependencies)
    const codes = report.errors.map(error => error.code)

    expect(report.verdict).toBe('FAIL')
    expect(codes).toContain('ENTITLEMENTS_MISMATCH')
    expect(codes).toContain('FORBIDDEN_ENTITLEMENT')
  })

  it('requires online notarization and manual evidence instead of downgrading them', async () => {
    const fixture = await createReleaseFixture({ online: false })
    const inputs = { ...fixture.inputs, manualEvidence: undefined }
    const report = await verifyMacOSRelease(inputs, fixture.dependencies)
    const codes = report.errors.map(error => error.code)

    expect(report.verdict).toBe('FAIL')
    expect(codes).toContain('ONLINE_NOTARY_REQUIRED')
    expect(codes).toContain('MANUAL_EVIDENCE_MISSING')
  })

  it('reports actual stapler failures instead of setting success flags optimistically', async () => {
    const fixture = await createReleaseFixture({ staplerFailure: true })
    const report = await verifyMacOSRelease(fixture.inputs, fixture.dependencies)

    expect(report.verdict).toBe('FAIL')
    expect(report.errors.map(error => error.code)).toContain('STAPLER_VALIDATE_FAILED')
    expect(report.artifacts.every(artifact => !artifact.signature.staplerValidate)).toBe(true)
    expect(report.artifacts.every(artifact => !artifact.dmg.staplerValidate)).toBe(true)
  })

  it('detects an app digest change during the online verification window', async () => {
    const fixture = await createReleaseFixture({ afterDigest: 'e'.repeat(64) })
    const report = await verifyMacOSRelease(fixture.inputs, fixture.dependencies)

    expect(report.verdict).toBe('FAIL')
    expect(report.errors.map(error => error.code)).toContain('ARTIFACT_MUTATED_BY_CHECK')
    expect(report.errors.map(error => error.code)).toContain('STAGED_ARTIFACT_CHANGED_DURING_VERIFICATION')
    expect(report.stagingBinding.finalMatches).toBe(false)
  })

  it('rejects a copy-time source replacement even when the source is restored', async () => {
    const fixture = await createReleaseFixture({ sourceSwapDuringCopy: true })
    const originalMain = `main-arm64`
    const report = await verifyMacOSRelease(fixture.inputs, fixture.dependencies)

    expect(report.verdict).toBe('FAIL')
    expect(report.errors.map(error => error.code)).toContain('STAGING_COPY_MISMATCH')
    expect(report.artifacts).toEqual([])
    expect(fixture.toolArtifactTargets).toEqual([])
    expect(await readFile(
      path.join(fixture.inputs.apps.arm64, 'Contents', 'MacOS', 'OpenPipal'),
      'utf8',
    )).toBe(originalMain)
  })

  it('rejects a staged copy whose digest differs from the source baseline', async () => {
    const fixture = await createReleaseFixture({ stagingCopyMismatch: true })
    const report = await verifyMacOSRelease(fixture.inputs, fixture.dependencies)

    expect(report.verdict).toBe('FAIL')
    expect(report.errors.map(error => error.code)).toContain('STAGING_COPY_MISMATCH')
    expect(report.stagingBinding.initialMatches).toBe(false)
  })

  it('opens every regular-file digest target with O_NOFOLLOW', async () => {
    const fixture = await createReleaseFixture()
    const observedFlags: number[] = []
    const dependencies = {
      ...fixture.dependencies,
      openFile: async (filePath: string, flags: number) => {
        observedFlags.push(flags)
        return open(filePath, flags)
      },
    }
    const report = await verifyMacOSRelease(fixture.inputs, dependencies)

    expect(report.verdict).toBe('PASS')
    expect(observedFlags.length).toBeGreaterThan(0)
    expect(observedFlags.every(flags => (
      flags & fsConstants.O_NOFOLLOW
    ) === fsConstants.O_NOFOLLOW)).toBe(true)
  })

  it('fails when private staging cleanup cannot be confirmed', async () => {
    const fixture = await createReleaseFixture()
    const dependencies = {
      ...fixture.dependencies,
      removePrivateStagingDirectory: async (stagingRoot: string) => {
        await rm(stagingRoot, { force: true, recursive: true })
        throw new Error('simulated cleanup reporting failure')
      },
    }
    const report = await verifyMacOSRelease(fixture.inputs, dependencies)

    expect(report.verdict).toBe('FAIL')
    expect(report.errors.map(error => error.code)).toContain('PRIVATE_STAGING_CLEANUP_FAILED')
    expect(report.stagingBinding.cleanupComplete).toBe(false)
  })

  it('rejects localized resources that differ from the exact candidate blob', async () => {
    const fixture = await createReleaseFixture({ localizedMismatch: true })
    const report = await verifyMacOSRelease(fixture.inputs, fixture.dependencies)

    expect(report.verdict).toBe('FAIL')
    expect(report.errors.map(error => error.code)).toContain('LOCALIZATION_CONTENT_MISMATCH')
  })

  it('rejects extra privacy declarations, empty purposes, and malformed minimum versions', async () => {
    const fixture = await createReleaseFixture({
      emptyPurpose: true,
      extraPrivacyKey: true,
      invalidMinimumVersion: true,
    })
    const report = await verifyMacOSRelease(fixture.inputs, fixture.dependencies)
    const codes = report.errors.map(error => error.code)

    expect(report.verdict).toBe('FAIL')
    expect(codes).toContain('PRIVACY_KEY_SET_MISMATCH')
    expect(codes).toContain('PRIVACY_VALUE_MISMATCH')
    expect(codes).toContain('MINIMUM_SYSTEM_VERSION_MISMATCH')
  })

  it('rejects codesign metadata that does not prove an embedded signature', async () => {
    const fixture = await createReleaseFixture({
      codesignDisplay: (_target, _architecture, base) => base.replace(' location=embedded', ''),
    })
    const report = await verifyMacOSRelease(fixture.inputs, fixture.dependencies)

    expect(report.verdict).toBe('FAIL')
    expect(report.errors.map(error => error.code)).toContain('EMBEDDED_SIGNATURE_REQUIRED')
  })

  it('rejects successful entitlement extraction with warning diagnostics', async () => {
    const fixture = await createReleaseFixture({ entitlementWarning: true })
    const report = await verifyMacOSRelease(fixture.inputs, fixture.dependencies)

    expect(report.verdict).toBe('FAIL')
    expect(report.errors.map(error => error.code)).toContain('ENTITLEMENTS_EXTRACT_FAILED')
  })

  it('rejects duplicate top-level Info.plist keys before trusting plutil JSON', async () => {
    const fixture = await createReleaseFixture({ duplicateInfoKey: true })
    const report = await verifyMacOSRelease(fixture.inputs, fixture.dependencies)

    expect(report.verdict).toBe('FAIL')
    expect(report.errors.map(error => error.code)).toContain('INFO_PLIST_DUPLICATE_KEY')
  })

  it('rejects policy reviewers whose identities need trimming or normalize equal', async () => {
    const fixture = await createReleaseFixture({ policyIdentityWhitespace: true })
    const report = await verifyMacOSRelease(fixture.inputs, fixture.dependencies)

    expect(report.verdict).toBe('FAIL')
    expect(report.errors.map(error => error.code)).toContain('POLICY_REVIEW_PENDING')
  })

  it('rejects duplicate policy JSON keys instead of trusting the last value', async () => {
    const fixture = await createReleaseFixture({ policyDuplicateKey: true })
    const report = await verifyMacOSRelease(fixture.inputs, fixture.dependencies)

    expect(report.verdict).toBe('FAIL')
    expect(report.errors.map(error => error.code)).toContain('MALFORMED_POLICY')
    expect(report.artifacts).toEqual([])
  })

  it('rejects manual reviewers whose identities need trimming or normalize equal', async () => {
    const fixture = await createReleaseFixture({ manualIdentityWhitespace: true })
    const report = await verifyMacOSRelease(fixture.inputs, fixture.dependencies)

    expect(report.verdict).toBe('FAIL')
    expect(report.errors.map(error => error.code)).toContain('MANUAL_EVIDENCE_INVALID')
  })

  it('rejects duplicate manual-evidence JSON keys instead of trusting the last value', async () => {
    const fixture = await createReleaseFixture({ manualDuplicateKey: true })
    const report = await verifyMacOSRelease(fixture.inputs, fixture.dependencies)

    expect(report.verdict).toBe('FAIL')
    expect(report.errors.map(error => error.code)).toContain('MANUAL_EVIDENCE_INVALID')
  })

  it('rejects manual evidence through a symlink instead of following it', async () => {
    const fixture = await createReleaseFixture()
    const manualLink = path.join(path.dirname(fixture.inputs.manualEvidence), 'manual-link.json')
    await symlink(fixture.inputs.manualEvidence, manualLink)
    const report = await verifyMacOSRelease({
      ...fixture.inputs,
      manualEvidence: manualLink,
    }, fixture.dependencies)

    expect(report.verdict).toBe('FAIL')
    expect(report.errors.map(error => error.code)).toContain('MANUAL_EVIDENCE_INVALID')
  })

  it('rejects manual evidence larger than the 256 KiB safety cap', async () => {
    const fixture = await createReleaseFixture()
    await writeFile(fixture.inputs.manualEvidence, Buffer.alloc((256 * 1024) + 1, 0x20))
    const report = await verifyMacOSRelease(fixture.inputs, fixture.dependencies)

    expect(report.verdict).toBe('FAIL')
    expect(report.errors.map(error => error.code)).toContain('MANUAL_EVIDENCE_INVALID')
  })

  it('rejects signed manual evidence replayed under a different protected bundle hash', async () => {
    const fixture = await createReleaseFixture()
    const alternateTrustRaw = Buffer.from(`${JSON.stringify(fixture.trustBundle)}\n`)
    expect(digest(alternateTrustRaw)).not.toBe(fixture.trustSha256)
    await writeFile(fixture.trustPath, alternateTrustRaw)
    const report = await verifyMacOSRelease(fixture.inputs, {
      ...fixture.dependencies,
      environment: {
        ...fixture.dependencies.environment,
        OPENPIPAL_RELEASE_TRUST_SHA256: digest(alternateTrustRaw),
      },
    })

    expect(report.protectedTrust.matches).toBe(true)
    expect(report.verdict).toBe('FAIL')
    expect(report.errors.map(error => error.code)).toContain('MANUAL_EVIDENCE_INVALID')
  })

  it('rejects valid signatures made over the wrong manual signature domain', async () => {
    const fixture = await createReleaseFixture({ manualSignatureDomainMismatch: true })
    const report = await verifyMacOSRelease(fixture.inputs, fixture.dependencies)

    expect(report.manualEvidence.signaturesVerified).toEqual({ approver: true, operator: true })
    expect(report.verdict).toBe('FAIL')
    expect(report.errors.map(error => error.code)).toContain('MANUAL_EVIDENCE_INVALID')
  })

  it('binds operator and approver signatures to their protected roles', async () => {
    const fixture = await createReleaseFixture()
    const evidence = JSON.parse(await readFile(fixture.inputs.manualEvidence, 'utf8'))
    const operator = evidence.signatures.operator
    evidence.signatures.operator = evidence.signatures.approver
    evidence.signatures.approver = operator
    await writeFile(fixture.inputs.manualEvidence, `${JSON.stringify(evidence, null, 2)}\n`)
    const report = await verifyMacOSRelease(fixture.inputs, fixture.dependencies)

    expect(report.verdict).toBe('FAIL')
    expect(report.errors.map(error => error.code)).toContain('MANUAL_SIGNATURE_INVALID')
    expect(report.manualEvidence.signaturesVerified).toEqual({ approver: false, operator: false })
  })

  it('rejects the correct operator key when it signs the approver role prefix', async () => {
    const fixture = await createReleaseFixture()
    const evidence = JSON.parse(await readFile(fixture.inputs.manualEvidence, 'utf8'))
    const wrongRoleBytes = canonicalManualEvidenceBytes(evidence, 'approver')
    evidence.signatures.operator.signatureBase64 = sign(
      null,
      wrongRoleBytes,
      fixture.operatorPrivateKey,
    ).toString('base64')
    await writeFile(fixture.inputs.manualEvidence, `${JSON.stringify(evidence, null, 2)}\n`)
    const report = await verifyMacOSRelease(fixture.inputs, fixture.dependencies)

    expect(report.verdict).toBe('FAIL')
    expect(report.errors.map(error => error.code)).toContain('MANUAL_SIGNATURE_INVALID')
    expect(report.manualEvidence.signaturesVerified).toEqual({ approver: true, operator: false })
  })

  it('never lets unsigned manual evidence promote the release verdict', async () => {
    const fixture = await createReleaseFixture({ manualUnsigned: true })
    const report = await verifyMacOSRelease(fixture.inputs, fixture.dependencies)

    expect(report.automatedVerdict).toBe('PASS')
    expect(report.manualVerdict).toBe('FAIL')
    expect(report.verdict).toBe('FAIL')
    expect(report.errors.map(error => error.code)).toContain('MANUAL_SIGNATURE_INVALID')
  })

  it('rejects non-64-byte Ed25519 signatures', async () => {
    const fixture = await createReleaseFixture({ manualSignatureTruncated: true })
    const report = await verifyMacOSRelease(fixture.inputs, fixture.dependencies)

    expect(report.verdict).toBe('FAIL')
    expect(report.errors.map(error => error.code)).toContain('MANUAL_SIGNATURE_INVALID')
    expect(report.manualEvidence.signaturesVerified.operator).toBe(false)
  })

  it('rejects manual signer key IDs that do not hash the committed SPKI', async () => {
    const fixture = await createReleaseFixture({ manualPolicyKeyIdMismatch: true })
    const report = await verifyMacOSRelease(fixture.inputs, fixture.dependencies)

    expect(report.verdict).toBe('FAIL')
    expect(report.errors.map(error => error.code)).toContain('POLICY_MANUAL_SIGNERS_INVALID')
    expect(report.artifacts).toEqual([])
  })

  it('fails closed while committed manual signer identities and keys remain pending', async () => {
    const fixture = await createReleaseFixture({ manualPolicyPending: true })
    const report = await verifyMacOSRelease(fixture.inputs, fixture.dependencies)

    expect(report.verdict).toBe('FAIL')
    expect(report.errors.map(error => error.code)).toContain('POLICY_MANUAL_SIGNERS_PENDING')
    expect(report.artifacts).toEqual([])
  })

  it('rejects a verifier whose running bytes differ from the candidate blob', async () => {
    const fixture = await createReleaseFixture()
    const dependencies = {
      ...fixture.dependencies,
      readRunningScript: async () => Buffer.from('working tree replacement\n'),
    }
    const report = await verifyMacOSRelease(fixture.inputs, dependencies)

    expect(report.verdict).toBe('FAIL')
    expect(report.errors.map(error => error.code)).toContain('VERIFIER_NOT_FROM_CANDIDATE')
    expect(report.errors.map(error => error.code)).toContain('PROTECTED_TRUST_RUNTIME_MISMATCH')
    expect(report.artifacts).toEqual([])
  })

  it('rejects a build manifest hook whose running bytes differ from the candidate blob', async () => {
    const fixture = await createReleaseFixture()
    const report = await verifyMacOSRelease(fixture.inputs, {
      ...fixture.dependencies,
      readRunningBuildManifestHook: async () => Buffer.from('dirty build manifest hook\n'),
    })

    expect(report.verdict).toBe('FAIL')
    expect(report.policyBinding.runningBuildManifestHookMatchesCandidate).toBe(false)
    expect(report.errors.map(error => error.code)).toContain('BUILD_MANIFEST_HOOK_NOT_FROM_CANDIDATE')
    expect(report.errors.map(error => error.code)).toContain('PROTECTED_TRUST_RUNTIME_MISMATCH')
    expect(report.artifacts).toEqual([])
  })

  it('rejects matching candidate and running hook replacements absent from protected trust', async () => {
    const fixture = await createReleaseFixture()
    const replacement = Buffer.from('candidate and runtime build hook replacement\n')
    fixture.candidateBlobs.set('scripts/embed-macos-release-build-manifest.mjs', replacement)
    const report = await verifyMacOSRelease(fixture.inputs, {
      ...fixture.dependencies,
      readRunningBuildManifestHook: async () => replacement,
    })

    expect(report.policyBinding.runningBuildManifestHookMatchesCandidate).toBe(true)
    expect(report.verdict).toBe('FAIL')
    expect(report.errors.map(error => error.code)).toContain('PROTECTED_TRUST_RUNTIME_MISMATCH')
    expect(JSON.stringify(report)).not.toContain(replacement.toString('utf8').trim())
    expect(report.artifacts).toEqual([])
  })

  it('rejects matching candidate and running verifier replacements absent from protected trust', async () => {
    const fixture = await createReleaseFixture()
    const replacement = Buffer.from('candidate and runtime replacement\n')
    fixture.candidateBlobs.set('scripts/verify-macos-release.mjs', replacement)
    const report = await verifyMacOSRelease(fixture.inputs, {
      ...fixture.dependencies,
      readRunningScript: async () => replacement,
    })

    expect(report.policyBinding.runningScriptMatchesCandidate).toBe(true)
    expect(report.verdict).toBe('FAIL')
    expect(report.errors.map(error => error.code)).toContain('PROTECTED_TRUST_RUNTIME_MISMATCH')
    expect(report.artifacts).toEqual([])
  })

  it('rejects a dirty inventory implementation before trusting its app facts', async () => {
    const fixture = await createReleaseFixture()
    const dependencies = {
      ...fixture.dependencies,
      readRunningInventoryScript: async () => Buffer.from('dirty inventory replacement\n'),
    }
    const report = await verifyMacOSRelease(fixture.inputs, dependencies)

    expect(report.verdict).toBe('FAIL')
    expect(report.errors.map(error => error.code)).toContain('INVENTORY_NOT_FROM_CANDIDATE')
    expect(report.errors.map(error => error.code)).toContain('PROTECTED_TRUST_RUNTIME_MISMATCH')
    expect(report.policyBinding.runningInventoryMatchesCandidate).toBe(false)
    expect(report.artifacts).toEqual([])
  })

  it('parses only explicit architecture mappings', () => {
    expect(parseArguments([
      '--repo', '/candidate',
      '--candidate', COMMIT,
      '--app', 'arm64=/a.app',
      '--app', 'x86_64=/b.app',
      '--dmg', 'arm64=/a.dmg',
      '--dmg', 'x86_64=/b.dmg',
    ])).toMatchObject({
      apps: { arm64: '/a.app', x86_64: '/b.app' },
      dmgs: { arm64: '/a.dmg', x86_64: '/b.dmg' },
    })
    expect(() => parseArguments(['--app', 'x64=/a.app'])).toThrow('INVALID_ARGUMENTS')
    expect(() => parseArguments(['--app', 'arm64=/a.app', '--app', 'arm64=/b.app'])).toThrow('INVALID_ARGUMENTS')
    expect(() => parseArguments(['--trust-bundle', '/candidate/trust.json'])).toThrow('INVALID_ARGUMENTS')
  })
})
