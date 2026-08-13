import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const verifier = path.resolve('scripts/verify-open-source-candidate.mjs')
const POLICY_PATH = 'config/open-source-policy.json'

type Rule = {
  id: string
  scope: 'reviewed-baseline' | 'candidate'
  action: 'exclude' | 'blocked-replacement' | 'conditional-keep'
  patterns: string[]
  overrides?: string[]
  evidence?: Array<{ path: string; sha256: string }>
}

type Policy = {
  schemaVersion: number
  policyId: string
  evidenceOnly: boolean
  noClearance: boolean
  reviewedBaselineCommit: string
  pathSetSha256: string
  rules: Rule[]
}

type VerificationError = {
  code: string
  count: number
  paths?: string[]
}

type VerificationReport = {
  verdict: 'PASS' | 'FAIL'
  policyBinding: { path: string; sha256: string | null }
  pathSetBinding: { matches: boolean }
  errors: VerificationError[]
}

function git(repo: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim()
}

function write(repo: string, relativePath: string, content: string): void {
  const target = path.join(repo, relativePath)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, content)
}

function createRepo(files: Record<string, string> = { 'README.md': 'fixture\n' }): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'openpipal-open-source-candidate-'))
  git(repo, 'init', '-q')
  git(repo, 'config', 'user.name', 'OpenPipal QA')
  git(repo, 'config', 'user.email', 'qa@openpipal.invalid')
  for (const [relativePath, content] of Object.entries(files)) write(repo, relativePath, content)
  git(repo, 'add', '.')
  git(repo, 'commit', '-q', '-m', 'baseline fixture')
  return repo
}

function commitAll(repo: string, message: string): string {
  git(repo, 'add', '.')
  git(repo, 'commit', '-q', '-m', message)
  return git(repo, 'rev-parse', 'HEAD')
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function trackedPaths(repo: string, commit: string): string[] {
  const output = git(repo, 'ls-tree', '-r', '--name-only', commit)
  return output ? output.split('\n') : []
}

function pathSetHash(paths: string[]): string {
  return sha256([...paths].sort().map(candidatePath => `${candidatePath}\n`).join(''))
}

function policyKeepRule(): Rule {
  return {
    id: 'candidate-policy',
    scope: 'candidate',
    action: 'conditional-keep',
    patterns: [POLICY_PATH]
  }
}

function policyFor(baseline: string, paths: string[], rules?: Rule[]): Policy {
  const baselineRules = rules || [{
    id: 'baseline',
    scope: 'reviewed-baseline' as const,
    action: 'conditional-keep' as const,
    patterns: ['**']
  }]
  return {
    schemaVersion: 1,
    policyId: 'fixture-policy',
    evidenceOnly: true,
    noClearance: true,
    reviewedBaselineCommit: baseline,
    pathSetSha256: pathSetHash(paths),
    rules: [...baselineRules, policyKeepRule()]
  }
}

function commitPolicy(repo: string, policy: Policy, message = 'candidate policy'): { commit: string; raw: string } {
  const raw = `${JSON.stringify(policy, null, 2)}\n`
  write(repo, POLICY_PATH, raw)
  return { commit: commitAll(repo, message), raw }
}

function spawnVerifier(repo: string, args: string[]): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [verifier, '--repo', repo, ...args], { encoding: 'utf8' })
}

function run(repo: string, commit: string): {
  status: number | null
  stdout: string
  report: VerificationReport
} {
  const result = spawnVerifier(repo, ['--commit', commit])
  return { status: result.status, stdout: result.stdout, report: JSON.parse(result.stdout) }
}

describe('open-source candidate verifier', () => {
  it('accepts only the canonical raw commit explicitly selected by --commit', () => {
    const repo = createRepo()
    const baseline = git(repo, 'rev-parse', 'HEAD')
    const candidate = commitPolicy(repo, policyFor(baseline, trackedPaths(repo, baseline))).commit

    expect(run(repo, candidate)).toMatchObject({ status: 0, report: { verdict: 'PASS' } })
    const symbolic = run(repo, 'HEAD')
    expect(symbolic.status).toBe(1)
    expect(symbolic.report.errors.map(error => error.code)).toContain('IMMUTABLE_COMMIT_REQUIRED')
  })

  it('rejects raw tree and annotated-tag object ids even when they are full hashes', () => {
    const repo = createRepo()
    const commit = git(repo, 'rev-parse', 'HEAD')
    const treeObject = git(repo, 'rev-parse', 'HEAD^{tree}')

    const treeResult = run(repo, treeObject)
    expect(treeResult.status).toBe(1)
    expect(treeResult.report.errors.map(error => error.code)).toContain('EXACT_COMMIT_REQUIRED')

    git(repo, 'tag', '-a', 'fixture-tag', '-m', 'fixture tag')
    const tagObject = git(repo, 'rev-parse', 'fixture-tag')
    const tagResult = run(repo, tagObject)
    expect(tagResult.status).toBe(1)
    expect(tagResult.report.errors.map(error => error.code)).toContain('EXACT_COMMIT_REQUIRED')
    expect(commit).not.toBe(tagObject)
  })

  it('does not fail a candidate merely because a classified file changed', () => {
    // A 档时这里会因「签字绑定的内容哈希对不上」而 FAIL。B 档只管分类：文件内容
    // 变了但分类没变，就不是校验器该拦的事——是否发布由人对着发行清单确认。
    const repo = createRepo()
    const baseline = git(repo, 'rev-parse', 'HEAD')
    const first = commitPolicy(repo, policyFor(baseline, trackedPaths(repo, baseline)))
    expect(run(repo, first.commit).status).toBe(0)

    write(repo, 'README.md', 'changed after the first candidate\n')
    const changed = commitAll(repo, 'change an already classified file')
    const result = run(repo, changed)

    expect(result.status).toBe(0)
    expect(result.report.verdict).toBe('PASS')
    expect(result.report.policyBinding.sha256).toBe(sha256(first.raw))
  })

  it('binds policy to the candidate blob and ignores dirty, deleted, and untracked worktree policy', () => {
    const repo = createRepo()
    const baseline = git(repo, 'rev-parse', 'HEAD')
    const committed = commitPolicy(repo, policyFor(baseline, trackedPaths(repo, baseline)))
    const before = run(repo, committed.commit)

    expect(before.status).toBe(0)
    expect(before.report.policyBinding).toEqual({ path: POLICY_PATH, sha256: sha256(committed.raw) })

    write(repo, POLICY_PATH, '{"dirty":true}\n')
    expect(run(repo, committed.commit).stdout).toBe(before.stdout)

    fs.rmSync(path.join(repo, POLICY_PATH))
    expect(run(repo, committed.commit).stdout).toBe(before.stdout)

    write(repo, POLICY_PATH, '{"untracked":"replacement"}\n')
    git(repo, 'rm', '--cached', '-q', POLICY_PATH)
    expect(run(repo, committed.commit).stdout).toBe(before.stdout)

    write(repo, 'policy.external.json', '{"attempted":"override"}\n')
    const rejectedOverride = spawnVerifier(repo, [
      '--commit', committed.commit,
      '--policy', path.join(repo, 'policy.external.json')
    ])
    expect(rejectedOverride.status).toBe(1)
    expect(JSON.parse(rejectedOverride.stdout).errors).toContainEqual(expect.objectContaining({ code: 'INVALID_ARGUMENTS' }))
  }, 15_000)

  it('fails closed when the candidate has no committed policy', () => {
    const repo = createRepo()
    const commit = git(repo, 'rev-parse', 'HEAD')
    const result = run(repo, commit)

    expect(result.status).toBe(1)
    expect(result.report.policyBinding).toEqual({ path: POLICY_PATH, sha256: null })
    expect(result.report.errors.map(error => error.code)).toContain('POLICY_NOT_IN_CANDIDATE')
  })

  it('fails closed and binds the raw blob when committed policy JSON is malformed', () => {
    const repo = createRepo()
    const malformed = '{not-json\n'
    write(repo, POLICY_PATH, malformed)
    const candidate = commitAll(repo, 'malformed policy')
    const result = run(repo, candidate)

    expect(result.status).toBe(1)
    expect(result.report.policyBinding).toEqual({ path: POLICY_PATH, sha256: sha256(malformed) })
    expect(result.report.errors.map(error => error.code)).toEqual(expect.arrayContaining([
      'MALFORMED_POLICY',
      'INVALID_POLICY'
    ]))
  })

  it('fails closed for an unknown path added after the reviewed baseline', () => {
    const repo = createRepo()
    const baseline = git(repo, 'rev-parse', 'HEAD')
    write(repo, 'new-file.txt', 'new\n')
    commitAll(repo, 'stage unknown content')
    const candidate = commitPolicy(repo, policyFor(baseline, trackedPaths(repo, baseline)), 'add unknown').commit
    const result = run(repo, candidate)

    expect(result.status).toBe(1)
    expect(result.report.errors).toContainEqual(expect.objectContaining({
      code: 'UNKNOWN_CANDIDATE_PATH',
      paths: ['new-file.txt']
    }))
  })

  it('honors an explicit ordered override and rejects undeclared overlap', () => {
    const repo = createRepo()
    const baseline = git(repo, 'rev-parse', 'HEAD')
    const paths = trackedPaths(repo, baseline)
    const baseRule: Rule = {
      id: 'exclude-default',
      scope: 'reviewed-baseline',
      action: 'exclude',
      patterns: ['**']
    }
    const keepRule: Rule = {
      id: 'approved-readme',
      scope: 'candidate',
      action: 'conditional-keep',
      patterns: ['README.md'],
      overrides: ['exclude-default']
    }
    const approved = commitPolicy(repo, policyFor(baseline, paths, [baseRule, keepRule]), 'approved override').commit
    expect(run(repo, approved).status).toBe(0)

    const conflictingRule = { ...keepRule, overrides: undefined }
    const conflict = commitPolicy(repo, policyFor(baseline, paths, [baseRule, conflictingRule]), 'conflicting rules').commit
    const result = run(repo, conflict)
    expect(result.status).toBe(1)
    expect(result.report.errors.map(error => error.code)).toContain('RULE_OVERLAP_CONFLICT')
  })

  it('always fails when a blocked rule matches, even after an explicit later override', () => {
    const repo = createRepo({ 'legacy.txt': 'old material\n' })
    const baseline = git(repo, 'rev-parse', 'HEAD')
    const blocked: Rule = {
      id: 'blocked',
      scope: 'reviewed-baseline',
      action: 'blocked-replacement',
      patterns: ['legacy.txt']
    }
    const attemptedOverride: Rule = {
      id: 'attempted-keep',
      scope: 'candidate',
      action: 'conditional-keep',
      patterns: ['legacy.txt'],
      overrides: ['blocked']
    }
    const candidate = commitPolicy(
      repo,
      policyFor(baseline, trackedPaths(repo, baseline), [blocked, attemptedOverride])
    ).commit
    const result = run(repo, candidate)

    expect(result.status).toBe(1)
    expect(result.report.errors).toContainEqual(expect.objectContaining({
      code: 'BLOCKED_REPLACEMENT_PRESENT',
      paths: ['legacy.txt']
    }))
  })

  it('fails when the reviewed baseline path-set binding is wrong', () => {
    const repo = createRepo()
    const baseline = git(repo, 'rev-parse', 'HEAD')
    const policy = policyFor(baseline, trackedPaths(repo, baseline))
    policy.pathSetSha256 = '0'.repeat(64)
    const candidate = commitPolicy(repo, policy).commit
    const result = run(repo, candidate)

    expect(result.status).toBe(1)
    expect(result.report.pathSetBinding.matches).toBe(false)
    expect(result.report.errors.map(error => error.code)).toContain('PATH_SET_HASH_MISMATCH')
  })

  it('uses committed git-show evidence and emits byte-stable JSON', () => {
    const repo = createRepo()
    const baseline = git(repo, 'rev-parse', 'HEAD')
    const rule: Rule = {
      id: 'reviewed',
      scope: 'reviewed-baseline',
      action: 'conditional-keep',
      patterns: ['**'],
      evidence: [{ path: 'README.md', sha256: sha256('fixture\n') }]
    }
    const committed = commitPolicy(repo, policyFor(baseline, trackedPaths(repo, baseline), [rule]))
    const first = run(repo, committed.commit)
    const second = run(repo, committed.commit)

    expect(first.status).toBe(0)
    expect(second.stdout).toBe(first.stdout)
    expect(first.report.policyBinding).toEqual({ path: POLICY_PATH, sha256: sha256(committed.raw) })
    expect(first.stdout).not.toContain(repo)
    expect(first.stdout).not.toMatch(/"(?:timestamp|generatedAt|date)"/)

    const mismatchPolicy = policyFor(baseline, trackedPaths(repo, baseline), [{
      ...rule,
      evidence: [{ path: 'README.md', sha256: 'f'.repeat(64) }]
    }])
    const mismatch = commitPolicy(repo, mismatchPolicy, 'bad evidence').commit
    const result = run(repo, mismatch)
    expect(result.status).toBe(1)
    expect(result.report.errors.map(error => error.code)).toContain('EVIDENCE_HASH_MISMATCH')
  })

})
