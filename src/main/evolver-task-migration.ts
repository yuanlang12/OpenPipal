import { Type } from 'typebox'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import {
  createTask,
  getTask,
  updateTask,
  type Task,
} from './task-store'

export interface EvolverTaskCandidate {
  id: string
  name: string
  createdAt: number
  /** Exact conversation provenance captured when the candidate set is built. */
  boundConversationId: string
}

export interface EvolverTaskMigrationStore {
  getTask(id: string): Task | null
  updateTask(id: string, updates: Partial<Task>): Task | null
  createTask(data: Omit<Task, 'id' | 'createdAt' | 'updatedAt'>): Task
}

const defaultStore: EvolverTaskMigrationStore = { getTask, updateTask, createTask }
const taskMigrationSchema = Type.Object({
  taskId: Type.String({ description: 'Exact task ID from Candidate tasks to migrate' }),
  action: Type.Union([Type.Literal('migrate'), Type.Literal('copy')])
})

interface EvolverTaskMigrationDetails {
  isError?: boolean
}

/**
 * Build the only automatic task-migration capability set Evolver may see.
 *
 * Creation time is not provenance: a long-lived conversation can overlap
 * unrelated global tasks. Legacy/orphan tasks therefore remain outside the
 * unattended model path and can still be managed through the normal task UI.
 */
export function selectEvolverTaskCandidates(
  tasks: readonly Task[],
  conversationId: string
): EvolverTaskCandidate[] {
  if (!conversationId) return []
  return tasks
    .filter(task => task.boundConversationId === conversationId)
    .map(task => ({
      id: task.id,
      name: task.name,
      createdAt: task.createdAt,
      boundConversationId: conversationId,
    }))
}

/**
 * Capability-scoped task migration for the Evolver model. Only task IDs that
 * the main process already selected are accepted, and task JSON (including a
 * webhook secret) never crosses into tool output or model context.
 */
export function createEvolverTaskMigrationTool(
  candidates: EvolverTaskCandidate[],
  targetWorkspaceId: string,
  store: EvolverTaskMigrationStore = defaultStore
): AgentTool<typeof taskMigrationSchema, EvolverTaskMigrationDetails | undefined> {
  const candidatesById = new Map(candidates.map(candidate => [candidate.id, candidate]))
  return {
    name: 'migrate_candidate_task',
    label: 'migrate candidate task',
    description: 'Migrate or copy one system-selected task to the Agent being created. Task secrets remain internal and are never returned.',
    parameters: taskMigrationSchema,
    async execute(_toolCallId, { taskId, action }) {
      const candidate = candidatesById.get(taskId)
      if (!candidate) {
        return {
          content: [{ type: 'text', text: 'Task is not in the system-selected candidate set; no change made.' }],
          details: { isError: true }
        }
      }
      const task = store.getTask(taskId)
      if (!task) {
        return { content: [{ type: 'text', text: 'Task no longer exists; skipped.' }], details: undefined }
      }
      // Selection is not authorization forever. Re-fetch above, then prove the
      // task is still owned by the same source conversation before any copy or
      // migration. This closes ID reuse/rebinding between selection and use.
      if (task.boundConversationId !== candidate.boundConversationId) {
        return {
          content: [{ type: 'text', text: 'Task conversation binding changed; no change made.' }],
          details: { isError: true }
        }
      }
      if (task.workspaceId && task.workspaceId !== targetWorkspaceId) {
        return {
          content: [{ type: 'text', text: 'Task belongs to another Agent; no change made.' }],
          details: undefined
        }
      }

      if (action === 'copy') {
        const { id: _id, createdAt: _createdAt, updatedAt: _updatedAt, ...copyable } = task
        const copied = store.createTask({
          ...copyable,
          workspaceId: targetWorkspaceId,
          agentId: undefined
        })
        return {
          content: [{ type: 'text', text: `Task copied to this Agent as ${copied.id}.` }],
          details: undefined
        }
      }

      const updated = store.updateTask(taskId, {
        workspaceId: targetWorkspaceId,
        agentId: undefined
      })
      return {
        content: [{ type: 'text', text: updated ? 'Task migrated to this Agent.' : 'Task changed before migration; skipped.' }],
        details: updated ? undefined : { isError: true }
      }
    }
  }
}
