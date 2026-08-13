#!/usr/bin/env node

import { Buffer, constants as bufferConstants } from 'node:buffer'
import { createHash } from 'node:crypto'
import { lstat, open, readFile, readdir, readlink } from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { TextDecoder } from 'node:util'

const SCRIPT_PATH = fileURLToPath(import.meta.url)
const DEFAULT_CONFIG_PATH = 'docs/third-party-inventory-inputs.json'
const APP_CONTENT_MANIFEST_DOMAIN = 'openpipal.app-filesystem-content'
const APP_CONTENT_MANIFEST_VERSION = 1
const ASAR_PROTOTYPE_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
const ASAR_UINT32_MAX = 2 ** 32 - 1
const ALLOWED_CLASSIFICATIONS = new Set(['binary', 'skills', 'vendored'])
const LICENSE_EVIDENCE_PATTERN = /^(?:licen[cs]e|copying|notice)(?:[._-].*)?$/i
const DEFINITELY_BINARY_EXTENSIONS = new Set([
  '.dll',
  '.dylib',
  '.exe',
  '.gif',
  '.icns',
  '.ico',
  '.jpeg',
  '.jpg',
  '.node',
  '.pdf',
  '.png',
  '.so',
  '.wasm',
  '.webp',
])
const CPU_ARCHITECTURES = new Map([
  [0x00000007, 'i386'],
  [0x01000007, 'x86_64'],
  [0x0000000c, 'arm'],
  [0x0100000c, 'arm64'],
  [0x0200000c, 'arm64_32'],
  [0x00000012, 'ppc'],
  [0x01000012, 'ppc64'],
])

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0
}

function normalizeRelativePath(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} must be a non-empty relative path`)
  }
  if (path.isAbsolute(value) || path.win32.isAbsolute(value)) {
    throw new Error(`${label} must not be absolute: ${value}`)
  }
  const slashNormalized = value.replaceAll('\\', '/')
  const normalized = path.posix.normalize(slashNormalized)
  if (normalized === '..' || normalized.startsWith('../')) {
    throw new Error(`${label} must stay inside the inventory root: ${value}`)
  }
  const withoutCurrentDirectory = slashNormalized.replace(/^\.\//, '')
  if (normalized !== withoutCurrentDirectory) {
    throw new Error(`${label} must already be normalized: ${value}`)
  }
  return normalized
}

function validatePackageName(name, label) {
  if (typeof name !== 'string' || name.length === 0 || name.includes('\\')) {
    throw new Error(`${label} is not a valid package name`)
  }
  const segments = name.split('/')
  const valid = name.startsWith('@')
    ? segments.length === 2 && segments.every(segment => segment !== '' && segment !== '.' && segment !== '..')
    : segments.length === 1 && segments[0] !== '.' && segments[0] !== '..'
  if (!valid) throw new Error(`${label} is not a valid package name: ${name}`)
  return name
}

function validatePackageLockPath(lockPath) {
  if (typeof lockPath !== 'string' || lockPath.includes('\\') || path.posix.normalize(lockPath) !== lockPath) {
    throw new Error(`Unsafe package-lock path: ${lockPath}`)
  }
  let remainder = lockPath
  while (remainder.length > 0) {
    if (!remainder.startsWith('node_modules/')) {
      throw new Error(`Unsupported package-lock path: ${lockPath}`)
    }
    remainder = remainder.slice('node_modules/'.length)
    const segments = remainder.split('/')
    const packageName = segments[0].startsWith('@')
      ? `${segments[0]}/${segments[1] ?? ''}`
      : segments[0]
    validatePackageName(packageName, `Package in lock path ${lockPath}`)
    const consumedSegments = packageName.startsWith('@') ? 2 : 1
    remainder = segments.slice(consumedSegments).join('/')
  }
  return lockPath
}

function sha256(content) {
  return createHash('sha256').update(content).digest('hex')
}

const SNAPSHOT_FIELDS = [
  'dev',
  'ino',
  'mode',
  'nlink',
  'uid',
  'gid',
  'rdev',
  'size',
  'mtimeNs',
  'ctimeNs',
]

function fileSnapshot(metadata) {
  return Object.fromEntries(SNAPSHOT_FIELDS.map(field => [field, metadata[field]]))
}

function sameFileSnapshot(left, right) {
  return SNAPSHOT_FIELDS.every(field => left[field] === right[field])
}

function assertStableAppEntry(expected, actual, relativePath) {
  if (!sameFileSnapshot(expected, actual)) {
    throw new Error(`App bundle entry changed during inventory: ${relativePath || '.'}`)
  }
}

function containsDisallowedControlCharacter(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (
      (code >= 1 && code <= 8)
      || code === 11
      || code === 12
      || (code >= 14 && code <= 31)
      || code === 127
    ) {
      return true
    }
  }
  return false
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

async function readJson(filePath, label) {
  let text
  try {
    text = await readFile(filePath, 'utf8')
  } catch (error) {
    throw new Error(`Unable to read ${label}`, { cause: error })
  }
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new Error(`Invalid JSON in ${label}`, { cause: error })
  }
}

async function inputFileEvidence(rootDir, relativePath) {
  const content = await readFile(path.join(rootDir, ...relativePath.split('/')))
  return {
    path: relativePath,
    sha256: sha256(content),
    size: content.length,
  }
}

function sameDependencyMap(left, right) {
  return JSON.stringify(stableObject(left ?? {})) === JSON.stringify(stableObject(right ?? {}))
}

function validateManifestLock(manifest, lock) {
  if (lock.lockfileVersion !== 3 || !lock.packages || typeof lock.packages !== 'object') {
    throw new Error('package-lock.json must use lockfileVersion 3 and contain packages')
  }
  for (const [lockPath, packageEntry] of Object.entries(lock.packages)) {
    if (lockPath !== '') validatePackageLockPath(lockPath)
    if (!packageEntry || typeof packageEntry !== 'object' || Array.isArray(packageEntry)) {
      throw new Error(`Invalid package-lock package entry: ${lockPath || '<root>'}`)
    }
  }
  const lockRoot = lock.packages['']
  if (!lockRoot) throw new Error('package-lock.json is missing the root package entry')
  if (manifest.name !== lockRoot.name || manifest.version !== lockRoot.version) {
    throw new Error('package.json name/version do not match the package-lock root entry')
  }
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    if (!sameDependencyMap(manifest[field], lockRoot[field])) {
      throw new Error(`package.json ${field} do not match the package-lock root entry`)
    }
  }

  const owners = new Map()
  for (const [field, dependencies] of [
    ['dependencies', manifest.dependencies],
    ['devDependencies', manifest.devDependencies],
    ['optionalDependencies', manifest.optionalDependencies],
  ]) {
    for (const name of Object.keys(dependencies ?? {})) {
      validatePackageName(name, `Direct dependency in ${field}`)
      if (owners.has(name)) {
        throw new Error(`Direct dependency ${name} is declared in both ${owners.get(name)} and ${field}`)
      }
      owners.set(name, field)
      const lockPath = `node_modules/${name}`
      if (!lock.packages[lockPath]?.version) {
        throw new Error(`Direct dependency ${name} is missing from package-lock packages`)
      }
    }
  }
}

function packageNameFromLockPath(lockPath) {
  const marker = 'node_modules/'
  const markerIndex = lockPath.lastIndexOf(marker)
  if (markerIndex < 0) throw new Error(`Unsupported package-lock path: ${lockPath}`)
  const remainder = lockPath.slice(markerIndex + marker.length)
  const segments = remainder.split('/')
  if (segments[0]?.startsWith('@')) {
    if (!segments[1]) throw new Error(`Malformed scoped package-lock path: ${lockPath}`)
    return `${segments[0]}/${segments[1]}`
  }
  if (!segments[0]) throw new Error(`Malformed package-lock path: ${lockPath}`)
  return segments[0]
}

function resolveDependencyPath(packages, fromPath, dependencyName) {
  let base = fromPath
  while (true) {
    const candidate = base
      ? `${base}/node_modules/${dependencyName}`
      : `node_modules/${dependencyName}`
    if (packages[candidate]) return candidate

    const parentMarker = base.lastIndexOf('/node_modules/')
    if (parentMarker >= 0) {
      base = base.slice(0, parentMarker)
      continue
    }
    if (base.startsWith('node_modules/')) {
      base = ''
      continue
    }
    return null
  }
}

function directTypeFor(name, manifest, lockPath = `node_modules/${name}`) {
  if (lockPath !== `node_modules/${name}`) return null
  if (Object.hasOwn(manifest.dependencies ?? {}, name)) return 'runtime'
  if (Object.hasOwn(manifest.optionalDependencies ?? {}, name)) return 'optional'
  if (Object.hasOwn(manifest.devDependencies ?? {}, name)) return 'development'
  return null
}

function normalizeStringList(value, label) {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    throw new Error(`${label} must be an array of strings`)
  }
  return [...new Set(value)].sort(compareText)
}

function computeRuntimeClosure(manifest, packages, configuredSeeds) {
  const seeds = normalizeStringList(configuredSeeds, 'runtimeSeeds')
  const requiredSeeds = [
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {}),
  ].sort(compareText)
  for (const requiredSeed of requiredSeeds) {
    if (!seeds.includes(requiredSeed)) {
      throw new Error(`Runtime seed configuration omits direct runtime dependency ${requiredSeed}`)
    }
  }
  if (seeds.length === 0) throw new Error('runtimeSeeds must not be empty')

  const seedRecords = seeds.map(name => {
    const lockPath = `node_modules/${name}`
    if (!packages[lockPath]) throw new Error(`Configured runtime seed is missing from the lock: ${name}`)
    if (!directTypeFor(name, manifest)) {
      throw new Error(`Configured runtime seed is not a direct manifest dependency: ${name}`)
    }
    return { name, path: lockPath }
  })

  const visited = new Set()
  const pending = seedRecords.map(seed => seed.path).sort(compareText)
  const edges = []
  while (pending.length > 0) {
    const lockPath = pending.shift()
    if (visited.has(lockPath)) continue
    visited.add(lockPath)
    const packageEntry = packages[lockPath]
    if (!packageEntry) throw new Error(`Runtime closure references missing lock package ${lockPath}`)

    const dependencyGroups = [
      ['dependency', packageEntry.dependencies],
      ['optionalDependency', packageEntry.optionalDependencies],
      ['peerDependency', packageEntry.peerDependencies],
    ]
    for (const [configuredKind, dependencies] of dependencyGroups) {
      for (const dependencyName of Object.keys(dependencies ?? {}).sort(compareText)) {
        validatePackageName(dependencyName, `Dependency of ${lockPath}`)
        const optionalPeer =
          configuredKind === 'peerDependency'
          && packageEntry.peerDependenciesMeta?.[dependencyName]?.optional === true
        const kind = optionalPeer ? 'optionalPeerDependency' : configuredKind
        const resolvedPath = resolveDependencyPath(packages, lockPath, dependencyName)
        if (!resolvedPath) {
          if (optionalPeer) {
            edges.push({ dependency: dependencyName, from: lockPath, kind, to: null })
            continue
          }
          throw new Error(
            `Unable to resolve ${kind} ${dependencyName} from lock package ${lockPath}`,
          )
        }
        edges.push({ dependency: dependencyName, from: lockPath, kind, to: resolvedPath })
        if (!visited.has(resolvedPath)) pending.push(resolvedPath)
      }
    }
    pending.sort(compareText)
  }

  edges.sort((left, right) =>
    compareText(
      `${left.from}\0${left.kind}\0${left.dependency}\0${left.to ?? ''}`,
      `${right.from}\0${right.kind}\0${right.dependency}\0${right.to ?? ''}`,
    ),
  )
  return {
    seeds: seedRecords,
    packagePaths: [...visited].sort(compareText),
    edges,
  }
}

async function localLicenseEvidence(rootDir, lockPath, expectedName, expectedVersion) {
  const packageDirectory = path.join(rootDir, ...lockPath.split('/'))
  let entries
  try {
    entries = await readdir(packageDirectory, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT') return { installed: false, evidence: [] }
    throw error
  }
  let installedManifest
  try {
    installedManifest = JSON.parse(await readFile(path.join(packageDirectory, 'package.json'), 'utf8'))
  } catch (error) {
    throw new Error(`Installed lock package has no readable package.json: ${lockPath}`, {
      cause: error,
    })
  }
  if (installedManifest.name !== expectedName || installedManifest.version !== expectedVersion) {
    throw new Error(`Installed package metadata does not match the lock: ${lockPath}`)
  }
  const candidates = entries
    .filter(entry => entry.isFile() && LICENSE_EVIDENCE_PATTERN.test(entry.name))
    .map(entry => entry.name)
    .sort(compareText)
  const evidence = []
  for (const fileName of candidates) {
    const content = await readFile(path.join(packageDirectory, fileName))
    evidence.push({
      path: `${lockPath}/${fileName}`,
      sha256: sha256(content),
      size: content.length,
    })
  }
  return {
    installed: true,
    installedName: installedManifest.name,
    installedVersion: installedManifest.version,
    evidence,
  }
}

async function collectPackages(rootDir, manifest, packages, runtimePackagePaths) {
  const records = []
  const runtimePaths = new Set(runtimePackagePaths)
  for (const lockPath of Object.keys(packages).filter(Boolean).sort(compareText)) {
    const packageEntry = packages[lockPath]
    if (!lockPath.includes('node_modules/')) {
      throw new Error(`Unclassified non-root package-lock path: ${lockPath}`)
    }
    const pathName = packageNameFromLockPath(lockPath)
    if (packageEntry.name !== undefined && packageEntry.name !== pathName) {
      throw new Error(`Package name does not match its lock path: ${lockPath}`)
    }
    const name = pathName
    const directType = directTypeFor(name, manifest, lockPath)
    const localEvidence = await localLicenseEvidence(
      rootDir,
      lockPath,
      name,
      packageEntry.version ?? null,
    )
    records.push({
      cpu: normalizeStringList(packageEntry.cpu, `${lockPath}.cpu`),
      dev: packageEntry.dev === true,
      devOptional: packageEntry.devOptional === true,
      direct: directType !== null,
      directType,
      installed: localEvidence.installed,
      installedName: localEvidence.installedName ?? null,
      installedVersion: localEvidence.installedVersion ?? null,
      integrity: typeof packageEntry.integrity === 'string' ? packageEntry.integrity : null,
      license: packageEntry.license ?? null,
      licenseEvidence: localEvidence.evidence,
      name,
      optional: packageEntry.optional === true,
      os: normalizeStringList(packageEntry.os, `${lockPath}.os`),
      path: lockPath,
      runtimeDependency: runtimePaths.has(lockPath),
      version: packageEntry.version ?? null,
    })
  }
  return records
}

function isMachOMagic(buffer) {
  if (buffer.length < 4) return false
  return new Set([
    0xfeedface,
    0xcefaedfe,
    0xfeedfacf,
    0xcffaedfe,
    0xcafebabe,
    0xbebafeca,
    0xcafebabf,
    0xbfbafeca,
  ]).has(buffer.readUInt32BE(0))
}

function architectureForCpuType(cpuType) {
  const architecture = CPU_ARCHITECTURES.get(cpuType >>> 0)
  if (!architecture) {
    throw new Error(`Unsupported Mach-O CPU type 0x${(cpuType >>> 0).toString(16)}`)
  }
  return architecture
}

export function parseMachOArchitectures(content) {
  const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content)
  if (buffer.length < 8) throw new Error('Native binary is too small to be Mach-O')
  const magic = buffer.readUInt32BE(0)

  if (magic === 0xfeedface || magic === 0xfeedfacf) {
    const minimumSize = magic === 0xfeedfacf ? 32 : 28
    if (buffer.length < minimumSize) throw new Error('Truncated Mach-O header')
    return [architectureForCpuType(buffer.readUInt32BE(4))]
  }
  if (magic === 0xcefaedfe || magic === 0xcffaedfe) {
    const minimumSize = magic === 0xcffaedfe ? 32 : 28
    if (buffer.length < minimumSize) throw new Error('Truncated Mach-O header')
    return [architectureForCpuType(buffer.readUInt32LE(4))]
  }

  const fatFormats = new Map([
    [0xcafebabe, { entrySize: 20, littleEndian: false, offsets64Bit: false }],
    [0xbebafeca, { entrySize: 20, littleEndian: true, offsets64Bit: false }],
    [0xcafebabf, { entrySize: 32, littleEndian: false, offsets64Bit: true }],
    [0xbfbafeca, { entrySize: 32, littleEndian: true, offsets64Bit: true }],
  ])
  const format = fatFormats.get(magic)
  if (!format) throw new Error('Native binary is not a supported Mach-O file')
  const readUInt32 = offset =>
    format.littleEndian ? buffer.readUInt32LE(offset) : buffer.readUInt32BE(offset)
  const architectureCount = readUInt32(4)
  if (architectureCount === 0 || architectureCount > 64) {
    throw new Error(`Invalid Mach-O architecture count: ${architectureCount}`)
  }
  const tableEnd = 8 + architectureCount * format.entrySize
  if (tableEnd > buffer.length) throw new Error('Truncated Mach-O architecture table')

  const architectures = []
  const sliceRanges = []
  for (let index = 0; index < architectureCount; index += 1) {
    const entryOffset = 8 + index * format.entrySize
    const cpuType = readUInt32(entryOffset)
    const readUInt64 = offset =>
      format.littleEndian ? buffer.readBigUInt64LE(offset) : buffer.readBigUInt64BE(offset)
    const sliceOffset = format.offsets64Bit
      ? Number(readUInt64(entryOffset + 8))
      : readUInt32(entryOffset + 8)
    const sliceSize = format.offsets64Bit
      ? Number(readUInt64(entryOffset + 16))
      : readUInt32(entryOffset + 12)
    if (!Number.isSafeInteger(sliceOffset) || !Number.isSafeInteger(sliceSize)) {
      throw new Error(`Mach-O architecture slice ${index} exceeds safe integer bounds`)
    }
    if (
      sliceSize === 0
      || sliceOffset < tableEnd
      || sliceOffset > buffer.length
      || sliceSize > buffer.length - sliceOffset
    ) {
      throw new Error(`Mach-O architecture slice ${index} is outside the file`)
    }
    const sliceEnd = sliceOffset + sliceSize
    if (sliceRanges.some(range => sliceOffset < range.end && sliceEnd > range.start)) {
      throw new Error(`Mach-O architecture slice ${index} overlaps another slice`)
    }
    sliceRanges.push({ end: sliceEnd, start: sliceOffset })
    const architecture = architectureForCpuType(cpuType)
    const slice = buffer.subarray(sliceOffset, sliceOffset + sliceSize)
    const sliceMagic = slice.readUInt32BE(0)
    if (![0xfeedface, 0xcefaedfe, 0xfeedfacf, 0xcffaedfe].includes(sliceMagic)) {
      throw new Error(`Mach-O architecture slice ${index} is not a thin Mach-O file`)
    }
    if (!parseMachOArchitectures(slice).includes(architecture)) {
      throw new Error(`Mach-O architecture slice ${index} does not match its CPU type`)
    }
    architectures.push(architecture)
  }
  return [...new Set(architectures)].sort(compareText)
}

function isBinaryContent(relativePath, content) {
  if (DEFINITELY_BINARY_EXTENSIONS.has(path.posix.extname(relativePath).toLowerCase())) return true
  if (content.subarray(0, 8_192).includes(0)) return true
  try {
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(content)
    return containsDisallowedControlCharacter(decoded)
  } catch {
    return true
  }
}

function matchingExclusion(relativeToInput, exclusions) {
  return exclusions.find(exclusion =>
    relativeToInput === exclusion || relativeToInput.startsWith(`${exclusion}/`),
  ) ?? null
}

async function walkConfiguredPath(rootDir, configuredPath, exclusions, matchedExclusions) {
  const absoluteStart = path.join(rootDir, ...configuredPath.split('/'))
  const results = []

  async function visit(absolutePath, pathFromInput) {
    const metadata = await lstat(absolutePath)
    if (metadata.isSymbolicLink()) {
      throw new Error(`Configured inventory path contains a symbolic link: ${configuredPath}`)
    }
    if (pathFromInput) {
      const exclusion = matchingExclusion(pathFromInput, exclusions)
      if (exclusion) {
        matchedExclusions.add(exclusion)
        return
      }
    }
    if (metadata.isDirectory()) {
      const children = await readdir(absolutePath)
      children.sort(compareText)
      for (const child of children) {
        const childRelative = pathFromInput ? `${pathFromInput}/${child}` : child
        await visit(path.join(absolutePath, child), childRelative)
      }
      return
    }
    if (!metadata.isFile()) {
      throw new Error(`Configured inventory path is not a regular file: ${configuredPath}`)
    }
    const content = await readFile(absolutePath)
    const repositoryPath = pathFromInput ? `${configuredPath}/${pathFromInput}` : configuredPath
    results.push({
      binary: isBinaryContent(repositoryPath, content),
      executable: (metadata.mode & fsConstants.S_IXUSR) !== 0,
      path: repositoryPath,
      sha256: sha256(content),
      size: content.length,
    })
  }

  await visit(absoluteStart, '')
  return results
}

function validateInputConfiguration(config) {
  if (config.schemaVersion !== 1) throw new Error('Unsupported inventory input schemaVersion')
  normalizeStringList(config.runtimeSeeds, 'runtimeSeeds')
  if (!Array.isArray(config.repositoryInputs)) {
    throw new Error('repositoryInputs must be an array')
  }
  const ids = new Set()
  for (const [index, input] of config.repositoryInputs.entries()) {
    if (!input || typeof input !== 'object') throw new Error(`repositoryInputs[${index}] is invalid`)
    if (
      typeof input.id !== 'string'
      || !/^[a-z0-9][a-z0-9-]*$/u.test(input.id)
      || ids.has(input.id)
    ) {
      throw new Error(`repositoryInputs[${index}] must have a unique non-empty id`)
    }
    ids.add(input.id)
    if (!ALLOWED_CLASSIFICATIONS.has(input.classification)) {
      throw new Error(`Unknown repository input classification for ${input.id}`)
    }
    if (!Array.isArray(input.paths) || input.paths.length === 0) {
      throw new Error(`Repository input ${input.id} must configure at least one path`)
    }
    input.paths.forEach((configuredPath, pathIndex) =>
      normalizeRelativePath(configuredPath, `${input.id}.paths[${pathIndex}]`),
    )
    normalizeStringList(input.exclude, `${input.id}.exclude`).forEach((excludedPath, pathIndex) =>
      normalizeRelativePath(excludedPath, `${input.id}.exclude[${pathIndex}]`),
    )
    if (input.optional !== undefined && typeof input.optional !== 'boolean') {
      throw new Error(`${input.id}.optional must be a boolean`)
    }
    if (input.atLeastOne !== undefined && typeof input.atLeastOne !== 'boolean') {
      throw new Error(`${input.id}.atLeastOne must be a boolean`)
    }
  }
}

async function collectRepositoryInputs(rootDir, config) {
  const records = []
  for (const input of [...config.repositoryInputs].sort((left, right) => compareText(left.id, right.id))) {
    const exclusions = normalizeStringList(input.exclude, `${input.id}.exclude`).map(value =>
      normalizeRelativePath(value, `${input.id}.exclude`),
    )
    const files = []
    const missingPaths = []
    const matchedExclusions = new Set()
    for (const configuredValue of input.paths) {
      const configuredPath = normalizeRelativePath(configuredValue, `${input.id}.path`)
      try {
        files.push(...await walkConfiguredPath(
          rootDir,
          configuredPath,
          exclusions,
          matchedExclusions,
        ))
      } catch (error) {
        if (error?.code === 'ENOENT' && input.optional === true) {
          missingPaths.push(configuredPath)
          continue
        }
        throw error
      }
    }
    if (input.atLeastOne === true && files.length === 0) {
      throw new Error(`Repository input ${input.id} requires at least one existing file`)
    }
    const unmatchedExclusion = exclusions.find(exclusion => !matchedExclusions.has(exclusion))
    if (unmatchedExclusion) {
      throw new Error(
        `Repository input ${input.id} exclusion did not match any path: ${unmatchedExclusion}`,
      )
    }
    if (input.classification !== 'binary') {
      const unexpectedBinary = files.find(file => file.binary)
      if (unexpectedBinary) {
        throw new Error(
          `Unclassified binary ${unexpectedBinary.path}; configure it as a binary input`,
        )
      }
    } else {
      const unexpectedText = files.find(file => !file.binary)
      if (unexpectedText) {
        throw new Error(
          `Binary input contains non-binary content ${unexpectedText.path}; classify it explicitly`,
        )
      }
    }
    files.sort((left, right) => compareText(left.path, right.path))
    records.push({
      atLeastOne: input.atLeastOne === true,
      classification: input.classification,
      configuredPaths: input.paths
        .map(value => normalizeRelativePath(value, `${input.id}.path`))
        .sort(compareText),
      excludedPaths: exclusions,
      files,
      id: input.id,
      missingPaths: missingPaths.sort(compareText),
      optional: input.optional === true,
    })
  }
  return records
}

function nativeRole(relativePath, executable, mainExecutable) {
  const extension = path.posix.extname(relativePath).toLowerCase()
  if (mainExecutable) return 'main-executable'
  if (extension === '.node') return 'node-addon'
  if (extension === '.dylib' || extension === '.so') return 'dynamic-library'
  if (extension === '.wasm') return 'wasm'
  if (extension === '.dll') return 'windows-library'
  if (extension === '.exe') return 'windows-executable'
  if (executable) return 'executable'
  return null
}

function nativeBinaryRecord(relativePath, content, executable, mainExecutable, source) {
  const role = nativeRole(relativePath, executable, mainExecutable)
  const machO = isMachOMagic(content)
  if (content.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) {
    throw new Error(`Unsupported ELF binary in macOS app inventory: ${relativePath}`)
  }
  if (content.subarray(0, 2).equals(Buffer.from([0x4d, 0x5a]))) {
    throw new Error(`Unsupported PE binary in macOS app inventory: ${relativePath}`)
  }
  if (!role && !machO) return null
  if (role === 'wasm') {
    const wasmHeader = Buffer.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0])
    if (content.length < wasmHeader.length || !content.subarray(0, wasmHeader.length).equals(wasmHeader)) {
      throw new Error(`Classified WebAssembly binary has an invalid header: ${relativePath}`)
    }
    return { architectures: [], path: relativePath, role, source }
  }
  if (!machO) {
    if (role === 'executable') return null
    throw new Error(`Classified native binary is not Mach-O: ${relativePath}`)
  }
  return {
    architectures: parseMachOArchitectures(content),
    path: relativePath,
    role: role ?? 'mach-o',
    source,
  }
}

async function readPinnedAppFile(absolutePath, relativePath, expectedMetadata, afterRead) {
  let fileHandle
  try {
    fileHandle = await open(absolutePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
  } catch (error) {
    throw new Error(`Unable to safely open app bundle file: ${relativePath}`, { cause: error })
  }
  try {
    const before = await fileHandle.stat({ bigint: true })
    if (!before.isFile()) throw new Error(`Unsupported app bundle entry: ${relativePath}`)
    assertStableAppEntry(fileSnapshot(expectedMetadata), fileSnapshot(before), relativePath)
    if (before.size > BigInt(bufferConstants.MAX_LENGTH)) {
      throw new Error(`App bundle file is too large to inventory safely: ${relativePath}`)
    }
    const size = Number(before.size)
    const content = Buffer.alloc(size)
    let offset = 0
    while (offset < size) {
      const { bytesRead } = await fileHandle.read(content, offset, size - offset, offset)
      if (bytesRead === 0) {
        throw new Error(`App bundle file changed during inventory: ${relativePath}`)
      }
      offset += bytesRead
    }
    const overflowProbe = Buffer.alloc(1)
    const overflow = await fileHandle.read(overflowProbe, 0, 1, size)
    if (overflow.bytesRead !== 0) {
      throw new Error(`App bundle file changed during inventory: ${relativePath}`)
    }
    const after = await fileHandle.stat({ bigint: true })
    assertStableAppEntry(fileSnapshot(before), fileSnapshot(after), relativePath)
    await afterRead?.({ absolutePath, relativePath })
    const pathMetadata = await lstat(absolutePath, { bigint: true })
    assertStableAppEntry(fileSnapshot(after), fileSnapshot(pathMetadata), relativePath)
    return { content, metadata: after, snapshot: fileSnapshot(after) }
  } finally {
    await fileHandle.close()
  }
}

function alignToUInt32(value) {
  return value + ((4 - (value % 4)) % 4)
}

function parseStrictJson(text, label) {
  let index = 0
  const numberPattern = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/uy

  function fail(message) {
    throw new Error(`Invalid JSON in ${label}: ${message} at UTF-16 code unit ${index}`)
  }

  function skipWhitespace() {
    while (index < text.length && /[\t\n\r ]/u.test(text[index])) index += 1
  }

  function parseString() {
    if (text[index] !== '"') fail('expected string')
    const start = index
    index += 1
    while (index < text.length) {
      const character = text[index]
      if (character === '"') {
        index += 1
        try {
          return JSON.parse(text.slice(start, index))
        } catch {
          fail('invalid string escape')
        }
      }
      if (character === '\\') {
        index += 1
        if (index >= text.length) fail('unterminated string escape')
        if (text[index] === 'u') {
          if (!/^[a-fA-F0-9]{4}$/u.test(text.slice(index + 1, index + 5))) {
            fail('invalid Unicode escape')
          }
          index += 4
        } else if (!'"\\/bfnrt'.includes(text[index])) {
          fail('invalid string escape')
        }
      } else if (character.charCodeAt(0) <= 0x1f) {
        fail('unescaped control character')
      }
      index += 1
    }
    fail('unterminated string')
  }

  function parseValue(depth) {
    if (depth > 512) fail('nesting is too deep')
    skipWhitespace()
    if (text[index] === '"') return parseString()
    if (text[index] === '{') return parseObject(depth + 1)
    if (text[index] === '[') return parseArray(depth + 1)
    for (const [literal, value] of [['true', true], ['false', false], ['null', null]]) {
      if (text.startsWith(literal, index)) {
        index += literal.length
        return value
      }
    }
    numberPattern.lastIndex = index
    const match = numberPattern.exec(text)
    if (!match) fail('expected value')
    index += match[0].length
    const value = Number(match[0])
    if (!Number.isFinite(value)) fail('number is outside finite bounds')
    return value
  }

  function parseObject(depth) {
    index += 1
    const result = Object.create(null)
    const keys = new Set()
    skipWhitespace()
    if (text[index] === '}') {
      index += 1
      return result
    }
    while (index < text.length) {
      skipWhitespace()
      const key = parseString()
      if (ASAR_PROTOTYPE_KEYS.has(key)) fail(`prototype key ${JSON.stringify(key)} is forbidden`)
      if (keys.has(key)) fail(`duplicate key ${JSON.stringify(key)}`)
      keys.add(key)
      skipWhitespace()
      if (text[index] !== ':') fail('expected colon')
      index += 1
      result[key] = parseValue(depth)
      skipWhitespace()
      if (text[index] === '}') {
        index += 1
        return result
      }
      if (text[index] !== ',') fail('expected comma')
      index += 1
    }
    fail('unterminated object')
  }

  function parseArray(depth) {
    index += 1
    const result = []
    skipWhitespace()
    if (text[index] === ']') {
      index += 1
      return result
    }
    while (index < text.length) {
      result.push(parseValue(depth))
      skipWhitespace()
      if (text[index] === ']') {
        index += 1
        return result
      }
      if (text[index] !== ',') fail('expected comma')
      index += 1
    }
    fail('unterminated array')
  }

  const result = parseValue(0)
  skipWhitespace()
  if (index !== text.length) fail('trailing content')
  return result
}

function parseAsarHeader(archiveContent, archiveRelativePath) {
  if (archiveContent.length < 8) throw new Error(`Malformed ASAR size pickle: ${archiveRelativePath}`)
  const sizePicklePayloadSize = archiveContent.readUInt32LE(0)
  if (sizePicklePayloadSize !== 4) {
    throw new Error(`Malformed ASAR size pickle: ${archiveRelativePath}`)
  }
  const headerSize = archiveContent.readUInt32LE(4)
  if (headerSize < 8 || headerSize % 4 !== 0 || headerSize > archiveContent.length - 8) {
    throw new Error(`Malformed ASAR header length: ${archiveRelativePath}`)
  }
  const headerPickle = archiveContent.subarray(8, 8 + headerSize)
  const headerPayloadSize = headerPickle.readUInt32LE(0)
  if (headerPayloadSize !== headerSize - 4 || headerPayloadSize % 4 !== 0) {
    throw new Error(`Malformed ASAR header pickle: ${archiveRelativePath}`)
  }
  const jsonLength = headerPickle.readInt32LE(4)
  if (jsonLength < 0 || headerPayloadSize !== 4 + alignToUInt32(jsonLength)) {
    throw new Error(`Malformed ASAR JSON length: ${archiveRelativePath}`)
  }
  const jsonStart = 8
  const jsonEnd = jsonStart + jsonLength
  const padding = headerPickle.subarray(jsonEnd)
  if (padding.some(byte => byte !== 0)) {
    throw new Error(`Malformed ASAR header padding: ${archiveRelativePath}`)
  }
  let json
  try {
    json = new TextDecoder('utf-8', { fatal: true }).decode(headerPickle.subarray(jsonStart, jsonEnd))
  } catch (error) {
    throw new Error(`Invalid UTF-8 in ASAR header: ${archiveRelativePath}`, { cause: error })
  }
  return {
    dataStart: 8 + headerSize,
    header: parseStrictJson(json, `ASAR header ${archiveRelativePath}`),
  }
}

function assertAsarObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
  return value
}

function assertAsarKeys(value, allowedKeys, label) {
  const unexpected = Object.keys(value).find(key => !allowedKeys.has(key))
  if (unexpected) throw new Error(`${label} contains unsupported key ${unexpected}`)
}

function validateAsarPathSegment(segment, label) {
  if (
    typeof segment !== 'string'
    || segment.length === 0
    || segment === '.'
    || segment === '..'
    || segment.includes('/')
    || segment.includes('\\')
    || [...segment].some(character => character.charCodeAt(0) <= 31 || character.charCodeAt(0) === 127)
  ) {
    throw new Error(`${label} is not a safe ASAR path segment`)
  }
}

function validateAsarLink(link, label) {
  if (typeof link !== 'string' || link === '.' || link.includes('\\')) {
    throw new Error(`${label} is not a safe ASAR link`)
  }
  const normalized = normalizeRelativePath(link, label)
  for (const segment of normalized.split('/')) validateAsarPathSegment(segment, label)
  return normalized
}

function validateAsarIntegrity(integrity, content, entryName) {
  if (integrity === undefined) return
  assertAsarObject(integrity, `ASAR integrity for ${entryName}`)
  assertAsarKeys(
    integrity,
    new Set(['algorithm', 'blockSize', 'blocks', 'hash']),
    `ASAR integrity for ${entryName}`,
  )
  if (
    integrity.algorithm !== 'SHA256'
    || !Number.isSafeInteger(integrity.blockSize)
    || integrity.blockSize <= 0
    || !Array.isArray(integrity.blocks)
    || typeof integrity.hash !== 'string'
    || !/^[a-f0-9]{64}$/u.test(integrity.hash)
    || integrity.blocks.some(hash => typeof hash !== 'string' || !/^[a-f0-9]{64}$/u.test(hash))
  ) {
    throw new Error(`Invalid ASAR integrity metadata: ${entryName}`)
  }
  const expectedBlocks = Math.floor(content.length / integrity.blockSize) + 1
  if (integrity.blocks.length !== expectedBlocks || sha256(content) !== integrity.hash) {
    throw new Error(`ASAR integrity metadata does not match content: ${entryName}`)
  }
  for (let index = 0; index < expectedBlocks; index += 1) {
    const block = content.subarray(index * integrity.blockSize, (index + 1) * integrity.blockSize)
    if (sha256(block) !== integrity.blocks[index]) {
      throw new Error(`ASAR integrity block does not match content: ${entryName}`)
    }
  }
}

function collectAsarEntries(archiveContent, archiveRelativePath, pinnedUnpackedFiles) {
  const { dataStart, header } = parseAsarHeader(archiveContent, archiveRelativePath)
  assertAsarObject(header, `ASAR header ${archiveRelativePath}`)
  assertAsarKeys(header, new Set(['files']), `ASAR header ${archiveRelativePath}`)
  const rootFiles = assertAsarObject(header.files, `ASAR files ${archiveRelativePath}`)
  const entries = []
  const nativeBinaries = []
  const packedRanges = []
  const paths = new Set()
  const linkTargets = new Map()

  function visit(files, parentPath) {
    for (const entrySegment of Object.keys(files).sort(compareText)) {
      validateAsarPathSegment(entrySegment, `ASAR entry in ${archiveRelativePath}`)
      const entryName = parentPath ? `${parentPath}/${entrySegment}` : entrySegment
      if (paths.has(entryName)) throw new Error(`Duplicate ASAR entry path: ${entryName}`)
      paths.add(entryName)
      const metadata = assertAsarObject(files[entrySegment], `ASAR metadata for ${entryName}`)
      const hasFiles = Object.hasOwn(metadata, 'files')
      const hasLink = Object.hasOwn(metadata, 'link')
      const hasSize = Object.hasOwn(metadata, 'size')
      if (Number(hasFiles) + Number(hasLink) + Number(hasSize) !== 1) {
        throw new Error(`ASAR entry has an invalid type: ${entryName}`)
      }
      if (hasFiles) {
        assertAsarKeys(metadata, new Set(['files', 'unpacked']), `ASAR directory ${entryName}`)
        if (metadata.unpacked !== undefined && metadata.unpacked !== true) {
          throw new Error(`Invalid ASAR unpacked directory metadata: ${entryName}`)
        }
        visit(assertAsarObject(metadata.files, `ASAR directory ${entryName}`), entryName)
        continue
      }

      const relativePath = `${archiveRelativePath}/${entryName}`
      if (hasLink) {
        assertAsarKeys(metadata, new Set(['link', 'unpacked']), `ASAR link ${entryName}`)
        if (metadata.unpacked !== undefined && metadata.unpacked !== true) {
          throw new Error(`Invalid ASAR unpacked link metadata: ${entryName}`)
        }
        const target = validateAsarLink(metadata.link, `ASAR link target for ${entryName}`)
        if (metadata.unpacked === true) {
          const unpackedPath = `${archiveRelativePath}.unpacked/${entryName}`
          const pinned = pinnedUnpackedFiles.get(unpackedPath)
          if (!pinned?.symbolicLink || pinned.target !== target) {
            throw new Error(`ASAR unpacked link does not match pinned app evidence: ${unpackedPath}`)
          }
        }
        linkTargets.set(entryName, target)
        entries.push({
          path: relativePath,
          symbolicLink: true,
          target,
        })
        continue
      }

      assertAsarKeys(
        metadata,
        new Set(['executable', 'integrity', 'offset', 'size', 'unpacked']),
        `ASAR file ${entryName}`,
      )
      if (!Number.isSafeInteger(metadata.size) || metadata.size < 0 || metadata.size > ASAR_UINT32_MAX) {
        throw new Error(`Invalid ASAR file size: ${entryName}`)
      }
      if (metadata.executable !== undefined && metadata.executable !== true) {
        throw new Error(`Invalid ASAR executable metadata: ${entryName}`)
      }
      const headerExecutable = metadata.executable === true
      let executable = headerExecutable
      let content
      if (metadata.unpacked === true) {
        if (Object.hasOwn(metadata, 'offset')) {
          throw new Error(`Unpacked ASAR file contains a packed offset: ${entryName}`)
        }
        const unpackedPath = `${archiveRelativePath}.unpacked/${entryName}`
        const pinned = pinnedUnpackedFiles.get(unpackedPath)
        if (!pinned) throw new Error(`ASAR unpacked file is missing from pinned app evidence: ${unpackedPath}`)
        if (
          pinned.symbolicLink
          || pinned.content.length !== metadata.size
          || (headerExecutable && !pinned.executable)
        ) {
          throw new Error(`ASAR unpacked metadata does not match pinned app evidence: ${unpackedPath}`)
        }
        content = pinned.content
        executable = pinned.executable
      } else {
        if (metadata.unpacked !== undefined) {
          throw new Error(`Invalid ASAR unpacked file metadata: ${entryName}`)
        }
        if (typeof metadata.offset !== 'string' || !/^(?:0|[1-9]\d*)$/u.test(metadata.offset)) {
          throw new Error(`Invalid ASAR file offset: ${entryName}`)
        }
        const offset = BigInt(metadata.offset)
        const start = BigInt(dataStart) + offset
        const end = start + BigInt(metadata.size)
        if (start > BigInt(archiveContent.length) || end > BigInt(archiveContent.length)) {
          throw new Error(`ASAR file range is outside the archive: ${entryName}`)
        }
        const numericStart = Number(start)
        const numericEnd = Number(end)
        if (metadata.size > 0) packedRanges.push({ end: numericEnd, path: entryName, start: numericStart })
        content = archiveContent.subarray(numericStart, numericEnd)
      }
      validateAsarIntegrity(metadata.integrity, content, entryName)
      entries.push({
        executable,
        path: relativePath,
        sha256: sha256(content),
        size: content.length,
        unpacked: metadata.unpacked === true,
      })
      const nativeBinary = nativeBinaryRecord(relativePath, content, executable, false, 'asar')
      if (nativeBinary) nativeBinaries.push(nativeBinary)
    }
  }

  visit(rootFiles, '')
  for (const [entryName, target] of linkTargets) {
    if (!paths.has(target)) throw new Error(`ASAR link target does not exist: ${entryName} -> ${target}`)
  }
  const linkStates = new Map()
  for (const entryName of linkTargets.keys()) {
    if (linkStates.get(entryName) === 'complete') continue
    const pending = []
    let current = entryName
    while (linkTargets.has(current)) {
      const state = linkStates.get(current)
      if (state === 'complete') break
      if (state === 'visiting') throw new Error(`ASAR link cycle detected at ${current}`)
      linkStates.set(current, 'visiting')
      pending.push(current)
      current = linkTargets.get(current)
    }
    while (pending.length > 0) linkStates.set(pending.pop(), 'complete')
  }
  packedRanges.sort((left, right) => left.start - right.start || left.end - right.end)
  for (let index = 1; index < packedRanges.length; index += 1) {
    if (packedRanges[index].start < packedRanges[index - 1].end) {
      throw new Error(
        `ASAR packed file ranges overlap: ${packedRanges[index - 1].path} and ${packedRanges[index].path}`,
      )
    }
  }
  return { entries, nativeBinaries }
}

function hashAppFilesystemRecords(records) {
  const manifest = {
    domain: APP_CONTENT_MANIFEST_DOMAIN,
    version: APP_CONTENT_MANIFEST_VERSION,
    records: [...records].sort((left, right) =>
      compareText(`${left.path}\0${left.type}`, `${right.path}\0${right.type}`),
    ),
  }
  return sha256(`${JSON.stringify(manifest)}\n`)
}

export async function collectAppInventory(appPath, options = {}) {
  const absoluteAppPath = path.resolve(appPath)
  const appName = path.basename(absoluteAppPath)
  if (!appName.endsWith('.app')) throw new Error('--app must point to a macOS .app bundle')
  const initialAppMetadata = await lstat(absoluteAppPath, { bigint: true })
  if (!initialAppMetadata.isDirectory()) throw new Error('--app must point to a directory')

  const files = []
  const resources = []
  const asarEntries = []
  const nativeBinaries = []
  const filesystemRecords = []
  const pathSnapshots = []
  const pendingAsars = []
  const pinnedUnpackedFiles = new Map()
  let mainExecutableCount = 0

  async function visit(absolutePath, relativePath, expectedMetadata) {
    const fileMetadata = await lstat(absolutePath, { bigint: true })
    if (expectedMetadata) {
      assertStableAppEntry(fileSnapshot(expectedMetadata), fileSnapshot(fileMetadata), relativePath)
    }
    if (fileMetadata.isSymbolicLink()) {
      const target = await readlink(absolutePath)
      if (path.isAbsolute(target)) {
        throw new Error(`App bundle contains an absolute symbolic link: ${relativePath}`)
      }
      const resolvedTarget = path.resolve(path.dirname(absolutePath), target)
      if (
        resolvedTarget !== absoluteAppPath
        && !resolvedTarget.startsWith(`${absoluteAppPath}${path.sep}`)
      ) {
        throw new Error(`App bundle symbolic link escapes the bundle: ${relativePath}`)
      }
      const after = await lstat(absolutePath, { bigint: true })
      assertStableAppEntry(fileSnapshot(fileMetadata), fileSnapshot(after), relativePath)
      const snapshot = fileSnapshot(after)
      const record = { path: relativePath, symbolicLink: true, target }
      files.push(record)
      if (relativePath.startsWith('Contents/Resources/')) resources.push(record)
      filesystemRecords.push({
        mode: Number(after.mode),
        path: relativePath,
        target,
        type: 'symbolic-link',
      })
      pathSnapshots.push({ absolutePath, relativePath, snapshot })
      const unpackedMatch = relativePath.match(/^(.*\.asar)\.unpacked\/(.+)$/u)
      if (unpackedMatch) {
        const unpackedRoot = path.join(
          absoluteAppPath,
          ...`${unpackedMatch[1]}.unpacked`.split('/'),
        )
        const archiveTarget = path.relative(unpackedRoot, resolvedTarget).split(path.sep).join('/')
        const normalizedTarget = validateAsarLink(
          archiveTarget,
          `Pinned ASAR unpacked link target for ${relativePath}`,
        )
        pinnedUnpackedFiles.set(relativePath, { symbolicLink: true, target: normalizedTarget })
      }
      return
    }
    if (fileMetadata.isDirectory()) {
      const children = await readdir(absolutePath)
      children.sort(compareText)
      const after = await lstat(absolutePath, { bigint: true })
      assertStableAppEntry(fileSnapshot(fileMetadata), fileSnapshot(after), relativePath)
      const snapshot = fileSnapshot(after)
      filesystemRecords.push({
        mode: Number(after.mode),
        path: relativePath || '.',
        type: 'directory',
      })
      pathSnapshots.push({ absolutePath, children, relativePath, snapshot })
      for (const child of children) {
        await visit(path.join(absolutePath, child), relativePath ? `${relativePath}/${child}` : child)
      }
      return
    }
    if (!fileMetadata.isFile()) throw new Error(`Unsupported app bundle entry: ${relativePath}`)
    const pinned = await readPinnedAppFile(
      absolutePath,
      relativePath,
      fileMetadata,
      options.afterPinnedFileRead,
    )
    const { content } = pinned
    const mode = Number(pinned.metadata.mode)
    const executable = (mode & fsConstants.S_IXUSR) !== 0
    const record = {
      executable,
      path: relativePath,
      sha256: sha256(content),
      size: content.length,
    }
    files.push(record)
    if (relativePath.startsWith('Contents/Resources/')) resources.push(record)
    filesystemRecords.push({
      executable,
      mode,
      path: relativePath,
      sha256: record.sha256,
      size: record.size,
      type: 'file',
    })
    pathSnapshots.push({ absolutePath, relativePath, snapshot: pinned.snapshot })

    const mainExecutable = /^Contents\/MacOS\/[^/]+$/.test(relativePath) && executable
    if (mainExecutable) mainExecutableCount += 1
    const nativeBinary = nativeBinaryRecord(
      relativePath,
      content,
      executable,
      mainExecutable,
      'filesystem',
    )
    if (nativeBinary) nativeBinaries.push(nativeBinary)

    if (relativePath.endsWith('.asar')) {
      pendingAsars.push({ content, relativePath })
    }
    if (/\.asar\.unpacked\//u.test(relativePath)) {
      pinnedUnpackedFiles.set(relativePath, { content, executable, symbolicLink: false })
    }
  }

  await visit(absoluteAppPath, '', initialAppMetadata)
  for (const archive of pendingAsars) {
    const asarInventory = await collectAsarEntries(
      archive.content,
      archive.relativePath,
      pinnedUnpackedFiles,
    )
    asarEntries.push(...asarInventory.entries)
    nativeBinaries.push(...asarInventory.nativeBinaries)
  }
  for (const entry of [...pathSnapshots].sort((left, right) =>
    compareText(left.relativePath, right.relativePath),
  )) {
    const current = await lstat(entry.absolutePath, { bigint: true })
    assertStableAppEntry(entry.snapshot, fileSnapshot(current), entry.relativePath)
    if (entry.children) {
      const currentChildren = await readdir(entry.absolutePath)
      currentChildren.sort(compareText)
      if (JSON.stringify(currentChildren) !== JSON.stringify(entry.children)) {
        throw new Error(`App bundle directory changed during inventory: ${entry.relativePath || '.'}`)
      }
      const afterChildren = await lstat(entry.absolutePath, { bigint: true })
      assertStableAppEntry(entry.snapshot, fileSnapshot(afterChildren), entry.relativePath)
    }
  }
  if (mainExecutableCount !== 1) {
    throw new Error(
      `App bundle must have exactly one executable in Contents/MacOS; found ${mainExecutableCount}`,
    )
  }
  const mainExecutable = nativeBinaries.find(binary => binary.role === 'main-executable')
  if (!mainExecutable) throw new Error('App bundle main executable was not inventoried as Mach-O')
  for (const binary of nativeBinaries) {
    if (binary === mainExecutable || binary.architectures.length === 0) continue
    const missingArchitectures = mainExecutable.architectures.filter(
      architecture => !binary.architectures.includes(architecture),
    )
    if (missingArchitectures.length > 0) {
      throw new Error(
        `Native binary ${binary.path} does not cover main executable architecture(s): ${missingArchitectures.join(', ')}`,
      )
    }
  }
  for (const collection of [files, resources, asarEntries, nativeBinaries]) {
    collection.sort((left, right) => compareText(left.path, right.path))
  }
  return {
    app: appName,
    architecturePolicy: {
      mainArchitectures: mainExecutable.architectures,
      rule: 'each-mach-o-native-covers-all-main-architectures',
    },
    asarEntries,
    contentSha256: hashAppFilesystemRecords(filesystemRecords),
    files,
    nativeBinaries,
    resources,
  }
}

export async function generateInventory(options = {}) {
  const rootDir = path.resolve(options.rootDir ?? process.cwd())
  const configPath = normalizeRelativePath(
    options.configPath ?? DEFAULT_CONFIG_PATH,
    'configPath',
  )
  const manifest = await readJson(path.join(rootDir, 'package.json'), 'package.json')
  const lock = await readJson(path.join(rootDir, 'package-lock.json'), 'package-lock.json')
  const config = await readJson(path.join(rootDir, ...configPath.split('/')), configPath)
  validateManifestLock(manifest, lock)
  validateInputConfiguration(config)

  const runtime = computeRuntimeClosure(manifest, lock.packages, config.runtimeSeeds)
  const inventory = {
    schemaVersion: 1,
    evidenceOnly: true,
    redistributionClearance: false,
    inputs: {
      config: await inputFileEvidence(rootDir, configPath),
      lockfileVersion: lock.lockfileVersion,
      manifest: await inputFileEvidence(rootDir, 'package.json'),
      packageLock: await inputFileEvidence(rootDir, 'package-lock.json'),
    },
    runtime,
    packages: await collectPackages(rootDir, manifest, lock.packages, runtime.packagePaths),
    repositoryInputs: await collectRepositoryInputs(rootDir, config),
  }
  if (options.appPath) {
    const appPath = path.isAbsolute(options.appPath)
      ? options.appPath
      : path.join(rootDir, options.appPath)
    inventory.app = await collectAppInventory(appPath)
  }
  if (JSON.stringify(inventory).includes(rootDir)) {
    throw new Error('Inventory output contains the absolute inventory root')
  }
  return inventory
}

export function renderInventoryJson(inventory) {
  return `${JSON.stringify(inventory, null, 2)}\n`
}

function markdownCell(value) {
  return String(value ?? '').replaceAll('|', '\\|').replaceAll('\n', ' ')
}

export function renderInventoryMarkdown(inventory) {
  const lines = [
    '# Third-Party Inventory Evidence',
    '',
    '> Evidence only: **yes**. Redistribution clearance: **no**.',
    '',
    'This deterministic report records local manifest, lockfile, repository, and optional app-bundle evidence. It makes no legal conclusion.',
    '',
    '## Inventory inputs',
    '',
    '| Input | Bytes | SHA-256 |',
    '|---|---:|---|',
    `| ${markdownCell(inventory.inputs.manifest.path)} | ${inventory.inputs.manifest.size} | ${inventory.inputs.manifest.sha256} |`,
    `| ${markdownCell(inventory.inputs.packageLock.path)} | ${inventory.inputs.packageLock.size} | ${inventory.inputs.packageLock.sha256} |`,
    `| ${markdownCell(inventory.inputs.config.path)} | ${inventory.inputs.config.size} | ${inventory.inputs.config.sha256} |`,
    '',
    '## Runtime dependency closure',
    '',
    `- Configured seeds: ${inventory.runtime.seeds.length}`,
    `- Resolved lock packages: ${inventory.runtime.packagePaths.length}`,
    '',
    '| Seed | Lock path |',
    '|---|---|',
    ...inventory.runtime.seeds.map(seed => `| ${markdownCell(seed.name)} | ${markdownCell(seed.path)} |`),
    '',
    '### Resolved dependency edges',
    '',
    '| From | Kind | Dependency | Resolved lock path |',
    '|---|---|---|---|',
    ...inventory.runtime.edges.map(edge =>
      `| ${markdownCell(edge.from)} | ${markdownCell(edge.kind)} | ${markdownCell(edge.dependency)} | ${markdownCell(edge.to ?? '<unresolved optional peer>')} |`,
    ),
    '',
    '## Lockfile packages',
    '',
    '| Package | Version | Lock path | Direct type | Dev | Dev optional | Optional | Runtime | OS | CPU | Integrity | License | Installed | Local license/notice evidence |',
    '|---|---|---|---|---:|---:|---:|---:|---|---|---|---|---:|---|',
    ...inventory.packages.map(packageRecord =>
      `| ${markdownCell(packageRecord.name)} | ${markdownCell(packageRecord.version)} | ${markdownCell(packageRecord.path)} | ${markdownCell(packageRecord.directType ?? '')} | ${packageRecord.dev ? 'yes' : 'no'} | ${packageRecord.devOptional ? 'yes' : 'no'} | ${packageRecord.optional ? 'yes' : 'no'} | ${packageRecord.runtimeDependency ? 'yes' : 'no'} | ${markdownCell(packageRecord.os.join(', '))} | ${markdownCell(packageRecord.cpu.join(', '))} | ${markdownCell(packageRecord.integrity ?? '')} | ${markdownCell(typeof packageRecord.license === 'string' ? packageRecord.license : JSON.stringify(stableObject(packageRecord.license)))} | ${packageRecord.installed ? 'yes' : 'no'} | ${markdownCell(packageRecord.licenseEvidence.map(evidence => `${evidence.path} sha256:${evidence.sha256} bytes:${evidence.size}`).join('; '))} |`,
    ),
    '',
    '## Configured repository inputs',
    '',
    '| Input | Classification | Configured paths | Excluded paths | Optional | At least one | Files | Missing optional paths |',
    '|---|---|---|---|---:|---:|---:|---:|',
    ...inventory.repositoryInputs.map(input =>
      `| ${markdownCell(input.id)} | ${markdownCell(input.classification)} | ${markdownCell(input.configuredPaths.join(', '))} | ${markdownCell(input.excludedPaths.join(', '))} | ${input.optional ? 'yes' : 'no'} | ${input.atLeastOne ? 'yes' : 'no'} | ${input.files.length} | ${input.missingPaths.length} |`,
    ),
  ]
  for (const input of inventory.repositoryInputs) {
    lines.push(
      '',
      `### ${markdownCell(input.id)} (${markdownCell(input.classification)})`,
      '',
      `Missing optional paths: ${markdownCell(input.missingPaths.join(', ') || 'none')}`,
      '',
      '| Path | Bytes | SHA-256 | Binary | Executable |',
      '|---|---:|---|---:|---:|',
      ...input.files.map(file =>
        `| ${markdownCell(file.path)} | ${file.size} | ${file.sha256} | ${file.binary ? 'yes' : 'no'} | ${file.executable ? 'yes' : 'no'} |`,
      ),
    )
  }
  if (inventory.app) {
    lines.push(
      '',
      '## App bundle evidence',
      '',
      `- Bundle: ${markdownCell(inventory.app.app)}`,
      `- Content SHA-256: ${inventory.app.contentSha256}`,
      `- Files: ${inventory.app.files.length}`,
      `- Resources: ${inventory.app.resources.length}`,
      `- ASAR entries: ${inventory.app.asarEntries.length}`,
      `- Native binaries: ${inventory.app.nativeBinaries.length}`,
      `- Main architectures: ${markdownCell(inventory.app.architecturePolicy.mainArchitectures.join(', '))}`,
      `- Architecture rule: ${markdownCell(inventory.app.architecturePolicy.rule)}`,
      '',
      '### Bundle files',
      '',
      '| Path | Bytes | SHA-256 | Executable | Symlink target |',
      '|---|---:|---|---:|---|',
      ...inventory.app.files.map(file =>
        `| ${markdownCell(file.path)} | ${markdownCell(file.size ?? '')} | ${markdownCell(file.sha256 ?? '')} | ${file.executable ? 'yes' : 'no'} | ${markdownCell(file.target ?? '')} |`,
      ),
      '',
      '### Resources',
      '',
      '| Path | Bytes | SHA-256 | Executable |',
      '|---|---:|---|---:|',
      ...inventory.app.resources.map(file =>
        `| ${markdownCell(file.path)} | ${markdownCell(file.size ?? '')} | ${markdownCell(file.sha256 ?? file.target ?? '')} | ${file.executable ? 'yes' : 'no'} |`,
      ),
      '',
      '### ASAR entries',
      '',
      '| Path | Bytes | SHA-256 | Executable | Unpacked | Symlink target |',
      '|---|---:|---|---:|---:|---|',
      ...inventory.app.asarEntries.map(file =>
        `| ${markdownCell(file.path)} | ${markdownCell(file.size ?? '')} | ${markdownCell(file.sha256 ?? '')} | ${file.executable ? 'yes' : 'no'} | ${file.unpacked ? 'yes' : 'no'} | ${markdownCell(file.target ?? '')} |`,
      ),
      '',
      '### Native binaries',
      '',
      '| Native path | Role | Architectures | Source |',
      '|---|---|---|---|',
      ...inventory.app.nativeBinaries.map(binary =>
        `| ${markdownCell(binary.path)} | ${markdownCell(binary.role)} | ${markdownCell(binary.architectures.join(', '))} | ${markdownCell(binary.source)} |`,
      ),
    )
  }
  return `${lines.join('\n')}\n`
}

function parseArguments(argv) {
  const options = { format: 'json' }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--app' || argument === '--config' || argument === '--format' || argument === '--root') {
      const value = argv[index + 1]
      if (!value) throw new Error(`${argument} requires a value`)
      index += 1
      if (argument === '--app') options.appPath = value
      if (argument === '--config') options.configPath = value
      if (argument === '--format') options.format = value
      if (argument === '--root') options.rootDir = value
      continue
    }
    throw new Error(`Unknown argument: ${argument}`)
  }
  if (!['json', 'markdown'].includes(options.format)) {
    throw new Error('--format must be json or markdown')
  }
  return options
}

async function main() {
  const options = parseArguments(process.argv.slice(2))
  const inventory = await generateInventory(options)
  process.stdout.write(
    options.format === 'markdown'
      ? renderInventoryMarkdown(inventory)
      : renderInventoryJson(inventory),
  )
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  main().catch(error => {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
  })
}
