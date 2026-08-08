# Orchestration and Prompt Patterns

`../SKILL.md` owns the run tools and the script API. This reference owns the
craft: how to write TeamMate prompts inside workflow scripts, when to reach
for `pipeline` versus `parallel`, and the reusable quality patterns that make
a run's output trustworthy. All snippets are fragments of a script's
`export default async function run()` body.

## Prompt discipline

Workflow TeamMates are ordinary TeamMates: without instruction they answer
like a chat reply — greetings, framing prose, markdown decoration. Every
prompt must therefore state what the returned text is for.

- **Data calls.** End every `schema` call with an explicit output contract:
  "Return ONLY the JSON object. No prose, no markdown, no code fences." A
  result that does not parse as JSON settles that `agent()` call to `null`
  with no retry — one stray code fence around otherwise-correct JSON loses
  the result.
- **Text calls.** For unstructured returns, still pin the shape: "Return the
  report as markdown only" or "Concise prose only, no preamble."
- **Self-contained prompts.** A TeamMate sees only its own prompt, not the
  script, not the other TeamMates' output. Embed everything it needs —
  the item under work, rubrics, false-positive lists, prior known results —
  directly in the prompt string. Never write "as discussed above".
- **Null-tolerant plumbing.** Any `agent()` call can settle to `null` (failed
  turn, unparseable JSON). Filter with `.filter(Boolean)` before use, and
  make aggregation degrade gracefully rather than crash on a missing vote.
- **Persona through options.** Use `intent` for the durable task description
  and `identity` for a persona; keep the prompt itself about the work.

## pipeline versus parallel

Default to `pipeline`. Only reach for a `parallel` barrier when a stage
genuinely needs every prior result at once.

A barrier is justified when the next step needs cross-item context:

- deduplication or merging across the full result set before expensive
  downstream work;
- an early exit decision on the total ("zero findings, skip verification");
- a prompt that compares items against each other.

A barrier is NOT justified by "I need to flatten or map first" (do it inside
a pipeline stage), "the stages are conceptually separate" (that is exactly
what `pipeline` models), or "it reads cleaner" (barrier latency is real: the
fast items idle while the slowest one finishes).

Smell test — if the script says:

```js
const a = await parallel(thunks);
const b = transform(a);            // flatten, map, filter — no cross-item need
const c = await parallel(b.map(toThunk));
```

that middle transform does not need the barrier; rewrite as one `pipeline`
with the transform inside a stage. Because stages receive only the previous
stage's return value, carry forward whatever context a later stage needs:

```js
const judged = await pipeline(
  items,
  (item) => agent(promptFor(item), { phase: 'inspect', schema: REPORT_SCHEMA })
    .then((report) => ({ item, report })),           // keep the item alongside
  (r) => r && agent(rankPrompt(r.item, r.report), { phase: 'rank' }),
);
```

## Quality patterns

Compose these freely; pick by task.

- **Adversarial verify.** For each candidate finding, start N independent
  skeptic TeamMates, each prompted to REFUTE it ("Default to refuted=true if
  you cannot independently corroborate"). Keep the finding only when a
  majority fails to refute. This kills plausible-but-wrong findings that a
  single confirming pass would wave through.

  ```js
  const votes = (await parallel([0, 1, 2].map((i) => () =>
    agent(
      `You are skeptic #${i + 1}. Try to refute: ${claim}. ` +
      `Default to refuted=true if uncertain. ${JSON_ONLY}`,
      { phase: 'verify', schema: VERDICT_SCHEMA },
    ),
  ))).filter(Boolean);
  const survives = votes.filter((v) => !v.refuted).length >= 2;
  ```

- **Perspective-diverse verify.** When a finding can fail in more than one
  way, give each verifier a distinct focus question (correctness; is it
  pre-existing; does the cited guidance actually say that) instead of N
  identical skeptics — diversity catches failure modes redundancy cannot.
- **Judge panel.** Generate N independent attempts from different angles,
  score them with parallel judges against explicit criteria, then synthesize
  from the winner while grafting the best ideas from the runners-up. Beats
  one-attempt-iterated when the solution space is wide.
- **Loop-until-dry.** For unknown-size discovery (bugs, issues, edge cases),
  keep starting finder rounds until K consecutive rounds return nothing new.
  Fixed counts miss the tail. Deduplicate each round against everything
  already SEEN — not against the accepted list — or judge-rejected findings
  reappear every round and the loop never converges.

  ```js
  const seen = new Set();
  let dry = 0;
  while (dry < 2) {
    const found = (await parallel(finderThunks(seen))).filter(Boolean)
      .flatMap((r) => r.findings)
      .filter((f) => !seen.has(key(f)));
    if (!found.length) { dry += 1; continue; }
    dry = 0;
    found.forEach((f) => seen.add(key(f)));
    // ...verify and accept...
  }
  ```

  Budget first: rounds multiply TeamMate count, and a run stops at 200
  TeamMates total.
- **Multi-modal sweep.** Run parallel searchers that each look a different
  way (by file structure, by content, by naming convention, by history),
  each blind to the others. One search angle rarely finds everything.
- **Completeness critic.** After synthesis, one TeamMate asks "what is
  missing — an angle not searched, a claim unverified, a source unread?"
  What it finds becomes the next round of work, or is reported as a known
  gap.
- **No silent caps.** When the script bounds coverage (top-N, sampling, a
  round limit), `log()` what was dropped. Silent truncation reads as
  "covered everything" when it did not.

## Scale to the ask

Match fan-out to what the operator asked for. A quick check deserves a few
finders and single-vote verification; "thoroughly audit this" deserves a
larger finder pool, 3-vote adversarial verification, and a synthesis stage.
When unsure, lean toward thoroughness for research, review, and audit
requests, and toward brevity for quick checks. Whatever the scale, the
budget arithmetic comes first: count `finders + votes × findings + fixed
stages` against the 200-TeamMate cap before choosing round counts.
