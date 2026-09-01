#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { copyFile, lstat, readFile, chmod } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const SCRIPT_PATH = fileURLToPath(import.meta.url)
const SOURCE_CANDIDATES = [
  'node_modules/@silvia-odwyer/photon-node/photon_rs_bg.wasm',
  'node_modules/@earendil-works/pi-coding-agent/node_modules/@silvia-odwyer/photon-node/photon_rs_bg.wasm',
]
const OUTPUT_PATH = 'out/main/photon_rs_bg.wasm'

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

async function metadataOrNull(file) {
  try {
    return await lstat(file)
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

/**
 * Keep Photon's data file beside the bundled main-process chunk that loads it.
 *
 * `Contents/MacOS` is a code-only directory on macOS. Putting this WASM data
 * file there works in an unsigned dev package but makes a real signature fail.
 * Copying it into `out/main` lets electron-builder seal it as an ordinary ASAR
 * resource while preserving the module's normal `__dirname` lookup.
 */
export async function copyPhotonWasm(projectDir = process.cwd()) {
  if (!path.isAbsolute(projectDir)) throw new Error('PHOTON_WASM_PROJECT_DIR_NOT_ABSOLUTE')

  const outputDirectory = path.join(projectDir, 'out', 'main')
  const outputDirectoryMetadata = await metadataOrNull(outputDirectory)
  if (
    !outputDirectoryMetadata
    || outputDirectoryMetadata.isSymbolicLink()
    || !outputDirectoryMetadata.isDirectory()
  ) {
    throw new Error('PHOTON_WASM_OUTPUT_DIRECTORY_INVALID')
  }

  const sources = []
  for (const relativePath of SOURCE_CANDIDATES) {
    const absolutePath = path.join(projectDir, ...relativePath.split('/'))
    const metadata = await metadataOrNull(absolutePath)
    if (!metadata) continue
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new Error('PHOTON_WASM_SOURCE_INVALID')
    }
    const bytes = await readFile(absolutePath)
    if (bytes.length === 0) throw new Error('PHOTON_WASM_SOURCE_EMPTY')
    sources.push({ absolutePath, bytes, sha256: digest(bytes) })
  }
  if (sources.length === 0) throw new Error('PHOTON_WASM_SOURCE_MISSING')
  if (new Set(sources.map(source => source.sha256)).size !== 1) {
    throw new Error('PHOTON_WASM_SOURCES_DIVERGE')
  }

  const output = path.join(projectDir, ...OUTPUT_PATH.split('/'))
  const existingOutput = await metadataOrNull(output)
  if (existingOutput && (existingOutput.isSymbolicLink() || !existingOutput.isFile())) {
    throw new Error('PHOTON_WASM_OUTPUT_INVALID')
  }

  await copyFile(sources[0].absolutePath, output)
  await chmod(output, 0o644)
  const copied = await readFile(output)
  const sha256 = digest(copied)
  if (copied.length !== sources[0].bytes.length || sha256 !== sources[0].sha256) {
    throw new Error('PHOTON_WASM_COPY_MISMATCH')
  }

  return { output, sha256, size: copied.length }
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  const result = await copyPhotonWasm(path.resolve(process.cwd()))
  process.stdout.write(`[photon-wasm] copied ${result.size} bytes (${result.sha256.slice(0, 12)})\n`)
}
