import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Arch } from 'electron-builder'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  createReleaseBuildManifest,
  writeReleaseBuildManifest,
} from '../../scripts/embed-macos-release-build-manifest.mjs'

const HOOK_PATH = fileURLToPath(new URL(
  '../../scripts/embed-macos-release-build-manifest.mjs',
  import.meta.url,
))
const BUILD_MANIFEST_PATH = 'Contents/Resources/openpipal-release-build.json'
// 30s 而不是 15s：建临时 git 仓 + 多次 git 子进程是 I/O 主导，同机开着
// app / vite / playwright 时 15s 也会超——用超时当性能守卫只会制造假警报。
const GIT_FIXTURE_TEST_TIMEOUT = 30_000
const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { force: true, recursive: true })))
})

function git(repo: string, args: string[]): string {
  return execFileSync('/usr/bin/git', args, {
    cwd: repo,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

function digest(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex')
}

async function writeFixture(root: string, relativePath: string, content: string | Buffer) {
  const absolutePath = path.join(root, ...relativePath.split('/'))
  await mkdir(path.dirname(absolutePath), { recursive: true })
  await writeFile(absolutePath, content)
  return absolutePath
}

function candidateContentSha256(repo: string, candidate: string): string {
  const output = git(repo, ['ls-tree', '-r', '-l', `${candidate}^{commit}`])
  const canonical = output === '' ? '' : output.split('\n').map(line => {
    const [metadata, candidatePath] = line.split('\t')
    const match = /^(\d{6}) blob ([0-9a-f]+)\s+(\d+)$/u.exec(metadata)
    if (!match || !candidatePath) throw new Error('invalid test candidate tree')
    return { mode: match[1], objectId: match[2], size: Number(match[3]), path: candidatePath }
  })
    .filter(entry => entry.path !== 'config/macos-release-policy.json')
    .sort((left, right) => left.path.localeCompare(right.path))
    .map(entry => `${entry.mode} ${entry.objectId} ${entry.size}\t${entry.path}\n`)
    .join('')
  return digest(canonical)
}

interface CandidateFixtureOptions {
  duplicatePolicyKey?: boolean
  hookMismatch?: boolean
  omitRequiredSource?: string
  sourcePathMissingFromTree?: boolean
}

async function createCandidateFixture(options: CandidateFixtureOptions = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'openpipal-build-manifest-test-'))
  temporaryRoots.push(root)
  const repo = path.join(root, 'repo')
  const appOutDir = path.join(root, 'output', 'mac-arm64')
  await mkdir(repo)
  git(repo, ['init', '--quiet'])

  const sourcePaths = [
    'config/macos-release-policy.json',
    'electron-builder.release.yml',
    'electron-builder.yml',
    'package-lock.json',
    'package.json',
    'scripts/embed-macos-release-build-manifest.mjs',
    'scripts/generate-third-party-inventory.mjs',
    'scripts/verify-macos-release.mjs',
  ].filter(candidatePath => candidatePath !== options.omitRequiredSource)
  if (options.sourcePathMissingFromTree) sourcePaths.push('resources/missing-release-input.txt')
  const policy = {
    schemaVersion: 1,
    app: { name: 'OpenPipal.app' },
    buildManifestPath: BUILD_MANIFEST_PATH,
    sourcePaths,
  }
  let policyText = `${JSON.stringify(policy, null, 2)}\n`
  if (options.duplicatePolicyKey) {
    policyText = policyText.replace('{\n', '{\n  "schemaVersion": 9,\n')
  }
  const files: Record<string, string | Buffer> = {
    '.gitignore': 'node_modules\nout\ndist\n',
    'config/macos-release-policy.json': policyText,
    'electron-builder.release.yml': 'extends: ./electron-builder.yml\nafterPack: ./scripts/embed-macos-release-build-manifest.mjs\n',
    'electron-builder.yml': 'appId: com.openpipal.app\nproductName: OpenPipal\n',
    'package-lock.json': '{"name":"openpipal","lockfileVersion":3}\n',
    'package.json': '{"name":"openpipal","version":"1.1.7"}\n',
    'scripts/embed-macos-release-build-manifest.mjs': options.hookMismatch
      ? 'export const replaced = true\n'
      : await readFile(HOOK_PATH),
    'scripts/generate-third-party-inventory.mjs': 'export const inventory = true\n',
    'scripts/verify-macos-release.mjs': 'export const verifier = true\n',
  }
  for (const [candidatePath, content] of Object.entries(files)) {
    await writeFixture(repo, candidatePath, content)
  }
  git(repo, ['add', '--all'])
  git(repo, [
    '-c', 'user.name=OpenPipal Test',
    '-c', 'user.email=openpipal-test@example.invalid',
    'commit', '--quiet', '-m', 'fixture',
  ])
  const candidate = git(repo, ['rev-parse', 'HEAD'])
  await mkdir(path.join(appOutDir, 'OpenPipal.app', 'Contents', 'Resources'), { recursive: true })
  const context = {
    appOutDir,
    arch: Arch.arm64,
    electronPlatformName: 'darwin',
    packager: {
      appInfo: { productFilename: 'OpenPipal' },
      projectDir: repo,
    },
  }
  return { appOutDir, candidate, context, repo, root, sourcePaths }
}

describe('macOS release build manifest hook', () => {
  it('writes deterministic exact candidate manifests for arm64 and maps x64 to x86_64', async () => {
    const fixture = await createCandidateFixture()
    const first = createReleaseBuildManifest({
      architecture: 'arm64',
      candidate: fixture.candidate,
      repo: fixture.repo,
    })
    const second = createReleaseBuildManifest({
      architecture: 'arm64',
      candidate: fixture.candidate,
      repo: fixture.repo,
    })
    expect(first.rendered).toEqual(second.rendered)

    const armPath = await writeReleaseBuildManifest(fixture.context, {
      OPENPIPAL_RELEASE_CANDIDATE: fixture.candidate,
    })
    const armManifest = JSON.parse(await readFile(armPath, 'utf8'))
    expect(Object.keys(armManifest).sort()).toEqual([
      'architecture',
      'candidateCommit',
      'candidateContentSha256',
      'candidateTree',
      'schemaVersion',
      'sourceSha256',
    ])
    expect(armManifest).toMatchObject({
      architecture: 'arm64',
      candidateCommit: fixture.candidate,
      candidateContentSha256: candidateContentSha256(fixture.repo, fixture.candidate),
      candidateTree: git(fixture.repo, ['rev-parse', `${fixture.candidate}^{tree}`]),
      schemaVersion: 1,
    })
    for (const candidatePath of fixture.sourcePaths) {
      const blob = execFileSync('/usr/bin/git', [
        'show', `${fixture.candidate}^{commit}:${candidatePath}`,
      ], { cwd: fixture.repo })
      expect(armManifest.sourceSha256[candidatePath]).toBe(digest(blob))
    }

    const x64AppOut = path.join(fixture.root, 'output', 'mac-x64')
    await mkdir(path.join(x64AppOut, 'OpenPipal.app', 'Contents', 'Resources'), { recursive: true })
    const x64Path = await writeReleaseBuildManifest({
      ...fixture.context,
      appOutDir: x64AppOut,
      arch: Arch.x64,
    }, { OPENPIPAL_RELEASE_CANDIDATE: fixture.candidate })
    const x64Manifest = JSON.parse(await readFile(x64Path, 'utf8'))
    expect(x64Manifest.architecture).toBe('x86_64')
    expect(x64Manifest.sourceSha256).toEqual(armManifest.sourceSha256)
    expect(x64Manifest.candidateCommit).toBe(armManifest.candidateCommit)
    expect(x64Manifest.candidateTree).toBe(armManifest.candidateTree)
  }, GIT_FIXTURE_TEST_TIMEOUT)

  it('requires a canonical candidate at the clean checkout HEAD', async () => {
    const missing = await createCandidateFixture()
    await expect(writeReleaseBuildManifest(missing.context, {})).rejects.toThrow(
      'RELEASE_CANDIDATE_NOT_EXACT',
    )

    const wrongHead = await createCandidateFixture()
    await expect(writeReleaseBuildManifest(wrongHead.context, {
      OPENPIPAL_RELEASE_CANDIDATE: 'f'.repeat(40),
    })).rejects.toThrow()

    const tracked = await createCandidateFixture()
    await writeFile(path.join(tracked.repo, 'package.json'), '{"name":"dirty"}\n')
    await expect(writeReleaseBuildManifest(tracked.context, {
      OPENPIPAL_RELEASE_CANDIDATE: tracked.candidate,
    })).rejects.toThrow('RELEASE_CANDIDATE_TRACKED_DIRTY')

    const staged = await createCandidateFixture()
    await writeFile(path.join(staged.repo, 'package.json'), '{"name":"staged"}\n')
    git(staged.repo, ['add', 'package.json'])
    await expect(writeReleaseBuildManifest(staged.context, {
      OPENPIPAL_RELEASE_CANDIDATE: staged.candidate,
    })).rejects.toThrow('RELEASE_CANDIDATE_TRACKED_DIRTY')

    const untracked = await createCandidateFixture()
    await writeFile(path.join(untracked.repo, 'unexpected.txt'), 'not allowed\n')
    await expect(writeReleaseBuildManifest(untracked.context, {
      OPENPIPAL_RELEASE_CANDIDATE: untracked.candidate,
    })).rejects.toThrow('RELEASE_CANDIDATE_UNTRACKED_DIRTY')
  }, GIT_FIXTURE_TEST_TIMEOUT)

  it('allows ignored build directories but rejects malformed or incomplete candidate policy', async () => {
    const ignored = await createCandidateFixture()
    await mkdir(path.join(ignored.repo, 'out'))
    await writeFile(path.join(ignored.repo, 'out', 'compiled.js'), 'ignored output\n')
    await expect(writeReleaseBuildManifest(ignored.context, {
      OPENPIPAL_RELEASE_CANDIDATE: ignored.candidate,
    })).resolves.toContain(BUILD_MANIFEST_PATH.split('/').at(-1))

    const duplicate = await createCandidateFixture({ duplicatePolicyKey: true })
    await expect(writeReleaseBuildManifest(duplicate.context, {
      OPENPIPAL_RELEASE_CANDIDATE: duplicate.candidate,
    })).rejects.toThrow('RELEASE_POLICY_INVALID')

    const missingRequired = await createCandidateFixture({
      omitRequiredSource: 'electron-builder.release.yml',
    })
    await expect(writeReleaseBuildManifest(missingRequired.context, {
      OPENPIPAL_RELEASE_CANDIDATE: missingRequired.candidate,
    })).rejects.toThrow('RELEASE_POLICY_SOURCE_PATH_INVALID')

    const missingBlob = await createCandidateFixture({ sourcePathMissingFromTree: true })
    await expect(writeReleaseBuildManifest(missingBlob.context, {
      OPENPIPAL_RELEASE_CANDIDATE: missingBlob.candidate,
    })).rejects.toThrow('RELEASE_CANDIDATE_GIT_FAILED')

    const mismatchedHook = await createCandidateFixture({ hookMismatch: true })
    await expect(writeReleaseBuildManifest(mismatchedHook.context, {
      OPENPIPAL_RELEASE_CANDIDATE: mismatchedHook.candidate,
    })).rejects.toThrow('RELEASE_BUILD_HOOK_NOT_FROM_CANDIDATE')
  }, GIT_FIXTURE_TEST_TIMEOUT)

  it('fails closed on stale targets, symlinks, unsupported platforms, and unsupported architectures', async () => {
    const stale = await createCandidateFixture()
    await writeReleaseBuildManifest(stale.context, {
      OPENPIPAL_RELEASE_CANDIDATE: stale.candidate,
    })
    await expect(writeReleaseBuildManifest(stale.context, {
      OPENPIPAL_RELEASE_CANDIDATE: stale.candidate,
    })).rejects.toMatchObject({ code: 'EEXIST' })

    const linked = await createCandidateFixture()
    const target = await writeFixture(linked.root, 'outside-manifest.json', '{}\n')
    const manifestPath = path.join(
      linked.appOutDir,
      'OpenPipal.app',
      ...BUILD_MANIFEST_PATH.split('/'),
    )
    await symlink(target, manifestPath)
    await expect(writeReleaseBuildManifest(linked.context, {
      OPENPIPAL_RELEASE_CANDIDATE: linked.candidate,
    })).rejects.toMatchObject({ code: 'EEXIST' })

    const linkedContents = await createCandidateFixture()
    const contentsPath = path.join(linkedContents.appOutDir, 'OpenPipal.app', 'Contents')
    await rm(contentsPath, { force: true, recursive: true })
    const outsideContents = path.join(linkedContents.root, 'outside-contents')
    await mkdir(path.join(outsideContents, 'Resources'), { recursive: true })
    await symlink(outsideContents, contentsPath)
    await expect(writeReleaseBuildManifest(linkedContents.context, {
      OPENPIPAL_RELEASE_CANDIDATE: linkedContents.candidate,
    })).rejects.toThrow('RELEASE_CONTENTS_DIRECTORY_INVALID')

    const platform = await createCandidateFixture()
    await expect(writeReleaseBuildManifest({
      ...platform.context,
      electronPlatformName: 'linux',
    }, { OPENPIPAL_RELEASE_CANDIDATE: platform.candidate })).rejects.toThrow(
      'RELEASE_PLATFORM_UNSUPPORTED',
    )
    await expect(writeReleaseBuildManifest({
      ...platform.context,
      arch: Arch.universal,
    }, { OPENPIPAL_RELEASE_CANDIDATE: platform.candidate })).rejects.toThrow(
      'RELEASE_ARCHITECTURE_UNSUPPORTED',
    )
  }, GIT_FIXTURE_TEST_TIMEOUT)
})
