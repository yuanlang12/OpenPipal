import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { copyPhotonWasm } from '../../scripts/copy-photon-wasm.mjs'

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { force: true, recursive: true })))
})

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'openpipal-photon-wasm-'))
  temporaryRoots.push(root)
  await mkdir(path.join(root, 'out', 'main'), { recursive: true })
  return root
}

async function writeSource(root: string, relativePath: string, bytes: Buffer) {
  const file = path.join(root, ...relativePath.split('/'))
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, bytes)
}

describe('copyPhotonWasm', () => {
  it('copies the nested Pi dependency beside the bundled main-process chunk', async () => {
    const root = await fixture()
    const source = Buffer.from('valid-photon-wasm-fixture')
    await writeSource(
      root,
      'node_modules/@earendil-works/pi-coding-agent/node_modules/@silvia-odwyer/photon-node/photon_rs_bg.wasm',
      source,
    )

    const result = await copyPhotonWasm(root)

    await expect(readFile(result.output)).resolves.toEqual(source)
    expect(result.output).toBe(path.join(root, 'out', 'main', 'photon_rs_bg.wasm'))
    expect(result.size).toBe(source.length)
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/u)
  })

  it('accepts hoisted and nested copies only when their bytes agree', async () => {
    const root = await fixture()
    await writeSource(
      root,
      'node_modules/@silvia-odwyer/photon-node/photon_rs_bg.wasm',
      Buffer.from('hoisted'),
    )
    await writeSource(
      root,
      'node_modules/@earendil-works/pi-coding-agent/node_modules/@silvia-odwyer/photon-node/photon_rs_bg.wasm',
      Buffer.from('nested'),
    )

    await expect(copyPhotonWasm(root)).rejects.toThrow('PHOTON_WASM_SOURCES_DIVERGE')
  })

  it('fails the build instead of silently shipping without the runtime resource', async () => {
    const root = await fixture()
    await expect(copyPhotonWasm(root)).rejects.toThrow('PHOTON_WASM_SOURCE_MISSING')
  })
})
