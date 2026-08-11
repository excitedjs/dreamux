# Ultracode Orchestration Techniques

`../SKILL.md` owns the run tools and the script API;
[orchestration-patterns.md](orchestration-patterns.md) owns prompt discipline,
the `pipeline`-versus-`parallel` rules, and the individual quality patterns.
This reference owns the level above: how to shape a whole task as ultracode
workflows — choosing an archetype, scouting before orchestrating, chaining
runs, and composing the quality patterns into complete harnesses.

## Contents

- [Workflow archetypes](#workflow-archetypes) — five reusable single-run
  shapes
- [Scout before you orchestrate](#scout-before-you-orchestrate) — discover
  the work-list first
- [Chain runs, stay in the loop](#chain-runs-stay-in-the-loop) — multi-phase
  work as a sequence of runs
- [Worked compositions](#worked-compositions) — barrier-when-justified and
  the exhaustive-discovery loop
- [Loop-until-count](#loop-until-count) — accumulate to a target
- [Novel harnesses](#novel-harnesses) — beyond the named patterns

## Workflow archetypes

Most tasks that deserve a workflow fit one of five single-run shapes. Name the
shape first; the script structure follows from it.

- **Understand** — parallel readers over relevant subsystems, one structured
  map out. Fan out one `agent()` per subsystem with a shared schema, then one
  synthesis agent merges the maps. Use when the question is "how does this
  system work" and no single context can hold it all.
- **Design** — a judge panel over N independent approaches. Generate attempts
  from deliberately different angles (smallest-change-first, risk-first,
  user-first), score them with parallel judges against explicit criteria,
  synthesize from the winner while grafting the runners-up's best ideas. Use
  when the solution space is wide and one-attempt-iterated would anchor early.
- **Review** — dimensions → find → adversarially verify. The complete recipe
  lives in [code-review.md](code-review.md); the shape generalizes to any
  audit: independent finder lenses, confidence-gated verification, one
  severity-ordered report.
- **Research** — multi-modal sweep → deep-read → verify → synthesize: search
  agents per angle, URL dedup at a justified barrier, per-source claim
  extraction, adversarial claim verification, one cited report with honest
  coverage caveats.
- **Migrate** — discover sites → transform each → verify each. Scout the
  work-list first (see below), then `pipeline` items through
  transform-then-verify stages. Keep concurrent edits on clearly independent
  paths, or serialize the write stage — workflow TeamMates share the Team
  workspace.

## Scout before you orchestrate

The coordination graph must be known before the orchestration step — not
before the task. When the work-list is unknown ("migrate every call site",
"review whatever changed"), scout first and fan out second:

- cheap scouting (one `git diff --stat`, one directory listing) belongs in
  the TeamLeader's own turn before `workflow_run`, with the result passed in
  as `args`;
- scouting that itself needs an agent (resolving a fuzzy range, inventorying
  a subsystem) belongs as the script's first stage, awaited bare so an
  unresolvable work-list fails the run before any fan-out — the resolve stage
  in [code-review.md](code-review.md)'s range mode is this technique.

Never fan out against a guess: every downstream prompt should receive the
resolved work-list, not the fuzzy description.

## Chain runs, stay in the loop

A workflow is one well-scoped fan-out with a deterministic graph. Larger work
— understand, then design, then implement, then review — is a SEQUENCE of
workflows with the TeamLeader reading each terminal result before shaping the
next run. Resist packing multi-phase judgment into one mega-script: the
decisions between phases (is the map good enough? which design won? is the
implementation ready for review?) are exactly the parts that should stay with
the TeamLeader, interactive and revisable.

Two practical consequences:

- return STRUCTURED results (not just prose) from each run so the next run's
  `args` can be built from them mechanically;
- after a run, follow up interactively with a recorded concrete TeamMate name
  via `send` when one result needs a clarification — reshaping and re-running
  the whole workflow is for when the graph itself was wrong.

## Worked compositions

**A barrier when it is genuinely justified** — dedup across the full result
set before expensive downstream work:

```js
const all = await parallel(angles.map((a) => () =>
  agent(searchPrompt(a), { phase: 'search', schema: SOURCES_SCHEMA })));
const seen = new Set();
const sources = [];
for (const result of all.filter(Boolean)) {
  for (const s of result.sources) {
    const key = s.url.replace(/[#?].*$/, '');
    if (!seen.has(key)) { seen.add(key); sources.push(s); }
  }
}
// only now fan out the expensive per-source work
const reports = await pipeline(sources, fetchStage, verifyStage);
```

The barrier earns its latency because the dedup needs every angle's output at
once; the per-source work that follows goes back to `pipeline`.

**The exhaustive-discovery loop** — finders → dedup vs SEEN → diverse
verification → repeat until dry, the composition behind every "audit
everything" request:

```js
const seen = new Set();
const accepted = [];
let dry = 0;
while (dry < 2) {
  const found = (await parallel(finderThunks(seen))).filter(Boolean)
    .flatMap((r) => r.findings);
  const fresh = [];
  for (const f of found) {
    if (!seen.has(key(f))) { seen.add(key(f)); fresh.push(f); }
  }
  if (!fresh.length) { dry += 1; continue; }
  dry = 0;
  const judged = await pipeline(fresh, verifyStage, aggregateStage);
  accepted.push(...judged.filter(Boolean).filter((f) => f.accepted));
}
```

Two load-bearing details, both learned the hard way: dedupe against SEEN (not
against `accepted`, or judge-rejected findings reappear every round and the
loop never converges), and dedupe INSIDE the fresh-collection loop (not with a
plain `filter` against the pre-round set, or the same finding from several
concurrent finders enters the round several times).

## Loop-until-count

For "give me N of X" requests, accumulate to the target instead of guessing
the fan-out size:

```js
const bugs = [];
while (bugs.length < 10) {
  const result = await agent('Find bugs not in this list: ' +
    JSON.stringify(bugs.map((b) => b.title)), { schema: BUGS_SCHEMA });
  if (!result || !result.bugs.length) break; // a dry pass ends the hunt honestly
  bugs.push(...result.bugs);
  log(`${bugs.length}/10 found`);
}
```

Always pair the target with a dry-pass exit and `log()` the shortfall — a
loop that cannot reach N must say so, not spin against the agent cap.

## Novel harnesses

The named patterns are a vocabulary, not a ceiling. Compose new harness
shapes when the task calls for it:

- **tournament** — pair candidates, judge each pair, advance winners; better
  than one big judge panel when candidates are too many to compare at once;
- **self-repair loop** — generate → check → feed the checker's findings back
  to a fixer → re-check, bounded by attempts, with every iteration logged;
- **staged escalation** — a cheap pass filters the easy majority, and only
  survivors reach the expensive treatment (the confidence-gated verify stage
  in [code-review.md](code-review.md) is this shape).

Whatever the shape, the standing rules from
[orchestration-patterns.md](orchestration-patterns.md) still bind: positional
coverage accounting before `.filter(Boolean)`, no silent caps, self-contained
prompts, and budget arithmetic against the run limits before choosing sizes.
