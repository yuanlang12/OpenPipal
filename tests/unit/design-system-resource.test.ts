import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  buildDesignSystemPreviewContentSecurityPolicy,
  getDesignSystemResourceCapability,
  parseDesignSystemStaticCapabilityPath,
  readDesignSystemResource,
  readDesignSystemStaticResource,
} from '../../src/main/design-system-resource'
import { isPublicRendererPath } from '../../src/main/local-http-auth'

describe('design system resource boundary', () => {
  let tempDir: string
  let rootDir: string
  let systemDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'openpipal-ds-resource-'))
    rootDir = join(tempDir, 'design-systems')
    systemDir = join(rootDir, 'demo')
    mkdirSync(systemDir, { recursive: true })
    writeFileSync(join(systemDir, 'README.md'), '# Demo\n')
    writeFileSync(join(systemDir, 'preview.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    writeFileSync(join(systemDir, 'icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>')
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('returns preview text and images without exposing an absolute path', () => {
    const text = readDesignSystemResource('demo', 'README.md', { rootDir })
    expect(text).toMatchObject({
      ok: true,
      kind: 'text',
      data: '# Demo\n',
      contentType: 'text/markdown; charset=utf-8',
    })
    expect(text).not.toHaveProperty('path')

    const image = readDesignSystemResource('demo', 'preview.png', { rootDir })
    expect(image).toMatchObject({ ok: true, kind: 'data-url', contentType: 'image/png' })
    expect(image.ok && image.data).toMatch(/^data:image\/png;base64,/)

    const svg = readDesignSystemResource('demo', 'icon.svg', { rootDir })
    expect(svg).toMatchObject({ ok: true, kind: 'data-url', contentType: 'image/svg+xml' })
    expect(svg.ok && svg.data).toMatch(/^data:image\/svg\+xml;base64,/)

    const staticResource = readDesignSystemStaticResource('demo', 'README.md', { rootDir })
    expect(staticResource.ok && staticResource.data.toString('utf8')).toBe('# Demo\n')
  })

  it('rejects invalid names, traversal, and directories', () => {
    mkdirSync(join(systemDir, 'nested'))
    writeFileSync(join(rootDir, 'outside.txt'), 'secret')

    expect(readDesignSystemResource('../demo', 'README.md', { rootDir })).toMatchObject({ ok: false, code: 'invalid-name' })
    expect(readDesignSystemResource('demo/child', 'README.md', { rootDir })).toMatchObject({ ok: false, code: 'invalid-name' })
    expect(readDesignSystemResource('demo', '../outside.txt', { rootDir })).toMatchObject({ ok: false, code: 'forbidden' })
    expect(readDesignSystemResource('demo', 'nested', { rootDir })).toMatchObject({ ok: false, code: 'not-file' })
  })

  it('rejects a resource symlink and a design-system symlink that escape the canonical root', () => {
    const outsideDir = join(tempDir, 'outside')
    mkdirSync(outsideDir)
    writeFileSync(join(outsideDir, 'secret.md'), 'secret')
    symlinkSync(join(outsideDir, 'secret.md'), join(systemDir, 'leak.md'))
    symlinkSync(outsideDir, join(rootDir, 'linked-system'))

    expect(readDesignSystemResource('demo', 'leak.md', { rootDir })).toMatchObject({ ok: false, code: 'forbidden' })
    expect(readDesignSystemStaticResource('demo', 'leak.md', { rootDir })).toMatchObject({ ok: false, code: 'forbidden' })
    expect(readDesignSystemResource('linked-system', 'secret.md', { rootDir })).toMatchObject({ ok: false, code: 'forbidden' })
  })

  it('enforces the cap before returning API or static data', () => {
    writeFileSync(join(systemDir, 'large.txt'), '12345')

    expect(readDesignSystemResource('demo', 'large.txt', { rootDir, maxBytes: 4 })).toMatchObject({ ok: false, code: 'too-large' })
    expect(readDesignSystemStaticResource('demo', 'large.txt', { rootDir, maxBytes: 4 })).toMatchObject({ ok: false, code: 'too-large' })
  })

  it('requires the process capability before exposing an iframe resource path', () => {
    const capability = getDesignSystemResourceCapability('demo', { rootDir })
    expect(capability).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(parseDesignSystemStaticCapabilityPath(`/design-systems/${capability}/demo/preview%20card/index.html`))
      .toEqual({ capability, name: 'demo', rel: 'preview card/index.html' })
    expect(isPublicRendererPath('GET', `/design-systems/${capability}/demo/index.html`)).toBe(true)
    expect(parseDesignSystemStaticCapabilityPath(`/design-systems/${capability}/other/index.html`)).toBeNull()
    expect(parseDesignSystemStaticCapabilityPath('/design-systems/demo/preview/index.html')).toBeNull()
    expect(parseDesignSystemStaticCapabilityPath(`/design-systems/${'x'.repeat(43)}/demo/index.html`)).toBeNull()
  })

  it('confines an interactive preview to its exact capability resource path', () => {
    const capability = getDesignSystemResourceCapability('demo', { rootDir })!
    const policy = buildDesignSystemPreviewContentSecurityPolicy(
      'http://127.0.0.1:3031',
      capability,
      'demo',
    )

    expect(policy).toContain(`script-src 'unsafe-inline' http://127.0.0.1:3031/design-systems/${capability}/demo/`)
    expect(policy).toContain("connect-src 'none'")
    expect(policy).toContain("form-action 'none'")
    expect(policy).toContain("frame-src 'none'")
    expect(policy).toContain('sandbox allow-scripts')
    expect(policy).not.toContain('https:')
    expect(buildDesignSystemPreviewContentSecurityPolicy('https://evil.example', capability, 'demo')).toBeNull()
    expect(buildDesignSystemPreviewContentSecurityPolicy('http://127.0.0.1:3031', capability, 'other')).toBeNull()
  })
})
