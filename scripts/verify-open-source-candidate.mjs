#!/usr/bin/env node
/* global process */

/**
 * Verify an immutable public-candidate commit against a machine-readable policy.
 *
 * This checks **classification completeness and consistency**, not approval:
 * every published path is covered by a rule, nothing excluded or blocked leaked
 * through, rule overlaps are declared, and the policy was authored against the
 * baseline it claims. Who decided to publish is a human question answered
 * out-of-band by reviewing the release checklist — see
 * docs/claude/mechanism-registry.md for why the signature fields were removed.
 *
 * Candidate path and content facts come only from:
 *   git ls-tree -r -l <commit>
 *   git show <commit>:<path>
 *
 * `git rev-parse --verify <oid>^{commit}` is used only to prove that the input
 * OID is itself the canonical commit OID, rather than a tree or annotated tag.
 *
 * The policy is read from config/open-source-policy.json in that same commit.
 * Candidate files are never read from the working tree, so staged, unstaged,
 * deleted, and untracked files cannot affect the result for a fixed commit.
 */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const ACTIONS = new Set(['exclude', 'blocked-replacement', 'conditional-keep'])
const SCOPES = new Set(['reviewed-baseline', 'candidate'])
const FULL_COMMIT = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/
const SHA256 = /^[0-9a-f]{64}$/
const MAX_PATH_SAMPLES = 20
const POLICY_PATH = 'config/open-source-policy.json'
const LEDGER_PATH = 'THIRD_PARTY_NOTICES.md'
const LEDGER_EXCLUDED_MARK = 'EXCLUDED FROM CLEARANCE'

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

export function hashPathSet(paths) {
  const canonical = [...new Set(paths)].sort().map(candidatePath => `${candidatePath}\n`).join('')
  return sha256(canonical)
}

function git(repo, args, encoding = 'utf8') {
  try {
    return execFileSync('git', args, {
      cwd: repo,
      encoding,
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe']
    })
  } catch {
    throw new Error('GIT_OBJECT_READ_FAILED')
  }
}

function assertExactCommit(repo, objectId) {
  let resolved
  try {
    resolved = git(repo, ['rev-parse', '--verify', `${objectId}^{commit}`]).trim()
  } catch {
    throw new Error('EXACT_COMMIT_REQUIRED')
  }
  if (resolved !== objectId) throw new Error('EXACT_COMMIT_REQUIRED')
}

function readTree(repo, commit) {
  const output = git(repo, ['ls-tree', '-r', '-l', `${commit}^{commit}`])
  if (output.length === 0) return []

  return output.replace(/\n$/, '').split('\n').map(line => {
    const tab = line.indexOf('\t')
    const metadata = tab === -1 ? '' : line.slice(0, tab)
    const candidatePath = tab === -1 ? '' : line.slice(tab + 1)
    const match = /^(\d{6}) (blob|tree) ([0-9a-f]+)\s+(-|\d+)$/.exec(metadata)
    if (!match || match[2] !== 'blob' || !candidatePath || candidatePath.startsWith('"')) {
      throw new Error('UNSUPPORTED_TREE_ENTRY')
    }
    return {
      mode: match[1],
      objectId: match[3],
      size: Number(match[4]),
      path: candidatePath
    }
  })
}

function readBlob(repo, commit, candidatePath) {
  return git(repo, ['show', `${commit}^{commit}:${candidatePath}`], null)
}

function readCommittedPolicy(repo, commit) {
  let raw
  try {
    raw = readBlob(repo, commit, POLICY_PATH)
  } catch {
    throw new Error('POLICY_NOT_IN_CANDIDATE')
  }
  const digest = sha256(raw)
  try {
    return { policy: JSON.parse(raw.toString('utf8')), digest }
  } catch {
    return { policy: null, digest, parseError: 'MALFORMED_POLICY' }
  }
}

function globToRegExp(pattern) {
  let source = '^'
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]
    if (char === '*') {
      if (pattern[index + 1] === '*') {
        source += '.*'
        index += 1
      } else {
        source += '[^/]*'
      }
    } else if (char === '?') {
      source += '[^/]'
    } else {
      source += char.replace(/[|\\{}()[\]^$+*.?-]/g, '\\$&')
    }
  }
  return new RegExp(`${source}$`)
}

function addGroupedError(groups, code, options = {}) {
  const ruleId = options.ruleId || ''
  const detail = options.detail || ''
  const key = `${code}\u0000${ruleId}\u0000${detail}`
  const current = groups.get(key) || { code, count: 0, paths: [], ruleId, detail }
  current.count += options.count || 1
  if (options.path && current.paths.length < MAX_PATH_SAMPLES) current.paths.push(options.path)
  for (const candidatePath of options.paths || []) {
    if (current.paths.length >= MAX_PATH_SAMPLES) break
    current.paths.push(candidatePath)
  }
  groups.set(key, current)
}

function finishErrors(groups) {
  return [...groups.values()]
    .map(group => {
      const result = { code: group.code, count: group.count }
      if (group.ruleId) result.ruleId = group.ruleId
      if (group.detail) result.detail = group.detail
      if (group.paths.length > 0) result.paths = [...new Set(group.paths)].sort()
      return result
    })
    .sort((left, right) => {
      const leftKey = `${left.code}\u0000${left.ruleId || ''}\u0000${left.detail || ''}`
      const rightKey = `${right.code}\u0000${right.ruleId || ''}\u0000${right.detail || ''}`
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0
    })
}

/**
 * 从 THIRD_PARTY_NOTICES.md 的表格里取出判为 EXCLUDED 的行。
 *
 * 台账是人写的散文，解析器不假装读得懂它。只做一件确定的事：把「Material」格里反引号
 * 包起来、看着像路径的东西当 glob 收走。行里的散文限定语（"except for…"、"other than
 * the five…"）**故意不解析**——那类行会自然产生非空交集，从而强制策略侧写一条带理由的
 * 显式豁免。把读不懂的地方推到人必须落笔的位置，比猜一个语义安全。
 */
function parseLedgerExclusions(markdown) {
  const rows = []
  for (const line of markdown.split('\n')) {
    if (!line.startsWith('|') || !line.includes(LEDGER_EXCLUDED_MARK)) continue
    const cells = line.split('|').slice(1, -1)
    if (cells.length < 2) continue
    const material = cells[0].trim()
    const globs = [...material.matchAll(/`([^`]+)`/g)]
      .map(match => match[1].trim())
      .filter(value => value.includes('/'))
    if (globs.length > 0) rows.push({ material, globs })
  }
  return rows
}

/**
 * 台账写的是目录意图，发行树是文件清单：`resources/skills/*` 作为 glob 只匹配直接子项，
 * 而 git 树里没有目录条目，于是它一个文件都匹配不到、检查静默落空。所以每个 glob 同时
 * 按自身与其子树两种形态求值。
 */
function ledgerGlobMatchers(glob) {
  const matchers = [globToRegExp(glob)]
  if (!glob.endsWith('**')) matchers.push(globToRegExp(glob.replace(/\/*$/, '') + '/**'))
  return matchers
}

function validatePolicy(policy, errors) {
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) {
    addGroupedError(errors, 'INVALID_POLICY')
    return []
  }
  if (policy.schemaVersion !== 1) addGroupedError(errors, 'UNSUPPORTED_POLICY_VERSION')
  if (policy.evidenceOnly !== true) addGroupedError(errors, 'EVIDENCE_ONLY_REQUIRED')
  if (policy.noClearance !== true) addGroupedError(errors, 'NO_CLEARANCE_REQUIRED')
  if (!FULL_COMMIT.test(policy.reviewedBaselineCommit || '')) {
    addGroupedError(errors, 'INVALID_BASELINE_COMMIT')
  }
  if (!SHA256.test(policy.pathSetSha256 || '')) addGroupedError(errors, 'INVALID_PATH_SET_HASH')
  if (!Array.isArray(policy.rules) || policy.rules.length === 0) {
    addGroupedError(errors, 'RULES_REQUIRED')
    return []
  }

  const ids = new Set()
  const rules = []
  for (const [index, rule] of policy.rules.entries()) {
    const fallbackId = `rule-${index + 1}`
    const id = typeof rule?.id === 'string' && rule.id ? rule.id : fallbackId
    if (ids.has(id)) addGroupedError(errors, 'DUPLICATE_RULE_ID', { ruleId: id })
    if (id === fallbackId && rule?.id !== fallbackId) addGroupedError(errors, 'INVALID_RULE_ID', { ruleId: id })
    ids.add(id)

    if (!SCOPES.has(rule?.scope)) addGroupedError(errors, 'INVALID_RULE_SCOPE', { ruleId: id })
    if (!ACTIONS.has(rule?.action)) addGroupedError(errors, 'INVALID_RULE_ACTION', { ruleId: id })
    if (!Array.isArray(rule?.patterns) || rule.patterns.length === 0 || rule.patterns.some(pattern => typeof pattern !== 'string' || pattern === '')) {
      addGroupedError(errors, 'INVALID_RULE_PATTERNS', { ruleId: id })
    }
    const overrides = Array.isArray(rule?.overrides) ? rule.overrides : []
    for (const overriddenId of overrides) {
      if (!ids.has(overriddenId) || overriddenId === id) {
        addGroupedError(errors, 'INVALID_RULE_OVERRIDE', { ruleId: id, detail: String(overriddenId) })
      }
    }
    const patterns = Array.isArray(rule?.patterns) ? rule.patterns.filter(pattern => typeof pattern === 'string' && pattern) : []
    rules.push({
      id,
      scope: rule?.scope,
      action: rule?.action,
      patterns,
      matchers: patterns.map(globToRegExp),
      overrides,
      evidence: Array.isArray(rule?.evidence) ? rule.evidence : []
    })
  }
  return rules
}

function matchesRule(rule, candidatePath, baselineSet) {
  if (rule.scope === 'reviewed-baseline' && !baselineSet.has(candidatePath)) return false
  return rule.matchers.some(matcher => matcher.test(candidatePath))
}

export function verifyOpenSourceCandidate({ repo = '.', commit }) {
  const groupedErrors = new Map()
  const immutableCommit = typeof commit === 'string' ? commit : ''
  if (!FULL_COMMIT.test(immutableCommit)) addGroupedError(groupedErrors, 'IMMUTABLE_COMMIT_REQUIRED')

  let exactCandidate = false
  let policy = null
  let policyLoaded = false
  let policySha256 = null
  if (FULL_COMMIT.test(immutableCommit)) {
    try {
      assertExactCommit(repo, immutableCommit)
      exactCandidate = true
    } catch (error) {
      addGroupedError(groupedErrors, error.message)
    }
  }
  if (exactCandidate) {
    try {
      const committedPolicy = readCommittedPolicy(repo, immutableCommit)
      policy = committedPolicy.policy
      policyLoaded = true
      policySha256 = committedPolicy.digest
      if (committedPolicy.parseError) addGroupedError(groupedErrors, committedPolicy.parseError)
    } catch (error) {
      addGroupedError(groupedErrors, error.message)
    }
  }

  const rules = policyLoaded ? validatePolicy(policy, groupedErrors) : []

  const baselineCommit = FULL_COMMIT.test(policy?.reviewedBaselineCommit || '')
    ? policy.reviewedBaselineCommit
    : null
  let baselineEntries = []
  let candidateEntries = []
  let baselineRead = false
  let candidateRead = false

  if (baselineCommit) {
    try {
      assertExactCommit(repo, baselineCommit)
      baselineEntries = readTree(repo, baselineCommit)
      baselineRead = true
    } catch (error) {
      addGroupedError(groupedErrors, error.message)
    }
  }
  if (exactCandidate && policyLoaded) {
    try {
      candidateEntries = immutableCommit === baselineCommit && baselineRead
        ? baselineEntries
        : readTree(repo, immutableCommit)
      candidateRead = true
    } catch (error) {
      addGroupedError(groupedErrors, error.message)
    }
  }

  const baselinePaths = baselineEntries.map(entry => entry.path)
  const candidatePaths = candidateEntries.map(entry => entry.path)
  const baselineSet = new Set(baselinePaths)
  const candidateSet = new Set(candidatePaths)
  const actualPathSetSha256 = hashPathSet(baselinePaths)
  if (baselineCommit && actualPathSetSha256 !== policy.pathSetSha256) {
    addGroupedError(groupedErrors, 'PATH_SET_HASH_MISMATCH')
  }

  const matchedBaselineCounts = new Map(rules.map(rule => [rule.id, 0]))
  const matchedCandidateCounts = new Map(rules.map(rule => [rule.id, 0]))

  for (const baselinePath of baselinePaths) {
    const matched = rules.filter(rule => matchesRule(rule, baselinePath, baselineSet))
    if (matched.length === 0) addGroupedError(groupedErrors, 'UNCLASSIFIED_BASELINE_PATH', { path: baselinePath })
    for (const rule of matched) matchedBaselineCounts.set(rule.id, matchedBaselineCounts.get(rule.id) + 1)
  }

  for (const candidatePath of candidatePaths) {
    const matched = rules.filter(rule => matchesRule(rule, candidatePath, baselineSet))
    if (matched.length === 0) {
      addGroupedError(groupedErrors, 'UNKNOWN_CANDIDATE_PATH', { path: candidatePath })
      continue
    }
    for (const rule of matched) matchedCandidateCounts.set(rule.id, matchedCandidateCounts.get(rule.id) + 1)

    const blocked = matched.filter(rule => rule.action === 'blocked-replacement')
    for (const rule of blocked) {
      addGroupedError(groupedErrors, 'BLOCKED_REPLACEMENT_PRESENT', { path: candidatePath, ruleId: rule.id })
    }

    const finalRule = matched[matched.length - 1]
    if (finalRule.action === 'exclude') {
      addGroupedError(groupedErrors, 'EXCLUDED_PATH_PRESENT', { path: candidatePath, ruleId: finalRule.id })
    }
  }

  for (const reviewedPath of new Set([...baselinePaths, ...candidatePaths])) {
    const matched = rules.filter(rule => matchesRule(rule, reviewedPath, baselineSet))
    for (let index = 1; index < matched.length; index += 1) {
      const rule = matched[index]
      const unacknowledged = matched.slice(0, index).filter(previous => !rule.overrides.includes(previous.id))
      if (unacknowledged.length > 0) {
        addGroupedError(groupedErrors, 'RULE_OVERLAP_CONFLICT', {
          path: reviewedPath,
          ruleId: rule.id,
          detail: unacknowledged.map(previous => previous.id).sort().join(',')
        })
      }
    }
  }

  for (const rule of rules) {
    const applies = matchedBaselineCounts.get(rule.id) > 0 || matchedCandidateCounts.get(rule.id) > 0
    if (rule.action !== 'conditional-keep' || matchedCandidateCounts.get(rule.id) === 0) continue
    for (const evidence of rule.evidence) {
      if (!evidence || typeof evidence.path !== 'string' || !SHA256.test(evidence.sha256 || '')) {
        addGroupedError(groupedErrors, 'INVALID_EVIDENCE_RECORD', { ruleId: rule.id })
        continue
      }
      if (!candidateSet.has(evidence.path)) {
        addGroupedError(groupedErrors, 'EVIDENCE_PATH_MISSING', { ruleId: rule.id, path: evidence.path })
        continue
      }
      try {
        const actual = sha256(readBlob(repo, immutableCommit, evidence.path))
        if (actual !== evidence.sha256) {
          addGroupedError(groupedErrors, 'EVIDENCE_HASH_MISMATCH', { ruleId: rule.id, path: evidence.path })
        }
      } catch (error) {
        addGroupedError(groupedErrors, error.message, { ruleId: rule.id, path: evidence.path })
      }
    }
  }

  // ---- 台账不变量：NOTICE 判 EXCLUDED 的材料不得出现在发行树里 ----
  //
  // 三次漏出（openai 技能误判、Clio 原件、品牌资产）的共同根因不是"没人想明白"，而是
  // 想明白的结论只写在 Markdown 里，没有任何代码在比对。分类检查能证明"每条路径都被
  // 某条规则覆盖"，证明不了"这条规则归对了类"——fail-closed 只在没人管时生效，管错了
  // 它不响。这一条把台账接进机器，专治后者。
  let ledgerRows = []
  const ledgerExceptions = Array.isArray(policy?.ledgerExceptions) ? policy.ledgerExceptions : []
  const usedExceptions = new Set()
  if (exactCandidate && candidateRead) {
    let ledgerText = null
    try {
      ledgerText = readBlob(repo, immutableCommit, LEDGER_PATH).toString('utf8')
    } catch {
      addGroupedError(groupedErrors, 'LEDGER_UNREADABLE', { detail: LEDGER_PATH })
    }
    if (ledgerText !== null) {
      ledgerRows = parseLedgerExclusions(ledgerText)
      // 解析不出任何 EXCLUDED 行 = 台账改版或被清空。此时"交集为空"是假绿，必须失败。
      if (ledgerRows.length === 0) addGroupedError(groupedErrors, 'LEDGER_NO_EXCLUSIONS_PARSED')
      for (const row of ledgerRows) {
        const matchers = row.globs.flatMap(ledgerGlobMatchers)
        const hits = candidatePaths.filter(candidatePath => matchers.some(re => re.test(candidatePath)))
        if (hits.length === 0) continue
        const exception = ledgerExceptions.find(entry =>
          typeof entry?.rowContains === 'string' && row.material.includes(entry.rowContains)
        )
        const allowed = exception && Array.isArray(exception.allow)
          ? exception.allow.flatMap(ledgerGlobMatchers)
          : []
        const uncovered = hits.filter(hit => !allowed.some(re => re.test(hit)))
        if (exception) usedExceptions.add(exception)
        if (uncovered.length > 0) {
          addGroupedError(groupedErrors, 'LEDGER_EXCLUDED_PATH_PRESENT', {
            detail: row.globs.join(','),
            paths: uncovered,
            count: uncovered.length
          })
        }
      }
      // 悬空豁免：对不上任何 EXCLUDED 行，或它豁免的路径已经不在树里了。留着会让下一个人
      // 以为某件事被处理过。
      for (const entry of ledgerExceptions) {
        if (!usedExceptions.has(entry)) {
          addGroupedError(groupedErrors, 'LEDGER_EXCEPTION_STALE', { detail: String(entry?.rowContains || '') })
        }
      }
    }
  }

  const errors = finishErrors(groupedErrors)
  return {
    schemaVersion: 1,
    policyId: typeof policy?.policyId === 'string' ? policy.policyId : null,
    verdict: errors.length === 0 ? 'PASS' : 'FAIL',
    evidenceOnly: policy?.evidenceOnly === true,
    noClearance: policy?.noClearance === true,
    reviewedBaselineCommit: baselineCommit,
    candidateCommit: exactCandidate ? immutableCommit : null,
    policyBinding: {
      path: POLICY_PATH,
      sha256: policySha256
    },
    ledgerBinding: {
      path: LEDGER_PATH,
      excludedRows: ledgerRows.length,
      exceptions: ledgerExceptions.length
    },
    pathSetBinding: {
      expected: typeof policy?.pathSetSha256 === 'string' ? policy.pathSetSha256 : null,
      actual: baselineCommit ? actualPathSetSha256 : null,
      matches: baselineCommit ? actualPathSetSha256 === policy?.pathSetSha256 : false
    },
    counts: {
      reviewedBaselinePaths: baselinePaths.length,
      candidatePaths: candidatePaths.length,
      rules: rules.length,
      errors: errors.reduce((total, error) => total + error.count, 0)
    },
    rules: rules.map(rule => ({
      id: rule.id,
      action: rule.action,
      scope: rule.scope,
      matchedReviewedBaselinePaths: matchedBaselineCounts.get(rule.id),
      matchedCandidatePaths: matchedCandidateCounts.get(rule.id)
    })),
    errors
  }
}

function parseArguments(argv) {
  const result = { repo: '.', commit: '' }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    const value = argv[index + 1]
    if (argument === '--repo' && value) {
      result.repo = value
      index += 1
    } else if (argument === '--commit' && value) {
      result.commit = value
      index += 1
    } else {
      throw new Error('INVALID_ARGUMENTS')
    }
  }
  return result
}

function failureReport(code) {
  return {
    schemaVersion: 1,
    policyId: null,
    verdict: 'FAIL',
    evidenceOnly: false,
    noClearance: true,
    reviewedBaselineCommit: null,
    candidateCommit: null,
    policyBinding: { path: POLICY_PATH, sha256: null },
    pathSetBinding: { expected: null, actual: null, matches: false },
    counts: { reviewedBaselinePaths: 0, candidatePaths: 0, rules: 0, errors: 1 },
    rules: [],
    errors: [{ code, count: 1 }]
  }
}

function runCli() {
  let report
  try {
    const options = parseArguments(process.argv.slice(2))
    report = verifyOpenSourceCandidate({ repo: options.repo, commit: options.commit })
  } catch (error) {
    const safeCodes = new Set([
      'INVALID_ARGUMENTS',
      'EXACT_COMMIT_REQUIRED',
      'GIT_OBJECT_READ_FAILED',
      'MALFORMED_POLICY',
      'POLICY_NOT_IN_CANDIDATE',
      'UNSUPPORTED_TREE_ENTRY'
    ])
    report = failureReport(safeCodes.has(error?.message) ? error.message : 'VERIFICATION_FAILED')
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  process.exitCode = report.verdict === 'PASS' ? 0 : 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) runCli()
