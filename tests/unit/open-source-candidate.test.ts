import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const verifier = path.resolve('scripts/verify-open-source-candidate.mjs')
const POLICY_PATH = 'config/open-source-policy.json'

type Review = {
  owner: string
  approver: string
  candidate: string
  status: string
}

type Rule = {
  id: string
  scope: 'reviewed-baseline' | 'candidate'
  action: 'exclude' | 'blocked-replacement' | 'conditional-keep'
  patterns: string[]
  overrides?: string[]
  review?: Review
  evidence?: Array<{ path: string; sha256: string }>
}

type Policy = {
  schemaVersion: number
  policyId: string
  evidenceOnly: boolean
  noClearance: boolean
  reviewedBaselineCommit: string
  pathSetSha256: string
  candidateContentSha256: string
  candidate: { commit: string; owner: string; approver: string; status: string }
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
  candidateContentBinding: { expected: string | null; actual: string | null; matches: boolean }
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

function candidateContentHash(repo: string, commit: string): string {
  const output = execFileSync('git', ['ls-tree', '-r', '-l', commit], { cwd: repo, encoding: 'utf8' }).replace(/\n$/, '')
  const entries = output ? output.split('\n').map(line => {
    const [metadata, relativePath] = line.split('\t')
    const match = /^(\d{6}) blob ([0-9a-f]+)\s+(\d+)$/.exec(metadata)
    if (!match || !relativePath) throw new Error('invalid fixture tree')
    return { mode: match[1], objectId: match[2], size: Number(match[3]), path: relativePath }
  }) : []
  return sha256(entries
    .filter(entry => entry.path !== POLICY_PATH)
    .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
    .map(entry => `${entry.mode} ${entry.objectId} ${entry.size}\t${entry.path}\n`)
    .join(''))
}

function approvedReview(): Review {
  return { owner: 'fixture-owner', approver: 'fixture-approver', candidate: 'SELF', status: 'APPROVED' }
}

function policyKeepRule(): Rule {
  return {
    id: 'candidate-policy',
    scope: 'candidate',
    action: 'conditional-keep',
    patterns: [POLICY_PATH],
    review: approvedReview()
  }
}

function policyFor(baseline: string, paths: string[], rules?: Rule[]): Policy {
  const baselineRules = rules || [{
    id: 'baseline',
    scope: 'reviewed-baseline' as const,
    action: 'conditional-keep' as const,
    patterns: ['**'],
    review: approvedReview()
  }]
  return {
    schemaVersion: 1,
    policyId: 'fixture-policy',
    evidenceOnly: true,
    noClearance: true,
    reviewedBaselineCommit: baseline,
    pathSetSha256: pathSetHash(paths),
    candidateContentSha256: 'AUTO',
    candidate: {
      commit: 'SELF',
      owner: 'fixture-owner',
      approver: 'fixture-approver',
      status: 'APPROVED'
    },
    rules: [...baselineRules, policyKeepRule()]
  }
}

function commitPolicy(repo: string, policy: Policy, message = 'candidate policy'): { commit: string; raw: string } {
  if (policy.candidateContentSha256 === 'AUTO') {
    policy.candidateContentSha256 = candidateContentHash(repo, git(repo, 'rev-parse', 'HEAD'))
  }
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

  it('accepts PENDING as committed policy data but never treats it as approval', () => {
    const repo = createRepo()
    const baseline = git(repo, 'rev-parse', 'HEAD')
    const policy = policyFor(baseline, trackedPaths(repo, baseline))
    policy.candidateContentSha256 = 'PENDING'
    policy.candidate = { commit: 'PENDING', owner: ' PENDING ', approver: '\tPENDING\t', status: 'PENDING' }
    policy.rules[0].review = {
      owner: ' PENDING ',
      approver: '\nPENDING\n',
      candidate: 'PENDING',
      status: 'PENDING'
    }
    const candidate = commitPolicy(repo, policy).commit

    const result = run(repo, candidate)
    expect(result.status).toBe(1)
    expect(result.report.errors.map(error => error.code)).toEqual(expect.arrayContaining([
      'CANDIDATE_COMMIT_MISMATCH',
      'CANDIDATE_OWNER_PENDING',
      'CANDIDATE_APPROVER_PENDING',
      'CANDIDATE_STATUS_NOT_APPROVED',
      'CANDIDATE_CONTENT_BINDING_PENDING',
      'RULE_REVIEW_PENDING'
    ]))
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

  it('rejects stale SELF approval after an existing classified file changes', () => {
    const repo = createRepo()
    const baseline = git(repo, 'rev-parse', 'HEAD')
    const approved = commitPolicy(repo, policyFor(baseline, trackedPaths(repo, baseline)))
    expect(run(repo, approved.commit).status).toBe(0)

    write(repo, 'README.md', 'changed after approval\n')
    const changedCandidate = commitAll(repo, 'change existing classified file')
    const result = run(repo, changedCandidate)

    expect(result.status).toBe(1)
    expect(result.report.policyBinding.sha256).toBe(sha256(approved.raw))
    expect(result.report.candidateContentBinding.matches).toBe(false)
    expect(result.report.errors.map(error => error.code)).toEqual(expect.arrayContaining([
      'CANDIDATE_CONTENT_HASH_MISMATCH',
      'RULE_REVIEW_PENDING'
    ]))
  })

  it('allows a policy-only approval update while binding its new policy blob separately', () => {
    const repo = createRepo()
    const baseline = git(repo, 'rev-parse', 'HEAD')
    const policy = policyFor(baseline, trackedPaths(repo, baseline))
    policy.candidateContentSha256 = 'PENDING'
    policy.candidate = { commit: 'PENDING', owner: 'PENDING', approver: 'PENDING', status: 'PENDING' }
    const pending = commitPolicy(repo, policy, 'pending review')
    expect(run(repo, pending.commit).status).toBe(1)

    policy.candidateContentSha256 = 'AUTO'
    policy.candidate = {
      commit: 'SELF',
      owner: 'fixture-owner',
      approver: 'fixture-approver',
      status: 'APPROVED'
    }
    const approved = commitPolicy(repo, policy, 'approve unchanged candidate content')
    const result = run(repo, approved.commit)

    expect(result.status).toBe(0)
    expect(result.report.candidateContentBinding.matches).toBe(true)
    expect(result.report.policyBinding.sha256).toBe(sha256(approved.raw))
    expect(result.report.policyBinding.sha256).not.toBe(sha256(pending.raw))
  })

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
      patterns: ['**'],
      review: approvedReview()
    }
    const keepRule: Rule = {
      id: 'approved-readme',
      scope: 'candidate',
      action: 'conditional-keep',
      patterns: ['README.md'],
      overrides: ['exclude-default'],
      review: approvedReview()
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
      patterns: ['legacy.txt'],
      review: approvedReview()
    }
    const attemptedOverride: Rule = {
      id: 'attempted-keep',
      scope: 'candidate',
      action: 'conditional-keep',
      patterns: ['legacy.txt'],
      overrides: ['blocked'],
      review: approvedReview()
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
      review: approvedReview(),
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

  it('never carries approvals without a pinned content hash', () => {
    // 签字与内容哈希必须同时钉。只签字不钉哈希 = 空白支票：私仓这份策略可以被
    // 无限次重新裁剪，带着 APPROVED 的话，任何人跑一次「裁剪 + 钉哈希」就能拿到
    // 署名 PASS，内容随便。所以模板侧（哈希 PENDING）不许带签字；发行候选里两者
    // 都已钉死，是正常状态——本断言在私仓与公开树上都成立。
    const policy = JSON.parse(fs.readFileSync(path.resolve(POLICY_PATH), 'utf8')) as Policy
    if (policy.candidateContentSha256 !== 'PENDING') return

    const signed = [
      ...policy.rules
        .filter(rule => rule.review && rule.review.status !== 'PENDING')
        .map(rule => rule.id),
      ...(policy.candidate.status !== 'PENDING' ? ['<top-level candidate>'] : [])
    ]
    expect(signed, '内容哈希未钉死时不得带签字：签字要和哈希一起写进候选提交').toEqual([])
  })
})
