type ArtifactLike = {
  type?: unknown
  content?: unknown
}

type TodoLike = {
  status?: unknown
}

/**
 * 任务清单是过程态 UI：还有未完成项时展示；清空或全部完成后自动退场。
 * 内容损坏时宁可继续展示错误态，也不要误删用户仍可能需要查看的清单。
 */
export function shouldDismissTodosArtifact(artifact: ArtifactLike | null | undefined): boolean {
  if (artifact?.type !== 'todos' || typeof artifact.content !== 'string') return false

  try {
    const parsed = JSON.parse(artifact.content) as { todos?: unknown }
    if (!Array.isArray(parsed.todos)) return false
    return parsed.todos.length === 0 || parsed.todos.every((todo: TodoLike) => todo?.status === 'completed')
  } catch {
    return false
  }
}
