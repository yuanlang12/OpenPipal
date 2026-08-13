import type { AgentTool } from '@earendil-works/pi-agent-core'
import { basename } from 'node:path'
import {
  createEditTool,
  createReadTool,
  createWriteTool,
} from '../../node_modules/@earendil-works/pi-coding-agent/dist/core/tools/index.js'
import {
  createOpenPipalFindTool,
  createOpenPipalGrepTool,
  createOpenPipalLsTool,
} from './agent-runtime/openpipal-search-tools'
import { bindHarnessToolsContext } from './agent-runtime/pi-core-tool-adapter'
import { createDiscoveryToolContext } from './agent-runtime/discovery-tool-context'
import {
  createEvolverTaskMigrationTool,
  type EvolverTaskCandidate,
} from './evolver-task-migration'

/**
 * Evolver is an unattended model loop, so it must not receive a raw local
 * shell. File generation still has read/edit/write, while discovery uses the
 * product-owned worker that hard-skips dotenv credentials.
 */
export function buildEvolverTools(
  cwd: string,
  taskCandidates: EvolverTaskCandidate[] = []
): AgentTool[] {
  const fileTools = [
    createReadTool(cwd),
    createEditTool(cwd),
    createWriteTool(cwd),
  ]
  const discoveryTools = bindHarnessToolsContext([
    createOpenPipalGrepTool(),
    createOpenPipalFindTool(),
    createOpenPipalLsTool(),
  ], createDiscoveryToolContext(cwd))

  return [
    ...fileTools,
    ...discoveryTools,
    ...(taskCandidates.length > 0
      ? [createEvolverTaskMigrationTool(taskCandidates, basename(cwd))]
      : []),
  ]
}
