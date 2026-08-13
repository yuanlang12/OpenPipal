/**
 * update_todos 工具（W5 工作流轻件）三处登记 + todos artifact ephemeral 回归锁。
 * update_todos 定义在 pi-tools.ts（execute 依赖 electron，node 环境不可直接 import），
 * 这里锁住它可被单测覆盖的三个契约面：
 *   ① 安全分类 safe（pi-security）——否则 IPC 会走 needs_confirmation 卡确认
 *   ② COMMON_TOOLS 白名单（role-manager）——否则 isToolAllowed 过滤掉，AI 收不到工具 schema
 *   ③ type='todos' 是 ephemeral 过程物（EPHEMERAL_ARTIFACT_TYPES）：saveArtifact 不落盘，
 *      返回不含真实路径的 ref——不进历史产物列表/不进模型 session-artifacts 清单/不参与去重
 */
import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'

// os.homedir() 在 POSIX 优先读 HOME——模块导入前劫持，让 ARTIFACTS_ROOT 落到临时目录
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'openpipal-todos-'))
process.env.HOME = TMP

const { saveArtifact, loadArtifact, EPHEMERAL_ARTIFACT_TYPES } = await import('../../src/main/artifact-store')
const { classifyToolRisk } = await import('../../src/main/pi-security')
const { COMMON_TOOLS } = await import('../../src/main/role-manager')

// 与 pi-tools.createUpdateTodosTool.execute 的 details.artifact 完全同构
function todosArtifact(convId: string, todos: { content: string; status: string }[]) {
  return {
    id: `todos-${convId}`,
    type: 'todos',
    title: '任务清单',
    content: JSON.stringify({ todos })
  }
}

describe('update_todos 三处登记', () => {
  it('① classifyToolRisk(update_todos) → safe（不弹确认、不卡 IPC）', () => {
    expect(classifyToolRisk('update_todos', {}).level).toBe('safe')
  })

  it('② update_todos 在 COMMON_TOOLS 白名单里（全角色可见）', () => {
    expect(COMMON_TOOLS).toContain('update_todos')
  })
})

describe('todos artifact ephemeral（type=todos → 不落盘）', () => {
  const CONV = 'conv-todos'

  it('type=todos 在 EPHEMERAL_ARTIFACT_TYPES 里', () => {
    expect(EPHEMERAL_ARTIFACT_TYPES.has('todos')).toBe(true)
  })

  it('③a saveArtifact(todos) 不落盘：ref.path 为空，磁盘无文件产生', () => {
    const todos = [
      { content: '收集需求', status: 'completed' },
      { content: '出方案', status: 'in_progress' },
      { content: '交付', status: 'pending' }
    ]
    const ref = saveArtifact(CONV, todosArtifact(CONV, todos))
    expect(ref.path).toBe('')
    expect(ref.type).toBe('todos')
    const dir = path.join(TMP, '.openpipal', 'conversations', 'artifacts', CONV)
    expect(fs.existsSync(dir)).toBe(false) // 目录都不该被创建
    // 空 path 时 loadArtifact 优雅返回 null（不抛、不静默造错误卡片）
    expect(loadArtifact(ref)).toBeNull()
  })

  it('③b 反复保存同 id 始终不落盘（幂等 no-op，不会有一次写一次不写的不一致）', () => {
    saveArtifact(CONV, todosArtifact(CONV, [{ content: 'a', status: 'pending' }]))
    const second = saveArtifact(CONV, todosArtifact(CONV, [
      { content: 'a', status: 'completed' },
      { content: 'b', status: 'in_progress' }
    ]))
    expect(second.path).toBe('')
    const dir = path.join(TMP, '.openpipal', 'conversations', 'artifacts', CONV)
    expect(fs.existsSync(dir)).toBe(false)
  })
})
