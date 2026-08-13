import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createEvolverTaskMigrationTool,
  selectEvolverTaskCandidates,
  type EvolverTaskMigrationStore,
} from '../../src/main/evolver-task-migration'
import { buildEvolverTools } from '../../src/main/evolver-tools'
import type { Task } from '../../src/main/task-store'

const temporaryRoots: string[] = []

function task(
  id: string,
  name: string,
  boundConversationId?: string,
  overrides: Partial<Task> = {}
): Task {
  return {
    id,
    name,
    enabled: true,
    trigger: { type: 'schedule', schedule: { type: 'interval', intervalMs: 60_000 } },
    prompt: 'run',
    conversationMode: 'per-run',
    boundConversationId,
    createdAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  }
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

describe('Evolver task conversation scope', () => {
  it('does not expose orphan or other-conversation task names, IDs, or migration capability', () => {
    const bound = task('bound-id', 'Current conversation task', 'conversation-current')
    // Same creation window as the legitimate task: timestamps must not grant provenance.
    const orphan = task('orphan-secret-id', 'Orphan private task', undefined)
    const other = task('other-secret-id', 'Other conversation private task', 'conversation-other')

    const candidates = selectEvolverTaskCandidates(
      [bound, orphan, other],
      'conversation-current'
    )
    expect(candidates).toEqual([{
      id: bound.id,
      name: bound.name,
      createdAt: bound.createdAt,
      boundConversationId: 'conversation-current',
    }])
    const serialized = JSON.stringify(candidates)
    expect(serialized).not.toContain(orphan.id)
    expect(serialized).not.toContain(orphan.name)
    expect(serialized).not.toContain(other.id)
    expect(serialized).not.toContain(other.name)

    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'openpipal-evolver-scope-'))
    temporaryRoots.push(cwd)
    expect(buildEvolverTools(cwd, candidates).map(tool => tool.name)).toContain('migrate_candidate_task')

    const noCandidates = selectEvolverTaskCandidates([orphan, other], 'conversation-current')
    expect(noCandidates).toEqual([])
    expect(buildEvolverTools(cwd, noCandidates).map(tool => tool.name)).not.toContain('migrate_candidate_task')
  })

  it('refuses a selected task that is rebound before migration without leaking its data', async () => {
    const selected = task('selected-id', 'Originally selected task', 'conversation-current')
    const candidates = selectEvolverTaskCandidates([selected], 'conversation-current')
    const reboundSecret = 'rebound-webhook-secret'
    const rebound = task(selected.id, 'Rebound private task', 'conversation-other', {
      trigger: { type: 'webhook', secret: reboundSecret },
    })
    const updateTask = vi.fn()
    const createTask = vi.fn()
    const store: EvolverTaskMigrationStore = {
      getTask: () => rebound,
      updateTask,
      createTask,
    }
    const migration = createEvolverTaskMigrationTool(candidates, 'new-agent', store)

    const migrateResult = await migration.execute(
      'rebound-migrate',
      { taskId: selected.id, action: 'migrate' },
      undefined,
      undefined
    )
    const copyResult = await migration.execute(
      'rebound-copy',
      { taskId: selected.id, action: 'copy' },
      undefined,
      undefined
    )

    expect(updateTask).not.toHaveBeenCalled()
    expect(createTask).not.toHaveBeenCalled()
    for (const result of [migrateResult, copyResult]) {
      const serialized = JSON.stringify(result)
      expect(result.details).toMatchObject({ isError: true })
      expect(serialized).not.toContain(rebound.name)
      expect(serialized).not.toContain(reboundSecret)
      expect(serialized).not.toContain(selected.id)
    }
  })
})
