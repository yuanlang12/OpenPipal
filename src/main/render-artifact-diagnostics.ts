/**
 * Console diagnostics emitted while render_artifact runs inside OpenPipal's
 * hidden Electron window.
 *
 * Keep host/runtime noise separate from warnings produced by the artifact
 * itself. In particular, Electron prints its own CSP advisory for the hidden
 * data/file preview in development builds. It explicitly says the advisory is
 * absent from packaged builds, so reporting it as a page defect makes a clean
 * artifact fail self-check and tempts the Agent to claim a fix it never made.
 */

const COMMON_HEADLESS_NOISE_RE = /favicon|Slow network|preload/i
const DC_PREPARSE_NOISE_RE = /Expected (length|number|moveto)/i
const ELECTRON_PREVIEW_CSP_ADVISORY_RE = /^\s*(?:%c)?Electron Security Warning \(Insecure Content-Security-Policy\)/i

export function isRenderArtifactConsoleNoise(message: string, isDc: boolean): boolean {
  const normalized = String(message || '')
  if (COMMON_HEADLESS_NOISE_RE.test(normalized)) return true
  if (ELECTRON_PREVIEW_CSP_ADVISORY_RE.test(normalized)) return true
  return isDc && DC_PREPARSE_NOISE_RE.test(normalized)
}
