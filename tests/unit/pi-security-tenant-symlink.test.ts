import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  assessToolScopeWithRoots,
  canonicalizeSecurityPath,
  isArtifactSidecarPath
} from '../../src/main/pi-security'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('OpenPipal tenant scope canonical paths', () => {
  it('blocks workspace symlinks into another agent and conversation', async () => {
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'openpipal-tenant-home-'))
    roots.push(fakeHome)
    const workingDir = path.join(fakeHome, 'Documents', 'workspace')
    const agentsRoot = path.join(fakeHome, '.openpipal', 'agents')
    const conversationsRoot = path.join(fakeHome, '.openpipal', 'conversations')
    fs.mkdirSync(workingDir, { recursive: true })
    fs.mkdirSync(path.join(agentsRoot, 'own-agent'), { recursive: true })
    fs.mkdirSync(path.join(agentsRoot, 'other-agent'), { recursive: true })
    fs.mkdirSync(path.join(conversationsRoot, 'other-conversation'), { recursive: true })
    const ownArtifactRoot = path.join(conversationsRoot, 'artifacts', 'own-conversation')
    fs.mkdirSync(ownArtifactRoot, { recursive: true })
    fs.symlinkSync(
      path.join(agentsRoot, 'other-agent'),
      path.join(workingDir, 'foreign-agent'),
      'dir'
    )
    fs.symlinkSync(
      path.join(conversationsRoot, 'other-conversation'),
      path.join(workingDir, 'foreign-conversation'),
      'dir'
    )
    fs.symlinkSync(
      path.join(conversationsRoot, 'new-other-conversation.json'),
      path.join(workingDir, 'dangling-conversation.json')
    )
    fs.symlinkSync(ownArtifactRoot, path.join(workingDir, 'own-artifact-alias'), 'dir')

    const tenantRoots = {
      root: path.join(fakeHome, '.openpipal'),
      agents: agentsRoot,
      conversations: conversationsRoot,
      artifacts: path.join(conversationsRoot, 'artifacts'),
      outputs: path.join(fakeHome, '.openpipal', 'outputs')
    }
    expect(canonicalizeSecurityPath(path.join(workingDir, 'foreign-agent', 'secret.md')))
      .toBe(canonicalizeSecurityPath(path.join(agentsRoot, 'other-agent', 'secret.md')))
    expect(canonicalizeSecurityPath(path.join(workingDir, 'dangling-conversation.json')))
      .toBe(canonicalizeSecurityPath(path.join(conversationsRoot, 'new-other-conversation.json')))
    expect(isArtifactSidecarPath(
      path.join(workingDir, 'own-artifact-alias', 'component.jsx'),
      ownArtifactRoot
    )).toBe(true)
    const otherAgent = assessToolScopeWithRoots(
      'read',
      { path: 'foreign-agent/secret.md' },
      { workspaceId: 'own-agent', conversationId: 'own-conversation', workingDir },
      tenantRoots
    )
    const otherConversation = assessToolScopeWithRoots(
      'grep',
      { path: 'foreign-conversation' },
      { workspaceId: 'own-agent', conversationId: 'own-conversation', workingDir },
      tenantRoots
    )
    const danglingConversation = assessToolScopeWithRoots(
      'write',
      { path: 'dangling-conversation.json', content: 'must not cross tenant' },
      { workspaceId: 'own-agent', conversationId: 'own-conversation', workingDir },
      tenantRoots
    )

    expect(otherAgent?.level).toBe('risky')
    expect(otherAgent?.reason).toContain('其他 Agent')
    expect(otherConversation?.level).toBe('risky')
    expect(otherConversation?.reason).toContain('其他对话')
    expect(danglingConversation?.level).toBe('risky')
    expect(danglingConversation?.reason).toContain('其他对话')
  })
})
