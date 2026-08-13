/**
 * 会话级权限审批（"本次会话允许此类操作"）状态锁。
 *
 * 历史 bug（2026-07-29 修）：ipc-handlers 只把 requestId→工具名 记进表，resolve 时调
 * approveToolForSession(toolName) 漏了 conversationId，而该函数无 cid 直接 return——
 * 于是非浏览器工具的"本次会话允许"从来没生效过，用户每一步都得重新点允许。
 * 这里锁住修复后的语义：按会话记、跨会话不串、按会话清不误伤并发会话。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  approveToolForSession,
  authorizeToolCall,
  isToolApprovedForSession,
  clearSessionApprovals,
  localSessionApprovalScope,
  type PermissionRequest
} from '../../src/main/pi-security'

const A = 'conv-A'
const B = 'conv-B'
const EXEC_A = { language: 'python', code: 'print(1)' }
const EXEC_B = { language: 'python', code: 'print(2)' }

describe('会话级审批', () => {
  beforeEach(() => clearSessionApprovals())

  it('授权后同会话同工具直接放行', () => {
    expect(isToolApprovedForSession('execute_code', A, EXEC_A)).toBe(false)
    approveToolForSession('execute_code', A, EXEC_A)
    expect(isToolApprovedForSession('execute_code', A, EXEC_A)).toBe(true)
  })

  it('只放行被授权的那个工具，别的照样要问', () => {
    approveToolForSession('execute_code', A, EXEC_A)
    expect(isToolApprovedForSession('bash', A)).toBe(false)
  })

  it('跨会话不串：A 的授权不影响 B', () => {
    approveToolForSession('execute_code', A, EXEC_A)
    expect(isToolApprovedForSession('execute_code', B, EXEC_A)).toBe(false)
  })

  it('缺 conversationId → 授权不记、判定不命中（不再静默假装成功）', () => {
    approveToolForSession('execute_code', undefined, EXEC_A)
    expect(isToolApprovedForSession('execute_code', undefined, EXEC_A)).toBe(false)
    expect(isToolApprovedForSession('execute_code', A, EXEC_A)).toBe(false)
  })

  it('按会话清：只清目标会话，并发中的另一个会话不受影响', () => {
    approveToolForSession('execute_code', A, EXEC_A)
    approveToolForSession('execute_code', B, EXEC_A)
    clearSessionApprovals(A)
    expect(isToolApprovedForSession('execute_code', A, EXEC_A)).toBe(false)
    expect(isToolApprovedForSession('execute_code', B, EXEC_A)).toBe(true)
  })

  it('不传 cid 的清空仍是全清（退出/重置场景保留）', () => {
    approveToolForSession('execute_code', A, EXEC_A)
    approveToolForSession('bash', B, { command: 'pwd' })
    clearSessionApprovals()
    expect(isToolApprovedForSession('execute_code', A, EXEC_A)).toBe(false)
    expect(isToolApprovedForSession('bash', B, { command: 'pwd' })).toBe(false)
  })

  it('shell/code 授权绑定完整参数，改代码或命令不能继承', () => {
    approveToolForSession('execute_code', A, EXEC_A)
    expect(isToolApprovedForSession('execute_code', A, EXEC_B)).toBe(false)

    approveToolForSession('bash', A, { command: 'cat /tmp/public.txt' })
    expect(isToolApprovedForSession('bash', A, { command: 'cat ~/.openpipal/config.json' })).toBe(false)
  })

  it('参数键顺序不影响同一次操作的授权命中', () => {
    approveToolForSession('execute_code', A, { language: 'python', code: 'print(1)' })
    expect(isToolApprovedForSession('execute_code', A, { code: 'print(1)', language: 'python' })).toBe(true)
  })

  it('shell/code 缺少原始参数时拒绝创建宽泛授权', () => {
    approveToolForSession('execute_code', A)
    expect(isToolApprovedForSession('execute_code', A, EXEC_A)).toBe(false)
  })

  it('非执行类工具仍保留按工具的会话授权', () => {
    approveToolForSession('remote_calendar_create', A, { title: 'first' })
    expect(isToolApprovedForSession('remote_calendar_create', A, { title: 'second' })).toBe(true)
  })

  it('MCP 授权按 server、工具和参数隔离', () => {
    const serverA = { namespace: 'mcp:server-a', argumentScoped: true }
    const serverB = { namespace: 'mcp:server-b', argumentScoped: true }
    approveToolForSession('create_record', A, { title: 'first' }, serverA)
    expect(isToolApprovedForSession('create_record', A, { title: 'first' }, serverA)).toBe(true)
    expect(isToolApprovedForSession('create_record', A, { title: 'second' }, serverA)).toBe(false)
    expect(isToolApprovedForSession('create_record', A, { title: 'first' }, serverB)).toBe(false)
  })

  it('本地授权绑定规范化工作目录，切换 cwd 后不复用', () => {
    const firstCwd = localSessionApprovalScope('/tmp/openpipal-project-a/../openpipal-project-a')
    const sameCwd = localSessionApprovalScope('/tmp/openpipal-project-a')
    const otherCwd = localSessionApprovalScope('/tmp/openpipal-project-b')
    const args = { command: 'npm test' }

    expect(firstCwd).toEqual(sameCwd)
    approveToolForSession('bash', A, args, firstCwd)
    expect(isToolApprovedForSession('bash', A, args, sameCwd)).toBe(true)
    expect(isToolApprovedForSession('bash', A, args, otherCwd)).toBe(false)
  })

  it('真实授权链路把 cwd 身份带进批准记录，同参数换目录后重新询问', async () => {
    const args = { id: 'record-1' }
    const firstCwd = '/tmp/openpipal-project-a/../openpipal-project-a'
    const sameCwd = '/tmp/openpipal-project-a'
    const otherCwd = '/tmp/openpipal-project-b'
    const approveFirst = vi.fn(async (request: PermissionRequest) => {
      approveToolForSession(request.tool, request.conversationId, request.args, request.approvalScope)
      return true
    })

    await expect(authorizeToolCall('delete_remote_record', args, {
      conversationId: A,
      onConfirmation: approveFirst,
      scope: { workingDir: firstCwd }
    })).resolves.toBeUndefined()
    expect(approveFirst).toHaveBeenCalledTimes(1)

    const sameCwdConfirmation = vi.fn(async () => false)
    await expect(authorizeToolCall('delete_remote_record', args, {
      conversationId: A,
      onConfirmation: sameCwdConfirmation,
      scope: { workingDir: sameCwd }
    })).resolves.toBeUndefined()
    expect(sameCwdConfirmation).not.toHaveBeenCalled()

    const otherCwdConfirmation = vi.fn(async () => false)
    await expect(authorizeToolCall('delete_remote_record', args, {
      conversationId: A,
      onConfirmation: otherCwdConfirmation,
      scope: { workingDir: otherCwd }
    })).resolves.toMatchObject({ block: true })
    expect(otherCwdConfirmation).toHaveBeenCalledTimes(1)
  })
})
