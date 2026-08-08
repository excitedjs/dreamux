export const meta = {
  name: 'code-review-max',
  description: 'Max-effort PR review: multi-lens finders looped until dry, 3-vote confidence scoring, synthesized report',
  whenToUse: 'Thorough review of a pull request (args.pr) or a local git range (args.target)',
  phases: [
    { title: 'Gate', detail: 'eligibility check with early exit' },
    { title: 'Context', detail: 'CLAUDE.md discovery + change summary' },
    { title: 'Find', detail: '6 lens reviewers per round, until 2 dry rounds' },
    { title: 'Verify', detail: '3-vote 0-100 confidence scoring per finding' },
    { title: 'Report', detail: 'filter >=80 and synthesize the review comment' },
  ],
}

const target = (args && (args.pr || args.target))
if (!target) return { error: 'args.pr (PR number/URL) or args.target (git range) is required' }
const MAX_ROUNDS = (args && args.maxRounds) || 3

const FINDINGS_SCHEMA = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          file: { type: 'string' },
          line: { type: 'integer' },
          title: { type: 'string' },
          detail: { type: 'string' },
          reason: { type: 'string', description: 'why flagged: claude-md | bug | history | prior-pr | comment | security' },
        },
        required: ['file', 'title', 'detail', 'reason'],
        additionalProperties: false,
      },
    },
  },
  required: ['findings'],
  additionalProperties: false,
}

const SCORE_SCHEMA = {
  type: 'object',
  properties: {
    score: { type: 'integer', minimum: 0, maximum: 100 },
    reasoning: { type: 'string' },
  },
  required: ['score', 'reasoning'],
  additionalProperties: false,
}

const RUBRIC =
  '0: Not confident at all. False positive that does not stand up to light scrutiny, or a pre-existing issue.\n' +
  '25: Somewhat confident. Might be real, might be a false positive; could not verify. If stylistic, it is not explicitly called out in the relevant CLAUDE.md.\n' +
  '50: Moderately confident. Verified real, but may be a nitpick or rare in practice; not very important relative to the rest of the change.\n' +
  '75: Highly confident. Double checked; very likely real and will be hit in practice; directly impacts functionality or is directly mentioned in CLAUDE.md.\n' +
  '100: Absolutely certain. Double checked and confirmed; will happen frequently; evidence directly confirms it.'

const FALSE_POSITIVES =
  'Treat as false positives: pre-existing issues; things that look like bugs but are not; pedantic nitpicks; ' +
  'anything a linter/typechecker/compiler/CI would catch; general quality concerns (coverage, docs) unless CLAUDE.md requires them; ' +
  'issues explicitly silenced in code; intentional behavior changes related to the broader change; real issues on unmodified lines.'

function fkey(f) {
  return `${f.file}:${f.line || 0}:${f.title.toLowerCase().replace(/\s+/g, ' ').trim()}`
}

phase('Gate')
const gate = await agent(
  `Inspect ${target}. Answer whether it should be code reviewed. Ineligible if: closed; a draft; ` +
  `an automated or trivial change that is obviously fine; or it already has a review comment from this bot.`,
  {
    label: 'gate',
    phase: 'Gate',
    schema: {
      type: 'object',
      properties: { eligible: { type: 'boolean' }, reason: { type: 'string' } },
      required: ['eligible', 'reason'],
      additionalProperties: false,
    },
  },
)
if (!gate || !gate.eligible) return { skipped: true, reason: gate ? gate.reason : 'gate agent failed' }

phase('Context')
const ctx = await parallel([
  () => agent(
    `For ${target}: return the file paths (NOT contents) of the repository root CLAUDE.md if it exists, ` +
    `plus every CLAUDE.md in directories whose files the change modifies.`,
    {
      label: 'claude-mds', phase: 'Context',
      schema: {
        type: 'object',
        properties: { paths: { type: 'array', items: { type: 'string' } } },
        required: ['paths'],
        additionalProperties: false,
      },
    },
  ),
  () => agent(
    `View ${target} and summarize the change: intent, scope, key files, risk areas. Concise prose.`,
    { label: 'summary', phase: 'Context' },
  ),
])
const claudeMdPaths = (ctx[0] && ctx[0].paths) || []
const summary = ctx[1] || '(summary unavailable)'

const LENSES = [
  { key: 'claude-md', prompt: `Audit the change for compliance with these CLAUDE.md files (read them): ${JSON.stringify(claudeMdPaths)}. CLAUDE.md is guidance for writing code, so not every instruction applies at review time.` },
  { key: 'shallow-bugs', prompt: 'Read only the changed hunks and scan for obvious large bugs. Do not read extra context. Skip small issues and nitpicks.' },
  { key: 'git-history', prompt: 'Read git blame and history of the modified code; flag bugs visible only in light of that historical context (reintroduced bugs, violated invariants).' },
  { key: 'prior-prs', prompt: 'Find previous pull requests touching these files; check review comments on them that also apply to this change.' },
  { key: 'code-comments', prompt: 'Read code comments in the modified files; flag violations of any guidance stated in those comments.' },
  { key: 'security', prompt: 'Review the changed code for concrete, exploitable security issues introduced by this change (injection, authz gaps, secret handling). No generic hardening advice.' },
]

const seen = new Set()
const confirmed = []
let dry = 0
for (let round = 1; round <= MAX_ROUNDS && dry < 2; round++) {
  phase('Find')
  // barrier per round is justified: the dedup + dry-round decision needs all lenses' output
  const found = (await parallel(LENSES.map((l) => () =>
    agent(
      `Code review ${target} through one lens.\n${l.prompt}\n${FALSE_POSITIVES}\n` +
      `Change summary:\n${summary}\n` +
      `Known findings, do NOT repeat any of these:\n${JSON.stringify([...seen])}\n` +
      `Round ${round}: dig where earlier rounds have not.`,
      { label: `find:${l.key}:r${round}`, phase: 'Find', schema: FINDINGS_SCHEMA },
    ),
  ))).filter(Boolean).flatMap((r) => r.findings)

  const fresh = found.filter((f) => !seen.has(fkey(f)))
  if (!fresh.length) { dry++; log(`round ${round}: no new findings (dry ${dry}/2)`); continue }
  dry = 0
  fresh.forEach((f) => seen.add(fkey(f)))
  log(`round ${round}: ${fresh.length} fresh findings -> verification`)

  // findings from this round verify independently; 3-arg stage signature used in stage 2
  const judged = await pipeline(
    fresh,
    (f) => parallel(['does it reproduce on the changed lines', 'is it pre-existing rather than introduced', 'does the cited CLAUDE.md or comment actually say that'].map((lens) => () =>
      agent(
        `Confidence-score this code review finding for ${target}.\n` +
        `Finding: ${JSON.stringify(f)}\nCLAUDE.md files: ${JSON.stringify(claudeMdPaths)}\n` +
        `Focus lens: ${lens}.\n${FALSE_POSITIVES}\nScore with this rubric verbatim:\n${RUBRIC}`,
        { phase: 'Verify', schema: SCORE_SCHEMA },
      ),
    )),
    (votes, f, i) => {
      const ok = (votes || []).filter(Boolean)
      const avg = ok.length ? ok.reduce((s, v) => s + v.score, 0) / ok.length : 0
      return { ...f, confidence: Math.round(avg), votes: ok.length, index: i }
    },
  )
  confirmed.push(...judged.filter(Boolean).filter((f) => f.votes >= 2 && f.confidence >= 80))
  log(`round ${round}: ${confirmed.length} findings at >=80 confidence so far`)
}

phase('Report')
if (!confirmed.length) {
  return { issues: [], report: 'No issues found. Checked for bugs, security, history, and CLAUDE.md compliance.' }
}
const report = await agent(
  `Write the final code review comment for ${target}.\n` +
  `Confirmed issues (JSON): ${JSON.stringify(confirmed)}\n` +
  `Format: "### Code review" heading, "Found N issues:", then a numbered list; each item is a brief ` +
  `description with the flag reason in parentheses and a file#line citation on the next line. ` +
  `Brief, no emojis. Return markdown only.`,
  { label: 'report', phase: 'Report' },
)
return { issues: confirmed, report }
