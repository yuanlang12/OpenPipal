import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, unlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  collectAppInventory,
  generateInventory,
  parseMachOArchitectures,
  renderInventoryJson,
  renderInventoryMarkdown,
} from '../../scripts/generate-third-party-inventory.mjs'

// 这一组测试每条都要建临时 git 仓、跑若干次 git 子进程：I/O 主导，跟机器当下的负载走。
// 默认 5s 空载时绰绰有余，但同机开着 app / vite / playwright 就会整片超时红——红的是环境
// 不是代码（同一份代码空载 1637 全绿）。抬到 30s：它们本来就不是快测，用超时当性能守卫只会制造假警报。
vi.setConfig({ testTimeout: 30_000 })

const temporaryRoots: string[] = []

interface FixtureManifest {
  name: string
  version: string
  dependencies: Record<string, string>
}

interface FixtureLock {
  name: string
  version: string
  lockfileVersion: number
  packages: Record<string, Record<string, unknown>>
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { force: true, recursive: true })))
})

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

async function writeFixtureFile(root: string, relativePath: string, content: string | Buffer) {
  const absolutePath = path.join(root, ...relativePath.split('/'))
  await mkdir(path.dirname(absolutePath), { recursive: true })
  await writeFile(absolutePath, content)
}

async function createFixture(options: {
  config?: Record<string, unknown>
  lockMutation?: (lock: FixtureLock) => void
  manifestMutation?: (manifest: FixtureManifest) => void
} = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'openpipal-inventory-test-'))
  temporaryRoots.push(root)
  const manifest: FixtureManifest = {
    name: 'inventory-fixture',
    version: '1.0.0',
    dependencies: { seed: '1.0.0' },
  }
  const lock: FixtureLock = {
    name: 'inventory-fixture',
    version: '1.0.0',
    lockfileVersion: 3,
    packages: {
      '': {
        name: 'inventory-fixture',
        version: '1.0.0',
        dependencies: { seed: '1.0.0' },
      },
      'node_modules/seed': {
        version: '1.0.0',
        integrity: 'sha512-seed',
        license: 'MIT',
        dependencies: {
          '@fixture/child': '1.0.0',
          shared: '1.0.0',
        },
      },
      'node_modules/seed/node_modules/@fixture/child': {
        version: '1.0.0',
        integrity: 'sha512-child',
        license: 'Apache-2.0',
        os: ['darwin', 'linux'],
        cpu: ['arm64', 'x64'],
        optionalDependencies: { leaf: '1.0.0' },
      },
      'node_modules/seed/node_modules/@fixture/child/node_modules/leaf': {
        version: '1.0.0',
        integrity: 'sha512-leaf',
        license: 'ISC',
        optional: true,
      },
      'node_modules/shared': {
        version: '1.0.0',
        integrity: 'sha512-shared',
        license: 'BSD-2-Clause',
      },
      'node_modules/seed/node_modules/seed': {
        name: 'seed',
        version: '0.5.0',
        integrity: 'sha512-nested-seed',
        license: 'MIT',
      },
    },
  }
  options.manifestMutation?.(manifest)
  options.lockMutation?.(lock)
  const config = options.config ?? {
    schemaVersion: 1,
    runtimeSeeds: ['seed'],
    repositoryInputs: [
      { id: 'fixture-source', classification: 'vendored', paths: ['vendor/source.txt'] },
    ],
  }
  await writeFixtureFile(root, 'package.json', `${JSON.stringify(manifest, null, 2)}\n`)
  await writeFixtureFile(root, 'package-lock.json', `${JSON.stringify(lock, null, 2)}\n`)
  await writeFixtureFile(
    root,
    'docs/third-party-inventory-inputs.json',
    `${JSON.stringify(config, null, 2)}\n`,
  )
  await writeFixtureFile(root, 'vendor/source.txt', 'vendored fixture\n')
  await writeFixtureFile(
    root,
    'node_modules/seed/package.json',
    '{"name":"seed","version":"1.0.0"}\n',
  )
  await writeFixtureFile(root, 'node_modules/seed/LICENSE', 'fixture license\n')
  await writeFixtureFile(
    root,
    'node_modules/seed/node_modules/@fixture/child/package.json',
    '{"name":"@fixture/child","version":"1.0.0"}\n',
  )
  await writeFixtureFile(
    root,
    'node_modules/seed/node_modules/@fixture/child/NOTICE.txt',
    'fixture notice\n',
  )
  return root
}

function thinMachO(cpuType: number): Buffer {
  const buffer = Buffer.alloc(32)
  buffer.writeUInt32BE(0xfeedfacf, 0)
  buffer.writeUInt32BE(cpuType, 4)
  return buffer
}

function universalX64Arm64MachO(): Buffer {
  const x64 = thinMachO(0x01000007)
  const arm64 = thinMachO(0x0100000c)
  const firstSliceOffset = 48
  const secondSliceOffset = firstSliceOffset + x64.length
  const buffer = Buffer.alloc(secondSliceOffset + arm64.length)
  buffer.writeUInt32BE(0xcafebabe, 0)
  buffer.writeUInt32BE(2, 4)
  buffer.writeUInt32BE(0x01000007, 8)
  buffer.writeUInt32BE(firstSliceOffset, 16)
  buffer.writeUInt32BE(x64.length, 20)
  buffer.writeUInt32BE(0x0100000c, 28)
  buffer.writeUInt32BE(secondSliceOffset, 36)
  buffer.writeUInt32BE(arm64.length, 40)
  x64.copy(buffer, firstSliceOffset)
  arm64.copy(buffer, secondSliceOffset)
  return buffer
}

function universalFat64X64Arm64MachO(): Buffer {
  const x64 = thinMachO(0x01000007)
  const arm64 = thinMachO(0x0100000c)
  const firstSliceOffset = 72
  const secondSliceOffset = firstSliceOffset + x64.length
  const buffer = Buffer.alloc(secondSliceOffset + arm64.length)
  buffer.writeUInt32BE(0xcafebabf, 0)
  buffer.writeUInt32BE(2, 4)
  buffer.writeUInt32BE(0x01000007, 8)
  buffer.writeBigUInt64BE(BigInt(firstSliceOffset), 16)
  buffer.writeBigUInt64BE(BigInt(x64.length), 24)
  buffer.writeUInt32BE(0x0100000c, 40)
  buffer.writeBigUInt64BE(BigInt(secondSliceOffset), 48)
  buffer.writeBigUInt64BE(BigInt(arm64.length), 56)
  x64.copy(buffer, firstSliceOffset)
  arm64.copy(buffer, secondSliceOffset)
  return buffer
}

function replaceAsarHeader(
  archive: Buffer,
  mutate: (header: { files: Record<string, Record<string, unknown>> }) => void,
): Buffer {
  const oldHeaderSize = archive.readUInt32LE(4)
  const oldHeader = archive.subarray(8, 8 + oldHeaderSize)
  const jsonLength = oldHeader.readInt32LE(4)
  const header = JSON.parse(oldHeader.subarray(8, 8 + jsonLength).toString('utf8'))
  mutate(header)
  const json = Buffer.from(JSON.stringify(header))
  const alignedJsonLength = json.length + ((4 - (json.length % 4)) % 4)
  const headerPickle = Buffer.alloc(8 + alignedJsonLength)
  headerPickle.writeUInt32LE(4 + alignedJsonLength, 0)
  headerPickle.writeInt32LE(json.length, 4)
  json.copy(headerPickle, 8)
  const sizePickle = Buffer.alloc(8)
  sizePickle.writeUInt32LE(4, 0)
  sizePickle.writeUInt32LE(headerPickle.length, 4)
  return Buffer.concat([sizePickle, headerPickle, archive.subarray(8 + oldHeaderSize)])
}

async function createAppFixture(root: string, relativeAppPath: string): Promise<string> {
  const appPath = path.join(root, ...relativeAppPath.split('/'))
  await writeFixtureFile(root, `${relativeAppPath}/Contents/MacOS/OpenPipal`, thinMachO(0x0100000c))
  await writeFixtureFile(root, `${relativeAppPath}/Contents/Resources/content.txt`, 'content\n')
  await writeFixtureFile(root, `${relativeAppPath}/Contents/Resources/target-one.txt`, 'one\n')
  await writeFixtureFile(root, `${relativeAppPath}/Contents/Resources/target-two.txt`, 'two\n')
  await mkdir(path.join(appPath, 'Contents/Resources/empty'), { recursive: true })
  await symlink('target-one.txt', path.join(appPath, 'Contents/Resources/content-link.txt'))
  for (const directory of ['', 'Contents', 'Contents/MacOS', 'Contents/Resources']) {
    await chmod(path.join(appPath, directory), 0o755)
  }
  await chmod(path.join(appPath, 'Contents/Resources/empty'), 0o700)
  await chmod(path.join(appPath, 'Contents/MacOS/OpenPipal'), 0o755)
  for (const file of [
    'Contents/Resources/content.txt',
    'Contents/Resources/target-one.txt',
    'Contents/Resources/target-two.txt',
  ]) {
    await chmod(path.join(appPath, file), 0o644)
  }
  return appPath
}

describe('third-party inventory', () => {
  it('emits byte-identical evidence-only JSON and Markdown without host paths or timestamps', async () => {
    const first = await generateInventory({ rootDir: process.cwd() })
    const second = await generateInventory({ rootDir: process.cwd() })
    const firstJson = renderInventoryJson(first)
    const secondJson = renderInventoryJson(second)
    const markdown = renderInventoryMarkdown(first)

    expect(firstJson).toBe(secondJson)
    expect(markdown).toBe(renderInventoryMarkdown(second))
    expect(first.evidenceOnly).toBe(true)
    expect(first.redistributionClearance).toBe(false)
    expect(first).not.toHaveProperty('generatedAt')
    expect(first.inputs.manifest).toMatchObject({
      path: 'package.json',
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      size: expect.any(Number),
    })
    expect(firstJson).not.toContain(process.cwd())
    expect(markdown).not.toContain(process.cwd())
    expect(markdown).toContain('Evidence only: **yes**. Redistribution clearance: **no**.')
    expect(first.runtime.seeds.map(seed => seed.name)).toContain('@earendil-works/pi-agent-core')
    expect(first.packages.find(entry => entry.name === 'sharp')).toMatchObject({
      direct: true,
      directType: 'runtime',
      integrity: expect.stringMatching(/^sha512-/),
      license: 'Apache-2.0',
    })
    expect(first.packages.find(entry => entry.path === 'node_modules/tslib')).toMatchObject({
      dev: false,
      devOptional: true,
      optional: false,
    })
  })

  it('resolves nested and scoped lock dependencies while hashing only local evidence', async () => {
    const root = await createFixture()
    const inventory = await generateInventory({ rootDir: root })

    expect(inventory.runtime.packagePaths).toEqual([
      'node_modules/seed',
      'node_modules/seed/node_modules/@fixture/child',
      'node_modules/seed/node_modules/@fixture/child/node_modules/leaf',
      'node_modules/shared',
    ])
    expect(inventory.repositoryInputs[0]).toMatchObject({
      configuredPaths: ['vendor/source.txt'],
      excludedPaths: [],
      optional: false,
    })
    expect(inventory.runtime.edges).toContainEqual({
      dependency: 'shared',
      from: 'node_modules/seed',
      kind: 'dependency',
      to: 'node_modules/shared',
    })
    expect(inventory.runtime.edges).toContainEqual({
      dependency: 'leaf',
      from: 'node_modules/seed/node_modules/@fixture/child',
      kind: 'optionalDependency',
      to: 'node_modules/seed/node_modules/@fixture/child/node_modules/leaf',
    })
    const child = inventory.packages.find(entry => entry.name === '@fixture/child')
    expect(child).toMatchObject({
      cpu: ['arm64', 'x64'],
      os: ['darwin', 'linux'],
      runtimeDependency: true,
    })
    expect(child?.licenseEvidence).toEqual([
      {
        path: 'node_modules/seed/node_modules/@fixture/child/NOTICE.txt',
        sha256: sha256('fixture notice\n'),
        size: Buffer.byteLength('fixture notice\n'),
      },
    ])
    expect(
      inventory.packages.find(entry => entry.path === 'node_modules/seed/node_modules/seed'),
    ).toMatchObject({ direct: false, directType: null })
  })

  it('parses thin and old universal x64 plus arm64 Mach-O files', () => {
    expect(parseMachOArchitectures(thinMachO(0x0100000c))).toEqual(['arm64'])
    expect(parseMachOArchitectures(universalX64Arm64MachO())).toEqual(['arm64', 'x86_64'])
    expect(parseMachOArchitectures(universalFat64X64Arm64MachO())).toEqual([
      'arm64',
      'x86_64',
    ])
    expect(() => parseMachOArchitectures(Buffer.from('not mach-o'))).toThrow(/not a supported Mach-O/)
    const overlapping = universalX64Arm64MachO()
    overlapping.writeUInt32BE(48, 36)
    expect(() => parseMachOArchitectures(overlapping)).toThrow(/overlaps another slice/)
  })

  it('optionally inventories app Resources and classifies main and native executables', async () => {
    const root = await createFixture()
    const appPath = path.join(root, 'Old OpenPipal.app')
    await writeFixtureFile(root, 'Old OpenPipal.app/Contents/MacOS/Old OpenPipal', universalX64Arm64MachO())
    await chmod(path.join(appPath, 'Contents/MacOS/Old OpenPipal'), 0o755)
    await writeFixtureFile(
      root,
      'Old OpenPipal.app/Contents/Resources/addon.node',
      universalX64Arm64MachO(),
    )
    await writeFixtureFile(root, 'Old OpenPipal.app/Contents/Resources/readme.txt', 'resource\n')
    await writeFixtureFile(root, 'asar-source/native/addon.node', universalX64Arm64MachO())
    await writeFixtureFile(root, 'asar-source/bin/cli.js', '#!/usr/bin/env node\n')
    await chmod(path.join(root, 'asar-source/bin/cli.js'), 0o755)
    await writeFixtureFile(root, 'asar-source/unpacked-bin/tool', '#!/bin/sh\nexit 0\n')
    await chmod(path.join(root, 'asar-source/unpacked-bin/tool'), 0o755)
    await writeFixtureFile(root, 'asar-source/readme.txt', 'asar resource\n')
    await symlink('readme.txt', path.join(root, 'asar-source/readme-link.txt'))
    const asar = await import('@electron/asar')
    await asar.createPackageWithOptions(
      path.join(root, 'asar-source'),
      path.join(appPath, 'Contents/Resources/app.asar'),
      { unpack: '**/*.node', unpackDir: 'unpacked-bin' },
    )

    const generatedArchive = await readFile(path.join(appPath, 'Contents/Resources/app.asar'))
    const generatedHeaderSize = generatedArchive.readUInt32LE(4)
    const generatedHeaderPickle = generatedArchive.subarray(8, 8 + generatedHeaderSize)
    const generatedJsonLength = generatedHeaderPickle.readInt32LE(4)
    const generatedHeader = JSON.parse(
      generatedHeaderPickle.subarray(8, 8 + generatedJsonLength).toString('utf8'),
    )
    expect(generatedHeader.files['unpacked-bin'].files.tool).not.toHaveProperty('executable')

    const inventory = await generateInventory({ appPath, rootDir: root })

    expect(inventory.app?.app).toBe('Old OpenPipal.app')
    expect(inventory.app?.contentSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(inventory.app?.architecturePolicy).toEqual({
      mainArchitectures: ['arm64', 'x86_64'],
      rule: 'each-mach-o-native-covers-all-main-architectures',
    })
    expect(inventory.app?.resources.map(entry => entry.path)).toEqual([
      'Contents/Resources/addon.node',
      'Contents/Resources/app.asar',
      'Contents/Resources/app.asar.unpacked/native/addon.node',
      'Contents/Resources/app.asar.unpacked/unpacked-bin/tool',
      'Contents/Resources/readme.txt',
    ])
    expect(inventory.app?.asarEntries.map(entry => entry.path)).toEqual([
      'Contents/Resources/app.asar/bin/cli.js',
      'Contents/Resources/app.asar/native/addon.node',
      'Contents/Resources/app.asar/readme-link.txt',
      'Contents/Resources/app.asar/readme.txt',
      'Contents/Resources/app.asar/unpacked-bin/tool',
    ])
    expect(
      inventory.app?.asarEntries.find(entry => entry.path.endsWith('/bin/cli.js')),
    ).toMatchObject({ executable: true })
    expect(
      inventory.app?.asarEntries.find(entry => entry.path.endsWith('/readme-link.txt')),
    ).toMatchObject({ symbolicLink: true, target: 'readme.txt' })
    expect(
      inventory.app?.asarEntries.find(entry => entry.path.endsWith('/unpacked-bin/tool')),
    ).toMatchObject({
      executable: true,
      sha256: sha256('#!/bin/sh\nexit 0\n'),
      unpacked: true,
    })
    expect(inventory.app?.nativeBinaries).toEqual([
      {
        architectures: ['arm64', 'x86_64'],
        path: 'Contents/MacOS/Old OpenPipal',
        role: 'main-executable',
        source: 'filesystem',
      },
      {
        architectures: ['arm64', 'x86_64'],
        path: 'Contents/Resources/addon.node',
        role: 'node-addon',
        source: 'filesystem',
      },
      {
        architectures: ['arm64', 'x86_64'],
        path: 'Contents/Resources/app.asar.unpacked/native/addon.node',
        role: 'node-addon',
        source: 'filesystem',
      },
      {
        architectures: ['arm64', 'x86_64'],
        path: 'Contents/Resources/app.asar/native/addon.node',
        role: 'node-addon',
        source: 'asar',
      },
    ])
    const unpackedEntry = inventory.app?.asarEntries.find(entry =>
      entry.path.endsWith('/native/addon.node'),
    )
    const unpackedFile = inventory.app?.files.find(entry =>
      entry.path.endsWith('.asar.unpacked/native/addon.node'),
    )
    expect(unpackedEntry).toMatchObject({
      sha256: unpackedFile?.sha256,
      unpacked: true,
    })
    expect(
      inventory.app?.asarEntries.find(entry => entry.path.endsWith('/readme.txt')),
    ).toMatchObject({
      sha256: sha256('asar resource\n'),
      size: Buffer.byteLength('asar resource\n'),
      unpacked: false,
    })
    expect(renderInventoryJson(inventory)).not.toContain(root)
    expect(renderInventoryMarkdown(inventory)).toContain(
      `- Content SHA-256: ${inventory.app?.contentSha256}`,
    )
  })

  it('rejects malformed ASAR pickle metadata', async () => {
    const root = await createFixture()
    const appPath = path.join(root, 'Malformed ASAR.app')
    await writeFixtureFile(
      root,
      'Malformed ASAR.app/Contents/MacOS/Malformed ASAR',
      thinMachO(0x0100000c),
    )
    await chmod(path.join(appPath, 'Contents/MacOS/Malformed ASAR'), 0o755)
    await writeFixtureFile(root, 'malformed-asar/packed.txt', 'packed content\n')
    const archivePath = path.join(appPath, 'Contents/Resources/app.asar')
    const asar = await import('@electron/asar')
    await asar.createPackage(path.join(root, 'malformed-asar'), archivePath)
    const archive = await readFile(archivePath)
    archive.writeUInt32LE(8, 0)
    await writeFile(archivePath, archive)

    await expect(collectAppInventory(appPath)).rejects.toThrow(/Malformed ASAR size pickle/)
  })

  it('rejects an unpacked executable claim that conflicts with pinned filesystem mode', async () => {
    const root = await createFixture()
    const appPath = path.join(root, 'Executable Mismatch.app')
    await writeFixtureFile(
      root,
      'Executable Mismatch.app/Contents/MacOS/Executable Mismatch',
      thinMachO(0x0100000c),
    )
    await chmod(path.join(appPath, 'Contents/MacOS/Executable Mismatch'), 0o755)
    await writeFixtureFile(root, 'executable-asar/tool', 'not executable\n')
    await chmod(path.join(root, 'executable-asar/tool'), 0o644)
    const archivePath = path.join(appPath, 'Contents/Resources/app.asar')
    const asar = await import('@electron/asar')
    await asar.createPackageWithOptions(path.join(root, 'executable-asar'), archivePath, {
      unpack: 'tool',
    })
    const archive = await readFile(archivePath)
    const corrupted = replaceAsarHeader(archive, header => {
      header.files.tool.executable = true
    })
    await writeFile(archivePath, corrupted)

    await expect(collectAppInventory(appPath)).rejects.toThrow(
      /ASAR unpacked metadata does not match pinned app evidence/,
    )
  })

  it('rejects an ASAR packed file range outside its pinned archive bytes', async () => {
    const root = await createFixture()
    const appPath = path.join(root, 'Out Of Bounds ASAR.app')
    await writeFixtureFile(
      root,
      'Out Of Bounds ASAR.app/Contents/MacOS/Out Of Bounds ASAR',
      thinMachO(0x0100000c),
    )
    await chmod(path.join(appPath, 'Contents/MacOS/Out Of Bounds ASAR'), 0o755)
    await writeFixtureFile(root, 'bounds-asar/packed.txt', 'packed content\n')
    const archivePath = path.join(appPath, 'Contents/Resources/app.asar')
    const asar = await import('@electron/asar')
    await asar.createPackage(path.join(root, 'bounds-asar'), archivePath)
    const archive = await readFile(archivePath)
    const corrupted = replaceAsarHeader(archive, header => {
      header.files['packed.txt'].offset = String(archive.length)
    })
    await writeFile(archivePath, corrupted)

    await expect(collectAppInventory(appPath)).rejects.toThrow(
      /ASAR file range is outside the archive: packed\.txt/,
    )
  })

  it('accepts real ASAR integrity block boundaries including a trailing empty block', async () => {
    const root = await createFixture()
    const appPath = path.join(root, 'Integrity Boundaries.app')
    await writeFixtureFile(
      root,
      'Integrity Boundaries.app/Contents/MacOS/Integrity Boundaries',
      thinMachO(0x0100000c),
    )
    await chmod(path.join(appPath, 'Contents/MacOS/Integrity Boundaries'), 0o755)
    const blockSize = 4 * 1024 * 1024
    const sizes = new Map([
      ['empty.dat', 0],
      ['minus-one.dat', blockSize - 1],
      ['exact.dat', blockSize],
      ['plus-one.dat', blockSize + 1],
    ])
    for (const [fileName, size] of sizes) {
      await writeFixtureFile(root, `integrity-asar/${fileName}`, Buffer.alloc(size))
    }
    const archivePath = path.join(appPath, 'Contents/Resources/app.asar')
    const asar = await import('@electron/asar')
    await asar.createPackage(path.join(root, 'integrity-asar'), archivePath)

    const archive = await readFile(archivePath)
    const headerSize = archive.readUInt32LE(4)
    const headerPickle = archive.subarray(8, 8 + headerSize)
    const jsonLength = headerPickle.readInt32LE(4)
    const header = JSON.parse(headerPickle.subarray(8, 8 + jsonLength).toString('utf8'))
    expect(header.files['empty.dat'].integrity.blocks).toHaveLength(1)
    expect(header.files['minus-one.dat'].integrity.blocks).toHaveLength(1)
    expect(header.files['exact.dat'].integrity.blocks).toHaveLength(2)
    expect(header.files['plus-one.dat'].integrity.blocks).toHaveLength(2)

    const inventory = await collectAppInventory(appPath)
    for (const [fileName, size] of sizes) {
      expect(
        inventory.asarEntries.find(entry => entry.path.endsWith(`/${fileName}`)),
      ).toMatchObject({ size, unpacked: false })
    }

    const corrupted = replaceAsarHeader(archive, headerToMutate => {
      const metadata = headerToMutate.files['exact.dat'] as {
        integrity: { blocks: string[] }
      }
      metadata.integrity.blocks[0] = '0'.repeat(64)
    })
    await writeFile(archivePath, corrupted)
    await expect(collectAppInventory(appPath)).rejects.toThrow(
      /ASAR integrity block does not match content: exact\.dat/,
    )
  })

  it('validates a long ASAR link graph once and rejects cycles or missing targets', async () => {
    const root = await createFixture()
    const appPath = path.join(root, 'Link Graph.app')
    await writeFixtureFile(root, 'Link Graph.app/Contents/MacOS/Link Graph', thinMachO(0x0100000c))
    await chmod(path.join(appPath, 'Contents/MacOS/Link Graph'), 0o755)
    await writeFixtureFile(root, 'link-asar/target.txt', 'target\n')
    const archivePath = path.join(appPath, 'Contents/Resources/app.asar')
    const asar = await import('@electron/asar')
    await asar.createPackage(path.join(root, 'link-asar'), archivePath)
    const originalArchive = await readFile(archivePath)
    const linkCount = 4_096
    const longChain = replaceAsarHeader(originalArchive, header => {
      const files: Record<string, Record<string, unknown>> = {
        'target.txt': header.files['target.txt'],
      }
      for (let index = 0; index < linkCount; index += 1) {
        const name = `link-${index.toString().padStart(4, '0')}`
        const target = index === linkCount - 1
          ? 'target.txt'
          : `link-${(index + 1).toString().padStart(4, '0')}`
        files[name] = { link: target }
      }
      header.files = files
    })
    await writeFile(archivePath, longChain)
    const inventory = await collectAppInventory(appPath)
    expect(inventory.asarEntries).toHaveLength(linkCount + 1)
    expect(inventory.asarEntries[0]).toMatchObject({
      path: expect.stringContaining('/link-0000'),
      symbolicLink: true,
      target: 'link-0001',
    })

    const cycle = replaceAsarHeader(originalArchive, header => {
      header.files['cycle-a'] = { link: 'cycle-b' }
      header.files['cycle-b'] = { link: 'cycle-a' }
    })
    await writeFile(archivePath, cycle)
    await expect(collectAppInventory(appPath)).rejects.toThrow(/ASAR link cycle detected/)

    const missing = replaceAsarHeader(originalArchive, header => {
      header.files.missing = { link: 'does-not-exist' }
    })
    await writeFile(archivePath, missing)
    await expect(collectAppInventory(appPath)).rejects.toThrow(/ASAR link target does not exist/)
  })

  it('hashes app filesystem content deterministically without host metadata', async () => {
    const root = await createFixture()
    const firstAppPath = await createAppFixture(root, 'first/OpenPipal.app')
    const secondAppPath = await createAppFixture(root, 'second/OpenPipal.app')

    const baseline = await collectAppInventory(firstAppPath)
    const identical = await collectAppInventory(secondAppPath)

    expect(baseline.contentSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(baseline.contentSha256).toBe(
      '327d681b405c92e6540ce77a23c7c9bf126f06d5d56202370aab2d8bcae7edff',
    )
    expect(identical.contentSha256).toBe(baseline.contentSha256)

    const contentPath = path.join(firstAppPath, 'Contents/Resources/content.txt')
    await writeFile(contentPath, 'changed content\n')
    expect((await collectAppInventory(firstAppPath)).contentSha256).not.toBe(
      baseline.contentSha256,
    )

    await writeFile(contentPath, 'content\n')
    expect((await collectAppInventory(firstAppPath)).contentSha256).toBe(baseline.contentSha256)

    await utimes(contentPath, new Date(1_000), new Date(2_000))
    expect((await collectAppInventory(firstAppPath)).contentSha256).toBe(baseline.contentSha256)

    await chmod(contentPath, 0o640)
    expect((await collectAppInventory(firstAppPath)).contentSha256).not.toBe(
      baseline.contentSha256,
    )

    await chmod(contentPath, 0o644)
    expect((await collectAppInventory(firstAppPath)).contentSha256).toBe(baseline.contentSha256)

    const emptyDirectory = path.join(firstAppPath, 'Contents/Resources/empty')
    await chmod(emptyDirectory, 0o755)
    expect((await collectAppInventory(firstAppPath)).contentSha256).not.toBe(
      baseline.contentSha256,
    )
    await chmod(emptyDirectory, 0o700)
    expect((await collectAppInventory(firstAppPath)).contentSha256).toBe(baseline.contentSha256)

    const linkPath = path.join(firstAppPath, 'Contents/Resources/content-link.txt')
    await unlink(linkPath)
    await symlink('target-two.txt', linkPath)
    expect((await collectAppInventory(firstAppPath)).contentSha256).not.toBe(
      baseline.contentSha256,
    )
  })

  it('rejects a path identity swap after reading from a pinned file descriptor', async () => {
    const root = await createFixture()
    const appPath = await createAppFixture(root, 'race/OpenPipal.app')
    let swapped = false

    await expect(collectAppInventory(appPath, {
      afterPinnedFileRead: async ({ absolutePath, relativePath }) => {
        if (swapped || relativePath !== 'Contents/Resources/content.txt') return
        swapped = true
        await unlink(absolutePath)
        await writeFile(absolutePath, 'content\n', { mode: 0o644 })
      },
    })).rejects.toThrow(/App bundle entry changed during inventory: Contents\/Resources\/content\.txt/)
    expect(swapped).toBe(true)
  })

  it('fails closed on a manifest and lock mismatch', async () => {
    const root = await createFixture({
      manifestMutation: manifest => {
        manifest.dependencies.seed = '^2.0.0'
      },
    })
    await expect(generateInventory({ rootDir: root })).rejects.toThrow(
      /dependencies do not match the package-lock/,
    )
  })

  it('fails closed before a lock package path can escape the inventory root', async () => {
    const root = await createFixture({
      lockMutation: lock => {
        lock.packages['node_modules/../../outside'] = {
          name: 'outside',
          version: '1.0.0',
        }
      },
    })
    await expect(generateInventory({ rootDir: root })).rejects.toThrow(/Unsafe package-lock path/)
  })

  it('fails closed when a configured runtime seed is absent from the lock', async () => {
    const root = await createFixture({
      config: {
        schemaVersion: 1,
        runtimeSeeds: ['seed', 'missing'],
        repositoryInputs: [],
      },
    })
    await expect(generateInventory({ rootDir: root })).rejects.toThrow(
      /Configured runtime seed is missing from the lock: missing/,
    )
  })

  it('fails closed on unknown repository classifications', async () => {
    const root = await createFixture({
      config: {
        schemaVersion: 1,
        runtimeSeeds: ['seed'],
        repositoryInputs: [
          { id: 'unknown', classification: 'maybe-vendored', paths: ['vendor/source.txt'] },
        ],
      },
    })
    await expect(generateInventory({ rootDir: root })).rejects.toThrow(
      /Unknown repository input classification/,
    )
  })

  it('rejects Windows absolute paths even when generation runs on macOS', async () => {
    const root = await createFixture({
      config: {
        schemaVersion: 1,
        runtimeSeeds: ['seed'],
        repositoryInputs: [
          { id: 'windows-path', classification: 'vendored', paths: ['C:\\private\\file.txt'] },
        ],
      },
    })
    await expect(generateInventory({ rootDir: root })).rejects.toThrow(/must not be absolute/)
  })

  it('fails closed when binary content is hidden in a non-binary input', async () => {
    const root = await createFixture()
    await writeFixtureFile(root, 'vendor/source.txt', Buffer.from([0, 1, 2, 3]))
    await expect(generateInventory({ rootDir: root })).rejects.toThrow(
      /Unclassified binary vendor\/source.txt/,
    )
  })

  it('fails closed when an app executable is not Mach-O', async () => {
    const root = await createFixture()
    const appPath = path.join(root, 'Broken.app')
    await writeFixtureFile(root, 'Broken.app/Contents/MacOS/Broken', '#!/bin/sh\n')
    await chmod(path.join(appPath, 'Contents/MacOS/Broken'), 0o755)

    await expect(generateInventory({ appPath, rootDir: root })).rejects.toThrow(
      /Classified native binary is not Mach-O/,
    )
  })

  it('fails closed when a native addon does not cover every main executable architecture', async () => {
    const root = await createFixture()
    const appPath = path.join(root, 'Mismatched.app')
    await writeFixtureFile(
      root,
      'Mismatched.app/Contents/MacOS/Mismatched',
      universalX64Arm64MachO(),
    )
    await chmod(path.join(appPath, 'Contents/MacOS/Mismatched'), 0o755)
    await writeFixtureFile(
      root,
      'Mismatched.app/Contents/Resources/arm-only.node',
      thinMachO(0x0100000c),
    )

    await expect(generateInventory({ appPath, rootDir: root })).rejects.toThrow(
      /arm-only\.node does not cover main executable architecture\(s\): x86_64/,
    )
  })

  it('fails closed when a bundle has more than one top-level main executable', async () => {
    const root = await createFixture()
    const appPath = path.join(root, 'Two Mains.app')
    for (const executable of ['First', 'Second']) {
      await writeFixtureFile(
        root,
        `Two Mains.app/Contents/MacOS/${executable}`,
        thinMachO(0x0100000c),
      )
      await chmod(path.join(appPath, 'Contents/MacOS', executable), 0o755)
    }

    await expect(generateInventory({ appPath, rootDir: root })).rejects.toThrow(
      /exactly one executable.*found 2/,
    )
  })

  it('fails closed on ELF magic even without an executable bit or known extension', async () => {
    const root = await createFixture()
    const appPath = path.join(root, 'Foreign Binary.app')
    await writeFixtureFile(
      root,
      'Foreign Binary.app/Contents/MacOS/Foreign Binary',
      thinMachO(0x0100000c),
    )
    await chmod(path.join(appPath, 'Contents/MacOS/Foreign Binary'), 0o755)
    await writeFixtureFile(
      root,
      'elf-asar/bin/apply-seccomp',
      Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]),
    )
    const asar = await import('@electron/asar')
    await asar.createPackage(
      path.join(root, 'elf-asar'),
      path.join(appPath, 'Contents/Resources/app.asar'),
    )

    await expect(generateInventory({ appPath, rootDir: root })).rejects.toThrow(
      /Unsupported ELF binary.*app\.asar\/bin\/apply-seccomp/,
    )
  })

  it('fails closed when a configured app WebAssembly binary has an invalid version', async () => {
    const root = await createFixture()
    const appPath = path.join(root, 'Bad Wasm.app')
    await writeFixtureFile(root, 'Bad Wasm.app/Contents/MacOS/Bad Wasm', thinMachO(0x0100000c))
    await chmod(path.join(appPath, 'Contents/MacOS/Bad Wasm'), 0o755)
    await writeFixtureFile(
      root,
      'Bad Wasm.app/Contents/Resources/bad.wasm',
      Buffer.from([0, 0x61, 0x73, 0x6d, 2, 0, 0, 0]),
    )

    await expect(generateInventory({ appPath, rootDir: root })).rejects.toThrow(
      /WebAssembly binary has an invalid header/,
    )
  })
})
