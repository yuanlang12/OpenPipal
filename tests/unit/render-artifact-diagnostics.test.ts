import { describe, expect, it } from 'vitest'
import { isRenderArtifactConsoleNoise } from '../../src/main/render-artifact-diagnostics'

describe('render_artifact console diagnostics', () => {
  it('ignores Electron hidden-preview CSP advisories with and without the console style prefix', () => {
    const body = 'Electron Security Warning (Insecure Content-Security-Policy) This warning will not show up once the app is packaged.'
    expect(isRenderArtifactConsoleNoise(`%c${body} font-weight: bold`, false)).toBe(true)
    expect(isRenderArtifactConsoleNoise(body, false)).toBe(true)
  })

  it('does not hide real page CSP violations or JavaScript failures', () => {
    expect(isRenderArtifactConsoleNoise(
      "Refused to execute inline script because it violates the following Content Security Policy directive",
      false
    )).toBe(false)
    expect(isRenderArtifactConsoleNoise('TypeError: renderCard is not a function', false)).toBe(false)
  })

  it('keeps the existing DC-only preparsing exception scoped to DC artifacts', () => {
    expect(isRenderArtifactConsoleNoise('Expected length, got auto', true)).toBe(true)
    expect(isRenderArtifactConsoleNoise('Expected length, got auto', false)).toBe(false)
  })
})
