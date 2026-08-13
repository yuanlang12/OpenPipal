import { describe, expect, it } from 'vitest'
import { shouldDismissTodosArtifact } from '../../src/renderer/src/utils/todosArtifactLifecycle'

function todos(statuses: string[]) {
  return {
    type: 'todos',
    content: JSON.stringify({
      todos: statuses.map((status, index) => ({ content: `任务 ${index + 1}`, status }))
    })
  }
}

describe('todos artifact 生命周期', () => {
  it('仍有 pending 或 in_progress 时继续展示', () => {
    expect(shouldDismissTodosArtifact(todos(['completed', 'in_progress']))).toBe(false)
    expect(shouldDismissTodosArtifact(todos(['completed', 'pending']))).toBe(false)
  })

  it('全部 completed 时退场', () => {
    expect(shouldDismissTodosArtifact(todos(['completed', 'completed']))).toBe(true)
  })

  it('显式清空时退场', () => {
    expect(shouldDismissTodosArtifact(todos([]))).toBe(true)
  })

  it('非 todos 或损坏内容不误删', () => {
    expect(shouldDismissTodosArtifact({ type: 'html', content: JSON.stringify({ todos: [] }) })).toBe(false)
    expect(shouldDismissTodosArtifact({ type: 'todos', content: '{broken' })).toBe(false)
    expect(shouldDismissTodosArtifact({ type: 'todos', content: JSON.stringify({ items: [] }) })).toBe(false)
  })
})
