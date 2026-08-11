# Code Review Workflow

`../SKILL.md` owns the run tools and the script API. This reference owns one
recipe: carrying a full code review as a single `workflow_run` — an eligibility
gate, context collection, independent multi-lens finders repeated until dry,
per-finding confidence scoring, and one severity-ordered synthesized report.

## Contents

- [Stage design](#stage-design) — the stages and their failure accounting
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

1. **Resolve** (range mode only) — one TeamMate pins a fuzzy cumulative target
   ("changes #312 through head") to one exact `base..head` range inside the
   repository; every later prompt receives the resolved target, never the
   fuzzy description. The call is awaited bare: an unresolvable target must
   fail the run, not fan out agents against a guess.
2. **Gate** — one TeamMate checks eligibility and the run exits early when
   review is not needed: the change is closed or a draft, is automated or
   trivially safe, or already carries a review from this Team.
3. **Context** — two TeamMates in parallel: one lists the file paths (not
   contents) of the repository's agent guidance files (`CLAUDE.md`,
   `AGENTS.md`) at the root and in directories the change touches; one
   summarizes the change (intent, scope, risk areas). Both results feed every
   later prompt. When guidance discovery fails, the guidance lens is skipped
   and recorded as missing coverage — it must not audit against a silently
   empty list. A missing summary is tolerable: finders read the change
   themselves, and the placeholder is visible in their prompts.
4. **Find** — independent finder lenses run in parallel, each blind to the
   others: guidance-file compliance, a shallow bug scan limited to the changed
   hunks, git history and blame context, review comments on prior change
   requests touching the same files, guidance stated in code comments of the
   modified files, and concrete security issues introduced by the change. The
   barrier is justified: deduplication needs every lens's output at once —
   and it is where coverage is accounted: lens results are index-aligned with
   the lens list, so a failed lens is recorded as missing coverage instead of
   being silently dropped by `.filter(Boolean)`. Deduplication is by finding
   key against everything SEEN — including the other lenses of the same round,
   so six lenses reporting one defect yield one finding, not six — and never
   against the accepted list, or judge-rejected findings reappear every round
   and the loop never converges. At max effort the find/verify pair repeats as
   rounds: each round's prompts carry every already-seen finding key, and the
   loop records whether it CONVERGED (two consecutive dry rounds) or STOPPED
   AT THE ROUND CAP while findings were still arriving — the two are different
   coverage facts. A round in which every finder fails is recorded and ends
   the loop with the results already accumulated; the hard error is reserved
   for a run that never produced any review output.
5. **Verify** — each fresh finding is scored by verifier TeamMates. Every
   verifier checks ALL acceptance conditions — reproduces on the changed
   lines, introduced by this change rather than pre-existing, and any cited
   guidance or comment actually says what the finding claims — against a
   fixed 0-100 rubric; each verifier additionally carries a distinct emphasis
   so the votes stay diverse. Focus emphasis adds attention; it never removes
   required evidence. Findings advance through `pipeline` independently of
   one another. A finding that keeps fewer than two settled votes is returned
   as `unverified` — verifier failure must not silently launder a finding
   into a clean report. At `max` effort, findings that verify into the 50-79
   band with two settled votes survive as a separate PLAUSIBLE tier instead
   of being silently dropped — broader coverage, explicitly labeled.
6. **Report** — findings that keep at least two settled votes and average 80
   or higher survive; one TeamMate writes the final review comment with a
   one-paragraph verdict first, then confirmed issues grouped by severity,
   then (at max effort) a clearly labeled Plausible section, then an
   Unverified section, then exact coverage gaps. The no-findings message is
   generated from the coverage record — a run with failed lenses or rounds
   never claims "checked all lenses".

The run returns the report plus `coverage` and `unverified` records; the
caller decides where the report goes. When a channel reply tool is available,
post it there; or have a follow-up `send` to the reporter TeamMate publish it
with the forge's own tooling (for example `gh` for GitHub or `glab` for
GitLab) once the operator confirms.

## Effort levels

Match fan-out to what the operator asked for; the script takes an
`args.effort` preset and fails loudly on any other value:

| Preset | Rounds | Verifier votes | Use when |
| --- | --- | --- | --- |
| `quick` | 1 | 2 | a fast sanity pass; both votes must settle, so flakes surface as `unverified` rather than confirmations |
| `standard` (default) | 1 | 3 | a normal pull-request review |
| `max` | up to 3, stop after 2 dry | 3 | "thoroughly audit this", release gates, cumulative range reviews; additionally reports plausible findings (50-79) in a separate, clearly labeled section |

A single-pass preset (`quick`, `standard`) fulfils its coverage promise with
one completed pass; only multi-round runs are held to two-dry-round
convergence, and `coverage.stoppedAtRoundCap` records a multi-round run that
exited any other way.

The evidence standard for CONFIRMATION is constant across presets: every
verifier checks all acceptance conditions, and a confirmed finding always
needs at least two settled votes averaging 80. A lower effort level reduces
vote redundancy and round count — fewer, not weaker, findings. Raising effort
widens coverage: more rounds, more lenses in range mode, and at `max` a
second, clearly labeled PLAUSIBLE tier — findings with two settled votes
averaging 50-79 are returned in `plausible` and reported under their own
heading, never mixed with confirmed issues. Widening reporting to
labeled-uncertain findings is how max broadens coverage without ever
relabeling uncertainty as confirmation.

## Cumulative range mode

Reviewing many merged changes as one diff (a release window, "everything since
tag X") differs from a single change request in two ways, both handled by
`args.rangeMode`:

- **Resolve first.** The script's resolve stage turns a fuzzy target into
  `<baseSha>..<headSha>` inside the repository before any other agent starts
  (find the named squash commit; fall back to the earliest merge at or after
  the named number, since change numbers are not contiguous; base is that
  commit's first parent; an already-exact range passes through unchanged).
  The resolved target is threaded into every later prompt — prompts stay
  self-contained and no agent ever receives the fuzzy description.
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
  outcome for load-bearing calls like the resolver and the gate, and the
  reason both are awaited bare while per-finding work runs inside helpers.

Keep prompts self-contained: a finder must not depend on another finder's
output, and everything a verifier needs (the finding, the rubric, the
false-positive list) is embedded in its prompt.

Instruct finders and verifiers to treat these as false positives: pre-existing
issues; code that looks buggy but is not; pedantic nitpicks; anything a
linter, typechecker, or CI would catch; general quality concerns not required
by a guidance file; issues explicitly silenced in code; intentional behavior
changes related to the broader change; and real issues on lines the change did
not modify.

Every finding must carry a concrete failure scenario — the specific inputs or
state that produce the wrong outcome or crash. A defect that cannot be stated
as a scenario is not reportable; this single requirement kills most
plausible-but-vague findings before verification spends votes on them, and
gives verifiers a concrete claim to check instead of a vibe.

Ask finders for a severity estimate (`high` / `medium` / `low`) alongside each
finding — the field is required and enum-constrained, because the report's
grouping depends on it. Severity is the finder's input for grouping only; the
verifiers' confidence score stays the only acceptance gate, so a "high
severity" label never rescues a low-confidence finding.

## TeamMate budget

One round costs `1 (gate) + 2 (context) + L (find) + votes × findings
(verify) + 1 (report)` TeamMates, plus one resolver in range mode, where `L`
is 6 lenses (7 in range mode). The 1000-TeamMate lifetime cap per run leaves
ample headroom for a single round (hundreds of findings) and comfortably
supports max-effort rounds; still count `L finders + votes × fresh findings`
per extra round before choosing round counts, and match fan-out to what the
operator asked for.

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
    { title: 'resolve', detail: 'range mode: pin a fuzzy target to one exact base..head' },
    { title: 'gate', detail: 'eligibility check with early exit' },
    { title: 'context', detail: 'guidance discovery and change summary' },
    { title: 'find', detail: 'independent finder lenses, repeated until dry at max effort' },
    { title: 'verify', detail: 'confidence scoring per finding' },
    { title: 'report', detail: 'severity-ordered synthesized review comment' },
  ],
};

const input = args || {};
const target = input.target;
// fail-loud paths throw: a normal return settles the run as completed, which
// would make invalid input look like a successful review to automated callers
if (!target) {
  throw new Error('args.target is required: a PR/MR URL or number, a git range, or a working-tree description');
}
const EFFORT = input.effort === undefined ? 'standard' : input.effort;
if (!['quick', 'standard', 'max'].includes(EFFORT)) {
  throw new Error(`invalid effort ${JSON.stringify(EFFORT)}: use quick, standard, or max`);
}
const MAX_ROUNDS = input.maxRounds === undefined
  ? (EFFORT === 'max' ? 3 : 1)
  : input.maxRounds;
if (!Number.isInteger(MAX_ROUNDS) || MAX_ROUNDS < 1 || MAX_ROUNDS > 10) {
  throw new Error(`invalid maxRounds ${JSON.stringify(input.maxRounds)}: use an integer from 1 to 10`);
}
const VOTES = EFFORT === 'quick' ? 2 : 3;
const PLAUSIBLE_TIER = EFFORT === 'max';
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

const ACCEPTANCE_CONDITIONS =
  'Check ALL acceptance conditions before scoring: (1) the defect reproduces on ' +
  'the changed lines of this exact target; (2) it is introduced by this change, ' +
  'not pre-existing; (3) any guidance file or code comment the finding cites ' +
  'actually says what the finding claims; (4) the stated failure scenario is ' +
  'concrete and actually leads to the claimed wrong outcome. A finding failing ' +
  'any condition scores low.';

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
          failureScenario: {
            type: 'string',
            description: 'concrete inputs or state that produce the wrong outcome or crash',
          },
          reason: {
            type: 'string',
            description: 'guidance | bug | history | prior-review | cross-change | comment | security',
          },
          severity: { type: 'string', enum: ['high', 'medium', 'low'] },
        },
        required: ['file', 'title', 'detail', 'failureScenario', 'reason', 'severity'],
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

let reviewTarget = target;
let resolvedRange = null;
if (RANGE_MODE) {
  phase('resolve');
  // awaited bare: an unresolvable target must fail the run, not fan out
  // agents against a guess
  const resolved = await agent(
    `In the repository this workspace can read, resolve this review target into ` +
    `one exact git range:\n${target}\n` +
    `If it names a change number ("changes #312 through head"), find that squash ` +
    `commit; if no commit carries that number, use the earliest merge at or after ` +
    `it (change numbers are not contiguous). The base is that commit's first ` +
    `parent and the head is the branch tip. If the target is already an exact ` +
    `range, return it unchanged. Return the range expression "<baseSha>..<headSha>" ` +
    `and the repository path.`,
    {
      label: 'resolve',
      phase: 'resolve',
      intent: 'Range resolver',
      schema: {
        type: 'object',
        properties: {
          range: { type: 'string' },
          repoPath: { type: 'string' },
        },
        required: ['range'],
        additionalProperties: false,
      },
    },
  );
  if (
    !resolved ||
    typeof resolved.range !== 'string' ||
    !/^\S+\.\.\S+$/.test(resolved.range.trim())
  ) {
    throw new Error(`range resolution failed for ${target}; expected an exact <base>..<head> range`);
  }
  resolvedRange = resolved;
  reviewTarget = resolved.repoPath
    ? `the git range ${resolved.range} in the repository at ${resolved.repoPath}`
    : `the git range ${resolved.range}`;
  log(`resolved target: ${reviewTarget}`);
}

phase('gate');
const gate = await agent(
  `Inspect this change: ${reviewTarget}. Decide whether it should be code reviewed. ` +
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
    `For this change: ${reviewTarget}. List the file paths (NOT contents) of the ` +
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
    `View this change: ${reviewTarget}. Summarize it: intent, scope, key files, risk ` +
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

const emphases = [
  'reproduction on the changed lines',
  'whether it is pre-existing rather than introduced',
  'whether the cited guidance or comment actually says that',
].slice(0, VOTES);

const seen = new Set();
const confirmed = [];
const plausible = [];
const unverified = [];
const roundFailures = [];
let dry = 0;
let completedFinderRounds = 0;
for (let round = 1; round <= MAX_ROUNDS && dry < 2; round++) {
  phase('find');
  // parallel() preserves order, so a null entry identifies the failed lens
  const lensResults = await parallel(activeLenses.map((lens) => () =>
    agent(
      `Code review this change through one lens: ${reviewTarget}\n${lens.prompt}\n` +
      `${FALSE_POSITIVES}\nChange summary:\n${summary}\n` +
      `Every finding must state a concrete failure scenario: the specific inputs ` +
      `or state that produce the wrong outcome or crash. A defect you cannot state ` +
      `as a scenario is not reportable.\n` +
      `Give each finding a severity: high, medium, or low.\n` +
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
  if (failedLenses.length) roundFailures.push({ round, failedLenses });
  if (failedLenses.length === lenses.length) {
    // reserve the hard error for a run in which no finder round ever
    // completed; a clean earlier round is review output worth keeping
    if (completedFinderRounds === 0) {
      throw new Error(`every finder lens failed in round ${round}; the change was not reviewed`);
    }
    log(`round ${round}: every lens failed; stopping with accumulated results`);
    break;
  }
  completedFinderRounds += 1;
  const found = lensResults.filter(Boolean).flatMap((r) => r.findings)
    .filter((f) => f && typeof f.file === 'string' && typeof f.title === 'string');
  // dedupe against everything SEEN — including this round's other lenses, so
  // one defect reported by six lenses becomes one finding — and never against
  // the accepted list, or judge-rejected findings reappear every round and
  // the loop never converges
  const fresh = [];
  for (const f of found) {
    const key = findingKey(f);
    if (!seen.has(key)) {
      seen.add(key);
      fresh.push(f);
    }
  }
  if (!fresh.length) {
    dry += 1;
    log(`round ${round}: no fresh findings (dry ${dry}/2)`);
    continue;
  }
  dry = 0;
  log(`round ${round}: ${fresh.length} fresh findings`);

  phase('verify');
  const judged = await pipeline(
    fresh,
    (finding) => parallel(emphases.map((emphasis) => () =>
      agent(
        `Confidence-score this code review finding for the change: ${reviewTarget}\n` +
        `Finding: ${JSON.stringify(finding)}\n` +
        `Guidance files: ${JSON.stringify(guidancePaths)}\n` +
        `${ACCEPTANCE_CONDITIONS}\n` +
        `Your particular emphasis: ${emphasis}.\n${FALSE_POSITIVES}\n` +
        `Score with this rubric verbatim:\n${RUBRIC}`,
        { phase: 'verify', intent: 'Finding verifier', schema: SCORE_SCHEMA },
      ),
    )),
    (votes, finding, index) => {
      const settled = (votes || []).filter((v) => v && typeof v.score === 'number');
      const average = settled.length
        ? settled.reduce((sum, vote) => sum + vote.score, 0) / settled.length
        : 0;
      // tier on the raw mean; display at one decimal so the shown confidence
      // never crosses a tier boundary (79.67 tiers plausible and shows 79.7,
      // not 80 — integer votes make one-decimal display tier-safe)
      const tier = settled.length < 2
        ? 'unverified'
        : average >= 80
          ? 'confirmed'
          : PLAUSIBLE_TIER && average >= 50
            ? 'plausible'
            : 'rejected';
      return { ...finding, confidence: Math.round(average * 10) / 10, votes: settled.length, tier, index };
    },
  );
  // pipeline() results are index-aligned with `fresh`: a null entry or a
  // finding with fewer than two settled votes is unverified, not clean
  for (let i = 0; i < fresh.length; i++) {
    const j = judged[i];
    if (!j || j.tier === 'unverified') unverified.push(fresh[i]);
    else if (j.tier === 'confirmed') confirmed.push(j);
    else if (j.tier === 'plausible') plausible.push(j);
  }
  log(`round ${round}: ${confirmed.length} confirmed, ${plausible.length} plausible, ${unverified.length} unverified total`);
}

// a single-pass preset fulfils its coverage promise in one completed pass;
// only multi-round runs require two consecutive dry rounds, and exiting a
// multi-round run any other way (round cap, a failed round) is recorded even
// when the final round happened to be dry
const stoppedAtRoundCap = MAX_ROUNDS > 1 && dry < 2;
const coverage = {
  complete: !guidanceFailed && roundFailures.length === 0 &&
    unverified.length === 0 && !stoppedAtRoundCap,
  guidanceDiscoveryFailed: guidanceFailed,
  roundFailures,
  stoppedAtRoundCap,
  unverifiedFindings: unverified.length,
};

phase('report');
if (!confirmed.length && !plausible.length) {
  const gaps = [];
  if (guidanceFailed) gaps.push('guidance discovery failed');
  if (roundFailures.length) {
    gaps.push(`lens failures: ${roundFailures.map((r) => `round ${r.round} (${r.failedLenses.join(', ')})`).join('; ')}`);
  }
  if (stoppedAtRoundCap) gaps.push('stopped before two-dry-round convergence');
  if (unverified.length) gaps.push(`${unverified.length} finding(s) unverified after verifier failures`);
  const report = gaps.length
    ? `No issues confirmed. ${gaps.join('; ')}. See coverage and unverified for details.`
    : 'No issues found. Checked all lenses across all rounds.';
  return { issues: [], plausible, unverified, coverage, resolvedRange, report };
}
const report = await agent(
  `Write the final code review comment for the change: ${reviewTarget}\n` +
  `Confirmed issues (JSON): ${JSON.stringify(confirmed)}\n` +
  `Plausible findings — two settled votes at 50-79 confidence, unconfirmed (JSON): ${JSON.stringify(plausible)}\n` +
  `Unverified findings — verifiers failed, no confidence claim (JSON): ${JSON.stringify(unverified)}\n` +
  `Coverage (JSON): ${JSON.stringify(coverage)}\n` +
  `Structure: a "### Code review" heading; a one-paragraph verdict on the change ` +
  `as a whole (when nothing is confirmed, say so plainly); then confirmed issues ` +
  `grouped by severity (high, then medium, then low) as numbered items, each with ` +
  `the flag reason in parentheses, its failure scenario, and a citation on the ` +
  `next line — file#line when the finding carries a line number, the file path ` +
  `alone otherwise; never invent a line number. If there are plausible findings, ` +
  `add a "Plausible (unconfirmed)" section after the confirmed issues with the ` +
  `same per-item detail (title, citation, failure scenario, stated confidence), ` +
  `never presenting them as confirmed. If there are unverified findings, add a ` +
  `short "Unverified" section listing them without confidence claims. End with ` +
  `one line stating coverage gaps exactly (failed lenses per round, guidance ` +
  `discovery, convergence status, unverified count). Brief, no emojis. ` +
  `Return markdown only.`,
  { label: 'report', phase: 'report', intent: 'Review report writer' },
);
return { issues: confirmed, plausible, unverified, coverage, resolvedRange, report };
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

The other `args` fields are optional and validated before any agent starts:
`effort` must be `'quick'`, `'standard'`, or `'max'`; `maxRounds` must be an
integer from 1 to 10 and overrides the preset's round cap; `rangeMode` runs
the resolve stage first and adds the cross-change lens plus the range-scoped
false-positive rule. `agentType` follows the runtime default unless each call
is given one explicitly.

`max_concurrency` defaults to 16; lower it only when the workspace or runtime
provider needs gentler fan-out. After the terminal completion, read `issues`
for the confirmed findings, `plausible` for max-effort findings in the 50-79
band (labeled, never mixed with confirmed), `unverified` for findings whose
verifiers failed,
`coverage` for whether every lens ran in every round, the loop converged
rather than stopping at the round cap, and every finding was verified,
`resolvedRange` for the exact range in range mode, and `report` for the
formatted comment; use the reporter TeamMate's concrete name with `send` for
follow-ups such as posting the comment through the forge's tooling or
re-checking one finding interactively.
