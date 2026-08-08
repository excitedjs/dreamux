# Code Review Workflow

`../SKILL.md` owns the run tools and the script API. This reference owns one
recipe: carrying a full code review as a single `workflow_run`, modeled on the
staged flow of the official Claude Code `code-review` plugin — eligibility gate,
context collection, independent multi-lens finders, per-finding confidence
scoring, and one synthesized report.

Use it when the operator asks to review a pull request or a git range and wants
one terminal result rather than an interactive back-and-forth. For interactive
review — where the next instruction depends on reading the previous finding —
use `spawn` and `send` instead.

## Stage design

1. **Gate** — one agent checks eligibility and the run exits early when review
   is not needed: the change is closed or a draft, is automated or trivially
   safe, or already carries a review from this Team.
2. **Context** — two agents in parallel: one lists the file paths (not
   contents) of the root `CLAUDE.md` and any `CLAUDE.md` in directories the
   change touches; one summarizes the change (intent, scope, risk areas). Both
   results feed every later prompt.
3. **Find** — independent finder lenses run in parallel, each blind to the
   others: `CLAUDE.md` compliance, a shallow bug scan limited to the changed
   hunks, git history and blame context, review comments on prior pull requests
   touching the same files, guidance stated in code comments of the modified
   files, and concrete security issues introduced by the change. The barrier is
   justified: deduplication needs every lens's output at once.
4. **Verify** — each unique finding is scored by three agents with distinct
   focus questions (does it reproduce on the changed lines; is it pre-existing
   rather than introduced; does the cited guidance actually say that), using a
   fixed 0-100 rubric. Findings advance through `pipeline` independently — a
   finding from a fast lens is verified while slower work continues.
5. **Report** — findings that keep at least two settled votes and average 80 or
   higher survive; one agent formats the final review comment.

The run returns the report; the caller decides where it goes. Post it through
the channel, or have a follow-up `send` to the reporter TeamMate publish it
(for example with `gh pr comment`) once the operator confirms.

## Prompt discipline

Workflow TeamMates are ordinary TeamMates: without instruction they answer like
a chat reply. Every `schema` call must therefore end with an explicit output
contract — "Return ONLY the JSON object. No prose, no markdown, no code
fences." — because a result that does not parse as JSON settles that `agent()`
call to `null` with no retry. Keep prompts self-contained: a finder must not
depend on another finder's output, and everything a verifier needs (the
finding, the rubric, the false-positive list) is embedded in its prompt.

Instruct finders and verifiers to treat these as false positives: pre-existing
issues; code that looks buggy but is not; pedantic nitpicks; anything a linter,
typechecker, or CI would catch; general quality concerns not required by a
`CLAUDE.md`; issues explicitly silenced in code; intentional behavior changes
related to the broader change; and real issues on lines the change did not
modify.

## Agent budget

One round costs `1 (gate) + 2 (context) + 6 (find) + 3 × findings (verify) +
1 (report)` agents. With the 200-agent lifetime cap, a single round supports
roughly 60 unique findings. Add repeat-until-dry rounds only when the operator
asks for exhaustive coverage, and re-check the budget: each extra round adds
6 finders plus 3 verifiers per fresh finding.

## Script

```js
export const meta = {
  name: 'code-review',
  description: 'Multi-lens code review with confidence-scored findings and one report',
  phases: ['gate', 'context', 'find', 'verify', 'report'],
};

const JSON_ONLY =
  'Return ONLY the JSON object. No prose, no markdown, no code fences.';

const FALSE_POSITIVES =
  'Treat as false positives: pre-existing issues; code that looks buggy but is not; ' +
  'pedantic nitpicks; anything a linter, typechecker, or CI would catch; general ' +
  'quality concerns (coverage, docs) unless a CLAUDE.md requires them; issues ' +
  'explicitly silenced in code; intentional behavior changes related to the broader ' +
  'change; real issues on unmodified lines.';

const RUBRIC =
  '0: Not confident at all. False positive that does not stand up to light scrutiny, or a pre-existing issue.\n' +
  '25: Somewhat confident. Might be real, might be a false positive; could not verify. If stylistic, it is not explicitly called out in the relevant CLAUDE.md.\n' +
  '50: Moderately confident. Verified real, but may be a nitpick or rare in practice; not very important relative to the rest of the change.\n' +
  '75: Highly confident. Double checked; very likely real and will be hit in practice; directly impacts functionality or is directly mentioned in CLAUDE.md.\n' +
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
            description: 'claude-md | bug | history | prior-pr | comment | security',
          },
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

export default async function run() {
  const target = args && (args.pr || args.target);
  if (!target) return { error: 'args.pr (PR number/URL) or args.target (git range) is required' };

  phase('gate');
  const gate = await agent(
    `Inspect ${target}. Decide whether it should be code reviewed. Ineligible if: ` +
    `closed; a draft; an automated or trivial change that is obviously fine; or it ` +
    `already has a review comment from this Team. ${JSON_ONLY}`,
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
    return { skipped: true, reason: gate ? gate.reason : 'gate agent failed' };
  }

  phase('context');
  const ctx = await parallel([
    () => agent(
      `For ${target}: list the file paths (NOT contents) of the repository root ` +
      `CLAUDE.md if it exists, plus every CLAUDE.md in directories whose files the ` +
      `change modifies. ${JSON_ONLY}`,
      {
        label: 'claude-mds',
        phase: 'context',
        intent: 'CLAUDE.md discovery',
        schema: {
          type: 'object',
          properties: { paths: { type: 'array', items: { type: 'string' } } },
          required: ['paths'],
          additionalProperties: false,
        },
      },
    ),
    () => agent(
      `View ${target} and summarize the change: intent, scope, key files, risk ` +
      `areas. Concise prose only.`,
      { label: 'summary', phase: 'context', intent: 'Change summarizer' },
    ),
  ]);
  const claudeMdPaths = (ctx[0] && ctx[0].paths) || [];
  const summary = ctx[1] || '(summary unavailable)';

  const lenses = [
    { key: 'claude-md', prompt: `Audit the change for compliance with these CLAUDE.md files (read them): ${JSON.stringify(claudeMdPaths)}. CLAUDE.md guides code writing, so not every instruction applies at review time.` },
    { key: 'shallow-bugs', prompt: 'Read only the changed hunks and scan for obvious large bugs. Do not read extra context. Skip small issues and nitpicks.' },
    { key: 'git-history', prompt: 'Read git blame and history of the modified code; flag bugs visible only in light of that historical context, such as reintroduced bugs or violated invariants.' },
    { key: 'prior-prs', prompt: 'Find previous pull requests touching these files; check review comments on them that also apply to this change.' },
    { key: 'code-comments', prompt: 'Read code comments in the modified files; flag violations of guidance stated in those comments.' },
    { key: 'security', prompt: 'Review the changed code for concrete, exploitable security issues introduced by this change (injection, authorization gaps, secret handling). No generic hardening advice.' },
  ];

  phase('find');
  const found = (await parallel(lenses.map((lens) => () =>
    agent(
      `Code review ${target} through one lens.\n${lens.prompt}\n${FALSE_POSITIVES}\n` +
      `Change summary:\n${summary}\n${JSON_ONLY}`,
      {
        label: `find-${lens.key}`,
        phase: 'find',
        intent: `Finder lens: ${lens.key}`,
        schema: FINDINGS_SCHEMA,
      },
    ),
  ))).filter(Boolean).flatMap((r) => r.findings);

  const seen = new Set();
  const unique = [];
  for (const f of found) {
    const key = findingKey(f);
    if (!seen.has(key)) { seen.add(key); unique.push(f); }
  }
  log(`${found.length} raw findings, ${unique.length} unique`);
  if (!unique.length) {
    return { issues: [], report: 'No issues found. Checked for bugs, security, history, and CLAUDE.md compliance.' };
  }

  phase('verify');
  const focusQuestions = [
    'does it reproduce on the changed lines',
    'is it pre-existing rather than introduced by this change',
    'does the cited CLAUDE.md or code comment actually say that',
  ];
  const judged = await pipeline(
    unique,
    (finding) => parallel(focusQuestions.map((focus) => () =>
      agent(
        `Confidence-score this code review finding for ${target}.\n` +
        `Finding: ${JSON.stringify(finding)}\n` +
        `CLAUDE.md files: ${JSON.stringify(claudeMdPaths)}\n` +
        `Focus question: ${focus}.\n${FALSE_POSITIVES}\n` +
        `Score with this rubric verbatim:\n${RUBRIC}\n${JSON_ONLY}`,
        { phase: 'verify', intent: 'Finding verifier', schema: SCORE_SCHEMA },
      ),
    )).then((votes) => ({ finding, votes })),
    (result) => {
      const settled = (result.votes || []).filter(Boolean);
      const average = settled.length
        ? settled.reduce((sum, vote) => sum + vote.score, 0) / settled.length
        : 0;
      return { ...result.finding, confidence: Math.round(average), votes: settled.length };
    },
  );
  const confirmed = judged
    .filter(Boolean)
    .filter((f) => f.votes >= 2 && f.confidence >= 80);
  log(`${confirmed.length} findings at >=80 confidence`);

  phase('report');
  if (!confirmed.length) {
    return { issues: [], report: 'No issues found. Checked for bugs, security, history, and CLAUDE.md compliance.' };
  }
  const report = await agent(
    `Write the final code review comment for ${target}.\n` +
    `Confirmed issues (JSON): ${JSON.stringify(confirmed)}\n` +
    `Format: a "### Code review" heading, "Found N issues:", then a numbered list; ` +
    `each item is a brief description with the flag reason in parentheses and a ` +
    `file#line citation on the next line. Brief, no emojis. Return markdown only.`,
    { label: 'report', phase: 'report', intent: 'Review report writer' },
  );
  return { issues: confirmed, report };
}
```

## Invocation

```
workflow_run({
  script: <the module above>,
  args: { pr: 'https://github.com/owner/repo/pull/123' },
  max_concurrency: 8,
})
```

Pass `{ target: 'main...feature' }` instead of `pr` to review a local range in
the Team workspace. After the terminal completion, read `issues` for the
structured findings and `report` for the formatted comment; use the reporter
TeamMate's concrete name with `send` for follow-ups such as posting the
comment or re-checking one finding interactively.
