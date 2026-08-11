# Code Review Workflow

`../SKILL.md` owns the run tools and the script API. This reference owns one
recipe: carrying a full code review as a single `workflow_run` — an eligibility
gate, context collection, independent multi-lens finders repeated until dry,
per-finding confidence scoring, and one severity-ordered synthesized report.

## Contents

- [Stage design](#stage-design) — the five stages and their failure accounting
- [Effort levels](#effort-levels) — quick / standard / max presets
- [Cumulative range mode](#cumulative-range-mode) — reviewing many merged
  changes as one diff
- [Prompt discipline](#prompt-discipline) — output contract, rejection
  semantics, self-contained prompts
- [TeamMate budget](#teammate-budget) — cost arithmetic against the run caps
- [Script](#script) — the complete runnable script
- [Invocation](#invocation) — call shape and result fields

The review target is any change the Team workspace can read: a GitHub pull
request, a GitLab merge request, a local branch or commit range, or an
uncommitted working-tree diff. Use this recipe when the operator wants one
terminal result for such a change. For interactive review — where the next
instruction depends on reading the previous finding — use `spawn` and `send`
instead.

## Stage design

1. **Gate** — one TeamMate checks eligibility and the run exits early when
   review is not needed: the change is closed or a draft, is automated or
   trivially safe, or already carries a review from this Team.
2. **Context** — two TeamMates in parallel: one lists the file paths (not
   contents) of the repository's agent guidance files (`CLAUDE.md`,
   `AGENTS.md`) at the root and in directories the change touches; one
   summarizes the change (intent, scope, risk areas). Both results feed every
   later prompt. When guidance discovery fails, the guidance lens is skipped
   and recorded as missing coverage — it must not audit against a silently
   empty list. A missing summary is tolerable: finders read the change
   themselves, and the placeholder is visible in their prompts.
3. **Find** — independent finder lenses run in parallel, each blind to the
   others: guidance-file compliance, a shallow bug scan limited to the changed
   hunks, git history and blame context, review comments on prior change
   requests touching the same files, guidance stated in code comments of the
   modified files, and concrete security issues introduced by the change. The
   barrier is justified: deduplication needs every lens's output at once —
   and it is where coverage is accounted: lens results are index-aligned with
   the lens list, so a failed lens is recorded as missing coverage instead of
   being silently dropped by `.filter(Boolean)`. At max effort the find/verify
   pair repeats as rounds: each round's prompts carry every already-seen
   finding key, and the loop stops after two consecutive rounds produce
   nothing fresh (or at the round cap). Fixed single passes miss the tail of
   an unknown-size finding population; deduplicate each round against
   everything SEEN, never against the accepted list, or judge-rejected
   findings reappear every round and the loop never converges.
4. **Verify** — each fresh finding is scored by verifier TeamMates with
   distinct focus questions (does it reproduce on the changed lines; is it
   pre-existing rather than introduced; does the cited guidance actually say
   that), using a fixed 0-100 rubric. Findings advance through `pipeline`
   independently of one another: each finding's vote aggregation follows its
   own votes without waiting for the other findings. A finding that keeps
   fewer than two settled votes is returned as `unverified` — verifier
   failure must not silently launder a finding into a clean report.
5. **Report** — findings that keep at least two settled votes and average 80
   or higher survive; one TeamMate writes the final review comment with a
   one-paragraph verdict first, then issues grouped by severity, then an
   Unverified section, then exact coverage gaps.

The run returns the report plus `coverage` and `unverified` records; the
caller decides where the report goes. When a channel reply tool is available,
post it there; or have a follow-up `send` to the reporter TeamMate publish it
with the forge's own tooling (for example `gh` for GitHub or `glab` for
GitLab) once the operator confirms.

## Effort levels

Match fan-out to what the operator asked for; the script takes an
`args.effort` preset:

| Preset | Rounds | Verifier votes | Use when |
| --- | --- | --- | --- |
| `quick` | 1 | 2 | a fast sanity pass; both votes must settle, so flakes surface as `unverified` rather than confirmations |
| `standard` (default) | 1 | 3 | a normal pull-request review |
| `max` | up to 3, stop after 2 dry | 3 | "thoroughly audit this", release gates, cumulative range reviews |

The confirmation bar is constant across presets — at least two settled votes
and an average of 80 — so a lower effort level produces fewer, not weaker,
findings. Raising effort widens coverage (more rounds, more lenses in range
mode); it never lowers the evidence standard.

## Cumulative range mode

Reviewing many merged changes as one diff (a release window, "everything since
tag X") differs from a single change request in two ways, both handled by
`args.rangeMode`:

- **Resolve first.** When the target is a description like "PRs #312 through
  head" rather than an exact range, add a resolve TeamMate ahead of the gate
  that turns it into `<baseSha>..<headSha>` inside the repository (find the
  named squash commit; fall back to the earliest merge at or after the named
  number, since PR numbers are not contiguous; base is that commit's first
  parent). Pass the resolved range through returned values — later prompts
  must be self-contained.
- **The cross-change lens.** A range contains changes that evolved the same
  subsystems in sequence, so range mode adds a seventh finder lens looking
  specifically for bad interactions BETWEEN the changes: a later change
  silently invalidating an earlier one's assumption, dead code or docs left
  behind by a superseding change, contradictory contracts between commits,
  deleted-then-still-referenced symbols, and stale statements that only made
  sense mid-range. The false-positive list also shifts: behavior an earlier
  change introduced and a later change in the same range deliberately replaced
  is not a finding.

## Prompt discipline

Every workflow TeamMate receives the workflow output contract: its final
response is the value `agent()` returns, not a human-facing message. Prompts
can therefore ask for data directly, without output-format boilerplate. With
`schema`, the runtime's native structured-output mechanism enforces the shape.

Failure semantics drive the script structure:

- An ordinary failed turn settles the `agent()` call to `null`. `parallel`
  and `pipeline` contain per-item failures as `null` entries and keep results
  index-aligned with their inputs — account required coverage positionally
  first (which lens failed in which round, which finding lost its verifiers),
  then drop nulls with `.filter(Boolean)` only where item identity no longer
  matters.
- A schema call rejects — it does not return `null` — when the runtime cannot
  provide structured output or reports success with an empty or invalid JSON
  result. A directly awaited rejection fails the whole run; that is the right
  outcome for load-bearing calls like the gate, and the reason the gate below
  is awaited bare while per-finding work runs inside helpers.

Keep prompts self-contained: a finder must not depend on another finder's
output, and everything a verifier needs (the finding, the rubric, the
false-positive list) is embedded in its prompt.

Instruct finders and verifiers to treat these as false positives: pre-existing
issues; code that looks buggy but is not; pedantic nitpicks; anything a
linter, typechecker, or CI would catch; general quality concerns not required
by a guidance file; issues explicitly silenced in code; intentional behavior
changes related to the broader change; and real issues on lines the change did
not modify.

Ask finders for a severity estimate (`high` / `medium` / `low`) alongside each
finding. Severity is the finder's input for the report's grouping; the
verifiers' confidence score stays the only acceptance gate, so a "high
severity" label never rescues a low-confidence finding.

## TeamMate budget

One round costs `1 (gate) + 2 (context) + L (find) + votes × findings
(verify) + 1 (report)` TeamMates, where `L` is 6 lenses (7 in range mode).
The 1000-TeamMate lifetime cap per run leaves ample headroom for a single
round (hundreds of findings) and comfortably supports max-effort rounds; still
count `L finders + votes × fresh findings` per extra round before choosing
round counts, and match fan-out to what the operator asked for.

## Script

The script uses the top-level entry: the body follows `export const meta`
directly, and `await` and early `return` work at top level. Constants and helper
functions remain in the same private async execution scope, so normal function
hoisting applies exactly as written.

```js
export const meta = {
  name: 'code-review',
  description: 'Multi-lens code review with confidence-scored findings and one report',
  whenToUse: 'One-shot review of a change request, git range, or working-tree diff.',
  phases: [
    { title: 'gate', detail: 'eligibility check with early exit' },
    { title: 'context', detail: 'guidance discovery and change summary' },
    { title: 'find', detail: 'independent finder lenses, repeated until dry at max effort' },
    { title: 'verify', detail: 'confidence scoring per finding' },
    { title: 'report', detail: 'severity-ordered synthesized review comment' },
  ],
};

const input = args || {};
const target = input.target;
if (!target) {
  return { error: 'args.target is required: a PR/MR URL or number, a git range, or a working-tree description' };
}
const EFFORT = input.effort || 'standard'; // quick | standard | max
const MAX_ROUNDS = input.maxRounds || (EFFORT === 'max' ? 3 : 1);
const VOTES = EFFORT === 'quick' ? 2 : 3;
const RANGE_MODE = Boolean(input.rangeMode);

const FALSE_POSITIVES =
  'Treat as false positives: pre-existing issues; code that looks buggy but is not; ' +
  'pedantic nitpicks; anything a linter, typechecker, or CI would catch; general ' +
  'quality concerns (coverage, docs) unless a guidance file (CLAUDE.md, AGENTS.md) ' +
  'requires them; issues explicitly silenced in code; intentional behavior changes ' +
  'related to the broader change; real issues on unmodified lines.' +
  (RANGE_MODE
    ? ' Behavior an earlier change introduced and a later change in this same range deliberately replaced is not a finding.'
    : '');

const RUBRIC =
  '0: Not confident at all. False positive that does not stand up to light scrutiny, or a pre-existing issue.\n' +
  '25: Somewhat confident. Might be real, might be a false positive; could not verify. If stylistic, it is not explicitly called out in a relevant guidance file (CLAUDE.md, AGENTS.md).\n' +
  '50: Moderately confident. Verified real, but may be a nitpick or rare in practice; not very important relative to the rest of the change.\n' +
  '75: Highly confident. Double checked; very likely real and will be hit in practice; directly impacts functionality or is directly mentioned in a guidance file.\n' +
  '100: Absolutely certain. Double checked and confirmed; will happen frequently; evidence directly confirms it.';

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
          reason: {
            type: 'string',
            description: 'guidance | bug | history | prior-review | cross-change | comment | security',
          },
          severity: { type: 'string', description: 'high | medium | low' },
        },
        required: ['file', 'title', 'detail', 'reason'],
        additionalProperties: false,
      },
    },
  },
  required: ['findings'],
  additionalProperties: false,
};

const SCORE_SCHEMA = {
  type: 'object',
  properties: {
    score: { type: 'integer', minimum: 0, maximum: 100 },
    reasoning: { type: 'string' },
  },
  required: ['score', 'reasoning'],
  additionalProperties: false,
};

function findingKey(f) {
  return `${f.file}:${f.line || 0}:${f.title.toLowerCase().replace(/\s+/g, ' ').trim()}`;
}

phase('gate');
const gate = await agent(
  `Inspect this change: ${target}. Decide whether it should be code reviewed. ` +
  `Ineligible if: closed; a draft; an automated or trivial change that is ` +
  `obviously fine; or it already has a review comment from this Team.`,
  {
    label: 'gate',
    phase: 'gate',
    intent: 'Review eligibility gate',
    schema: {
      type: 'object',
      properties: { eligible: { type: 'boolean' }, reason: { type: 'string' } },
      required: ['eligible', 'reason'],
      additionalProperties: false,
    },
  },
);
if (!gate || !gate.eligible) {
  return { skipped: true, reason: gate ? gate.reason : 'gate TeamMate failed' };
}

phase('context');
const ctx = await parallel([
  () => agent(
    `For this change: ${target}. List the file paths (NOT contents) of the ` +
    `repository's agent guidance files — CLAUDE.md and AGENTS.md — at the ` +
    `repository root and in directories whose files the change modifies.`,
    {
      label: 'guidance',
      phase: 'context',
      intent: 'Guidance file discovery',
      schema: {
        type: 'object',
        properties: { paths: { type: 'array', items: { type: 'string' } } },
        required: ['paths'],
        additionalProperties: false,
      },
    },
  ),
  () => agent(
    `View this change: ${target}. Summarize it: intent, scope, key files, risk ` +
    `areas. Concise prose only.`,
    { label: 'summary', phase: 'context', intent: 'Change summarizer' },
  ),
]);
// a null discovery result is a coverage gap, distinct from a successful
// empty list (a repo that simply has no guidance files)
const guidanceFailed = !ctx[0];
const guidancePaths = guidanceFailed ? [] : ctx[0].paths;
const summary = ctx[1] || '(summary unavailable)';

const lenses = [
  { key: 'guidance', prompt: `Audit the change for compliance with these guidance files (read them): ${JSON.stringify(guidancePaths)}. Guidance files direct code writing, so not every instruction applies at review time.` },
  { key: 'shallow-bugs', prompt: 'Read only the changed hunks and scan for obvious large bugs. Do not read extra context. Skip small issues and nitpicks.' },
  { key: 'git-history', prompt: 'Read git blame and history of the modified code; flag bugs visible only in light of that historical context, such as reintroduced bugs or violated invariants.' },
  { key: 'prior-reviews', prompt: 'Find previous change requests (pull/merge requests) touching these files; check review comments on them that also apply to this change.' },
  { key: 'code-comments', prompt: 'Read code comments in the modified files; flag violations of guidance stated in those comments.' },
  { key: 'security', prompt: 'Review the changed code for concrete, exploitable security issues introduced by this change (injection, authorization gaps, secret handling). No generic hardening advice.' },
];
if (RANGE_MODE) {
  lenses.push({
    key: 'cross-change',
    prompt:
      'This target is a cumulative range of many merged changes evolving the same ' +
      'subsystems. Look specifically for bad interactions BETWEEN the changes: a later ' +
      'change silently invalidating an earlier one\'s assumption, dead code or docs ' +
      'left behind by a superseding change, contradictory contracts between commits, ' +
      'deleted-then-still-referenced symbols, and stale statements that only made ' +
      'sense mid-range.',
  });
}
// without discovered guidance files the guidance lens has nothing real to
// audit — skip it and record the gap instead of auditing an empty list
const activeLenses = guidanceFailed
  ? lenses.filter((lens) => lens.key !== 'guidance')
  : lenses;

const focusQuestions = [
  'does it reproduce on the changed lines',
  'is it pre-existing rather than introduced by this change',
  'does the cited guidance file or code comment actually say that',
].slice(0, VOTES);

const seen = new Set();
const confirmed = [];
const unverified = [];
const roundFailures = [];
let dry = 0;
for (let round = 1; round <= MAX_ROUNDS && dry < 2; round++) {
  phase('find');
  // parallel() preserves order, so a null entry identifies the failed lens
  const lensResults = await parallel(activeLenses.map((lens) => () =>
    agent(
      `Code review this change through one lens: ${target}\n${lens.prompt}\n` +
      `${FALSE_POSITIVES}\nChange summary:\n${summary}\n` +
      `Estimate severity (high/medium/low) for each finding.\n` +
      `Known findings, do NOT repeat any of these keys:\n${JSON.stringify([...seen])}\n` +
      `Round ${round}: dig where earlier rounds have not.`,
      {
        label: `find-${lens.key}-r${round}`,
        phase: 'find',
        intent: `Finder lens: ${lens.key}`,
        schema: FINDINGS_SCHEMA,
      },
    ),
  ));
  const failedLenses = [
    ...(guidanceFailed ? ['guidance'] : []),
    ...activeLenses.filter((lens, i) => !lensResults[i]).map((lens) => lens.key),
  ];
  if (failedLenses.length === lenses.length) {
    return { error: 'every finder lens failed; the change was not reviewed', failedLenses };
  }
  if (failedLenses.length) roundFailures.push({ round, failedLenses });
  const found = lensResults.filter(Boolean).flatMap((r) => r.findings)
    .filter((f) => f && typeof f.file === 'string' && typeof f.title === 'string');
  // dedupe against everything SEEN, not against the accepted list, or
  // judge-rejected findings reappear every round and the loop never converges
  const fresh = found.filter((f) => !seen.has(findingKey(f)));
  if (!fresh.length) {
    dry += 1;
    log(`round ${round}: no fresh findings (dry ${dry}/2)`);
    continue;
  }
  dry = 0;
  fresh.forEach((f) => seen.add(findingKey(f)));
  log(`round ${round}: ${fresh.length} fresh findings`);

  phase('verify');
  const judged = await pipeline(
    fresh,
    (finding) => parallel(focusQuestions.map((focus) => () =>
      agent(
        `Confidence-score this code review finding for the change: ${target}\n` +
        `Finding: ${JSON.stringify(finding)}\n` +
        `Guidance files: ${JSON.stringify(guidancePaths)}\n` +
        `Focus question: ${focus}.\n${FALSE_POSITIVES}\n` +
        `Score with this rubric verbatim:\n${RUBRIC}`,
        { phase: 'verify', intent: 'Finding verifier', schema: SCORE_SCHEMA },
      ),
    )),
    (votes, finding, index) => {
      const settled = (votes || []).filter((v) => v && typeof v.score === 'number');
      const average = settled.length
        ? settled.reduce((sum, vote) => sum + vote.score, 0) / settled.length
        : 0;
      return { ...finding, confidence: Math.round(average), votes: settled.length, index };
    },
  );
  // pipeline() results are index-aligned with `fresh`: a null entry or a
  // finding with fewer than two settled votes is unverified, not clean
  for (let i = 0; i < fresh.length; i++) {
    const j = judged[i];
    if (!j || j.votes < 2) unverified.push(fresh[i]);
    else if (j.confidence >= 80) confirmed.push(j);
  }
  log(`round ${round}: ${confirmed.length} confirmed total, ${unverified.length} unverified total`);
}

const coverage = {
  complete: !guidanceFailed && roundFailures.length === 0 && unverified.length === 0,
  guidanceDiscoveryFailed: guidanceFailed,
  roundFailures,
  unverifiedFindings: unverified.length,
};

phase('report');
if (!confirmed.length) {
  const report = unverified.length
    ? `No issues confirmed. ${unverified.length} finding(s) could not be verified (verifier failures) and are returned in \`unverified\` for manual triage.`
    : 'No issues found. Checked all lenses across all rounds.';
  return { issues: [], unverified, coverage, report };
}
const report = await agent(
  `Write the final code review comment for the change: ${target}\n` +
  `Confirmed issues (JSON): ${JSON.stringify(confirmed)}\n` +
  `Unverified findings — verifiers failed, no confidence claim (JSON): ${JSON.stringify(unverified)}\n` +
  `Coverage (JSON): ${JSON.stringify(coverage)}\n` +
  `Structure: a "### Code review" heading; a one-paragraph verdict on the change ` +
  `as a whole; then issues grouped by severity (high, then medium, then low) as ` +
  `numbered items, each with the flag reason in parentheses and a citation on ` +
  `the next line — file#line when the finding carries a line number, the file ` +
  `path alone otherwise; never invent a line number. If there are unverified ` +
  `findings, add a short "Unverified" section listing them without confidence ` +
  `claims. End with one line stating coverage gaps exactly (failed lenses per ` +
  `round, guidance discovery, unverified count). Brief, no emojis. ` +
  `Return markdown only.`,
  { label: 'report', phase: 'report', intent: 'Review report writer' },
);
return { issues: confirmed, unverified, coverage, report };
```

The verify stage shows the three-argument stage signature: stage one returns
only the vote array, and stage two recovers the finding and its position from
`(votes, finding, index)` instead of threading them through the return value.

## Invocation

```
workflow_run({
  script: <the script above>,
  args: { target: 'https://github.com/owner/repo/pull/123' },
})
```

`args.target` is forge-neutral — pass whatever identifies the change in the
Team workspace:

- a pull-request or merge-request URL or number
  (`'https://gitlab.example.com/group/repo/-/merge_requests/45'`, `'#123'`);
- a local git range (`'main...feature'`);
- a working-tree description (`'the uncommitted diff in the workspace'`).

The other `args` fields are optional: `effort` (`'quick'` / `'standard'` /
`'max'`), `maxRounds` (overrides the preset's round cap), and `rangeMode`
(adds the cross-change lens and the range-scoped false-positive rule; pair it
with a resolve step per [Cumulative range mode](#cumulative-range-mode) when
the target is not yet an exact range). `agentType` follows the runtime default
unless each call is given one explicitly.

`max_concurrency` defaults to 16; lower it only when the workspace or runtime
provider needs gentler fan-out. After the terminal completion, read `issues`
for the confirmed findings, `unverified` for findings whose verifiers failed,
`coverage` for whether every lens ran in every round and every finding was
verified, and `report` for the formatted comment; use the reporter TeamMate's
concrete name with `send` for follow-ups such as posting the comment through
the forge's tooling or re-checking one finding interactively.
