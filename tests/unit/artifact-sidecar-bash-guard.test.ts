import { describe, expect, it, vi } from 'vitest'
import os from 'os'
import path from 'path'

vi.mock('../../src/main/sandbox-manager', () => ({ isSandboxed: () => true }))

import { classifyToolRisk } from '../../src/main/pi-security'

const sidecar = path.join(os.homedir(), '.openpipal', 'conversations', 'artifacts', 'conv-1')

describe('artifact sidecar bash 写入目标识别', () => {
  it.each([
    [`cp "${sidecar}/uploads/homework.png" /tmp/homework.png`],
    [`mkdir -p /tmp/review && cp "${sidecar}/uploads/homework.png" /tmp/review/homework.png`],
    [`cat "${sidecar}/draft.txt" > /tmp/draft.txt`],
    [`ls -la "${sidecar}"`]
  ])('允许只读 sidecar 来源：%s', (command) => {
    const result = classifyToolRisk('bash', { command })
    expect(result.level).not.toBe('risky')
    expect(result.reason).not.toContain('artifact 内容必须走')
  })

  it.each([
    [`cp /tmp/homework.png "${sidecar}/homework.png"`],
    [`mkdir -p "${sidecar}/nested"`],
    [`cat /tmp/draft.txt > "${sidecar}/draft.txt"`],
    [`cat /tmp/draft.txt | tee "${sidecar}/draft.txt"`],
    [`sed -i '' 's/old/new/' "${sidecar}/draft.txt"`],
    [`rm "${sidecar}/draft.txt"`]
  ])('继续阻止写入 sidecar：%s', (command) => {
    const result = classifyToolRisk('bash', { command })
    expect(result.level).toBe('risky')
    expect(result.reason).toContain('artifact 内容必须走')
  })
})
