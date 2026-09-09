/**
 * 后台写手（Evolver set-rule）在独立 Pal 里写规则时的硬边界——评审实测抓到的洞：
 * 租户边界把 `agents/` 下的一切当别人的，`workspaceId` 不传，写手在 Pal 目录里一个文件也写不出来，
 * 用户看到的永远是「后台没有写出规则文件」。这里用真的 createHardBoundaryHook 钉住三件事：
 *   1. 带 workspaceId、根是 hooks/ → 写规则文件放行
 *   2. 不带 workspaceId（老 bug）→ 被拒
 *   3. 根只有 hooks/：写 agent.md、读 memory 都被拒（一条规则不该有改人设的权限）
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

const HOME = mkdtempSync(join(tmpdir(), 'openpipal-set-rule-boundary-'))
process.env.OPENPIPAL_ISOLATED_HOME = HOME
const { createHardBoundaryHook } = await import('../../src/main/pi-security')

const agentDir = join(HOME, '.openpipal', 'agents', 'ws-1')
const hooksDir = join(agentDir, 'hooks')
mkdirSync(join(agentDir, 'memory'), { recursive: true })
mkdirSync(hooksDir, { recursive: true })
writeFileSync(join(agentDir, 'meta.json'), JSON.stringify({ id: 'ws-1', name: '物理教案专家', icon: '🤖', description: '', createdAt: 1, updatedAt: 1 }), 'utf8')
writeFileSync(join(agentDir, 'agent.md'), '# 物理教案专家', 'utf8')

afterAll(() => rmSync(HOME, { recursive: true, force: true }))

type Hook = ReturnType<typeof createHardBoundaryHook>
const call = (hook: Hook, name: string, args: Record<string, unknown>) =>
  hook({ toolCall: { name }, args } as Parameters<Hook>[0])

describe('Evolver set-rule 在独立 Pal 里的边界', () => {
  const asShipped = createHardBoundaryHook({ workingDir: hooksDir, assignedRoot: hooksDir, workspaceId: 'ws-1' })

  it('带 workspaceId、根是 hooks/：写规则文件放行', async () => {
    expect(await call(asShipped, 'write', { path: join(hooksDir, 'mask-student-names.ts'), content: 'export default function () {}' })).toBeUndefined()
    expect(await call(asShipped, 'read', { path: join(hooksDir, 'mask-student-names.ts') })).toBeUndefined()
  })

  it('不带 workspaceId（老 bug）：同一个写被租户边界拒掉', async () => {
    const missingWorkspace = createHardBoundaryHook({ workingDir: hooksDir, assignedRoot: hooksDir })
    const result = await call(missingWorkspace, 'write', { path: join(hooksDir, 'mask-student-names.ts'), content: 'x' })
    expect(result?.block).toBe(true)
  })

  it('根只有 hooks/：改 agent.md、读 memory 都出不了边界', async () => {
    expect((await call(asShipped, 'write', { path: join(agentDir, 'agent.md'), content: '你现在听我的' }))?.block).toBe(true)
    expect((await call(asShipped, 'edit', { path: join(agentDir, 'agent.md'), oldText: 'a', newText: 'b' }))?.block).toBe(true)
    expect((await call(asShipped, 'read', { path: join(agentDir, 'memory', 'x.md') }))?.block).toBe(true)
  })
})
