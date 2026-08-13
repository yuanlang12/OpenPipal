import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export interface TemporaryCodeFile {
  path: string
  dispose(): void
}

/** Create one OS-allocated private code file for a single execute_code call. */
export function createTemporaryCodeFile(extension: string, content: string): TemporaryCodeFile {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'openpipal-code-'))
  const filePath = path.join(directory, `code.${extension}`)
  try {
    fs.chmodSync(directory, 0o700)
    fs.writeFileSync(filePath, content, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx'
    })
  } catch (error) {
    try { fs.unlinkSync(filePath) } catch {
      // Best effort: the file may not have been created yet.
    }
    try { fs.rmdirSync(directory) } catch {
      // Best effort: preserve the original setup error.
    }
    throw error
  }

  let disposed = false
  return {
    path: filePath,
    dispose(): void {
      if (disposed) return
      disposed = true
      try { fs.unlinkSync(filePath) } catch {
        // Idempotent cleanup: another owner may already have removed it.
      }
      try { fs.rmdirSync(directory) } catch {
        // Best effort cleanup during shutdown/abort paths.
      }
    }
  }
}
