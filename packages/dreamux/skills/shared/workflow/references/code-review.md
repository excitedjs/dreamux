# Code Review Workflow

`../SKILL.md` owns the run tools and the script API. This reference teaches
the method for carrying a code review as one `workflow_run`: the stages, the
scoring rubric, and the false-positive discipline. Write the script for the
task at hand — the sketch at the end shows the shape, it is not a template to
paste.

The review target is any change the Team workspace can read: a GitHub pull
request, a GitLab merge request, a local branch or commit range, or an
uncommitted working-tree diff. For interactive review — where the next
instruction depends on reading the previous finding — use `spawn` and `send`
instead.

## The flow

1. **Gate.** One TeamMate checks eligibility; exit early when review is not
   needed: the change is closed or a draft, is automated or trivially safe,
   or already carries a review from this Team.
2. **Context.** In parallel: list the file paths (not contents) of the
   repository's agent guidance files (`CLAUDE.md`, `AGENTS.md`) at the root
   and in directories the change touches; summarize the change (intent,
   scope, risk areas). Feed both into every later prompt.
3. **Find.** Independent finder lenses in parallel, each blind to the others:
   - guidance-file compliance (read the discovered files; not every writing
     instruction applies at review time);
   - a shallow bug scan limited to the changed hunks;
   - git blame and history of the modified code;
   - review comments on prior change requests touching the same files;
   - guidance stated in code comments of the modified files;
   - concrete security issues introduced by the change.
   Every finding must state a concrete failure scenario — the specific
   inputs or state that produce the wrong outcome; a defect that cannot be
   stated as a scenario is not reportable. Deduplicate across lenses by
   file, line, and title. For an exhaustive audit, repeat find/verify rounds
   until two consecutive rounds surface nothing new, carrying already-seen
   findings in each round's prompts.
4. **Verify.** Score each finding with parallel verifier TeamMates — three
   normally, two for a quick pass — but give each verifier a *distinct focus
   question* rather than re-asking the same one: does the defect reproduce on
   the changed lines; is it pre-existing rather than introduced by this change;
   does the cited guidance file or code comment actually say that. Diverse
   focus catches failure modes that identical skeptics miss. Each verifier
   receives the finding, the guidance paths, the false-positive list, its
   focus question, and this rubric verbatim:
   - 0: Not confident at all. False positive that does not stand up to light
     scrutiny, or a pre-existing issue.
   - 25: Somewhat confident. Might be real, might be a false positive; could
     not verify. If stylistic, it is not explicitly called out in a relevant
     guidance file.
   - 50: Moderately confident. Verified real, but may be a nitpick or rare in
     practice; not very important relative to the rest of the change.
   - 75: Highly confident. Double checked; very likely real and will be hit
     in practice; directly impacts functionality or is directly mentioned in
     a guidance file.
   - 100: Absolutely certain. Double checked and confirmed; will happen
     frequently; evidence directly confirms it.
   Verifiers also check that the stated failure scenario is concrete and
   actually leads to the claimed outcome. Score toward the low end when you
   cannot independently corroborate the finding — an uncorroborated finding is
   a 0 or 25, not a hopeful 50. Keep a finding only when at least two verifiers
   settled a vote and those votes average 80 or higher; fewer than two settled
   votes is unverified coverage, not a pass. At
   max effort, findings in the 50-79 band may be reported too — in their own
   clearly labeled section, never as confirmed issues.
5. **Report.** One TeamMate writes the review comment: a short verdict, then
   numbered issues (grouped by severity when findings carry one), each with
   the flag reason in parentheses and a file#line citation — file path alone
   when no line is known; never invent a line number. Brief, no emojis. When a
   channel reply tool is available, post the returned report through it;
   otherwise return the report for the caller, or have a follow-up `send` to
   the reporter publish it with the forge's tooling (`gh`, `glab`) once the
   operator confirms.

## False positives

Instruct finders and verifiers to treat these as false positives: pre-existing
issues; code that looks buggy but is not; pedantic nitpicks; anything a
linter, typechecker, or CI would catch; general quality concerns not required
by a guidance file; issues explicitly silenced in code; intentional behavior
changes related to the broader change; and real issues on lines the change
did not modify. When reviewing a cumulative range, add: behavior an earlier
change introduced and a later change in the same range deliberately replaced.

## Scaling and range reviews

Match fan-out to the ask: a quick pass is one round with two votes; a normal
review is one round with three; "thoroughly audit this" repeats rounds until
dry. The confirmation bar stays the same throughout — effort widens coverage,
never the evidence standard.

For a cumulative range ("everything since X"), resolve the fuzzy description
into one exact `base..head` first — as the opening stage when it takes
repository work — and add a cross-change lens: a later change silently
invalidating an earlier one's assumption, dead code or docs left behind by a
superseding change, contradictory contracts between commits.

## Failure semantics worth remembering

`agent()` settles to `null` on a failed turn, and helper results stay
index-aligned with their inputs — note which lens or verifier failed before
filtering nulls, and say so in the report instead of presenting partial
coverage as clean. A directly awaited schema call rejects on a
structured-output contract breach, which is the right outcome for
load-bearing calls like the gate. The pattern language lives in
[orchestration-patterns.md](orchestration-patterns.md).

## Sketch

The shape, compressed — adapt lenses, schemas, rounds, and report format to
the actual task:

```js
export const meta = {
  name: 'code-review',
  description: 'Multi-lens code review with confidence-scored findings',
  phases: [
    { title: 'gate' }, { title: 'context' }, { title: 'find' },
    { title: 'verify' }, { title: 'report' },
  ],
};

phase('gate');
const gate = await agent(`Should ${args.target} be reviewed? ...`, {
  phase: 'gate', schema: GATE_SCHEMA,
});
if (!gate?.eligible) return { skipped: true, reason: gate?.reason };

phase('context');
const [guidance, summary] = await parallel([
  () => agent(`List guidance files relevant to ${args.target}.`, { phase: 'context' }),
  () => agent(`Summarize ${args.target}.`, { phase: 'context' }),
]);

phase('find');
const findings = dedupe((await parallel(LENSES.map((lens) => () =>
  agent(finderPrompt(lens, args.target, guidance, summary), {
    phase: 'find', schema: FINDINGS_SCHEMA,
  }),
))).filter(Boolean).flatMap((r) => r.findings));

phase('verify');
const scored = await pipeline(
  findings,
  (f) => parallel(FOCUS_QUESTIONS.map((focus) => () =>
    agent(rubricPrompt(f, focus), { phase: 'verify', schema: SCORE_SCHEMA }))),
  (votes, f) => ({ ...f, votes: (votes || []).filter(Boolean) }),
);
const confirmed = scored.filter(Boolean)
  .filter((f) => f.votes.length >= 2 && average(f.votes) >= 80);

phase('report');
return {
  issues: confirmed,
  report: await agent(reportPrompt(args.target, confirmed), { phase: 'report' }),
};
```
