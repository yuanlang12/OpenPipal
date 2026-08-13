import { describe, expect, it } from 'vitest'
import {
  AGENT_RUNTIME_ENV,
  resolveAgentRuntimeSelection
} from '../../src/main/agent-runtime/runtime-selection'

describe('Agent Runtime selection and rollback', () => {
  it('defaults to the pi-core runtime', () => {
    expect(resolveAgentRuntimeSelection(undefined)).toEqual({
      requested: undefined,
      kind: 'pi-core',
      usedDefault: true
    })
    expect(resolveAgentRuntimeSelection('   ').kind).toBe('pi-core')
  })

  it('still requires an exact value, and anything unreadable falls back to legacy', () => {
    expect(resolveAgentRuntimeSelection('pi-core')).toMatchObject({
      kind: 'pi-core',
      usedDefault: false
    })
    // 不精确的值不算"选中新路径"：读不懂的配置必须退到回滚阀门，而不是默默跑新实现
    expect(resolveAgentRuntimeSelection('PI-CORE').kind).toBe('legacy')
    expect(resolveAgentRuntimeSelection(' pi-core ').kind).toBe('legacy')
  })

  it('allows an explicit rollback to legacy', () => {
    expect(resolveAgentRuntimeSelection('legacy')).toMatchObject({
      kind: 'legacy',
      usedDefault: false
    })
  })

  it('fails safe to legacy for invalid values', () => {
    const result = resolveAgentRuntimeSelection('experimental')
    expect(result.kind).toBe('legacy')
    expect(result.usedDefault).toBe(true)
    expect(result.warning).toContain(`${AGENT_RUNTIME_ENV}=experimental`)
  })
})
