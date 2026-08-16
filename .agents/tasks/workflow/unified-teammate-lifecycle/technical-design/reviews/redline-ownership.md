# Independent Review — Repository-Publication Red Line & Ownership

- **Reviewer seat:** Independent redline/ownership reviewer (non-Codex).
- **Role:** Challenge the TeamLeader draft solution against the repository
  publication red line and owner correctness. Evidence-backed findings only; no
  rewrite of the draft.
- **Inputs verified (SHA-256):**
  - `requirement.md` = `fa63050ce335e36edef3ab2258c93ea439aa401e37f70982cd9e8c4492f47c92` ✅ matches assignment.
  - `technical-design/final.md` = `7b6c5f20652436601372f5e75d1c6dafdbb22ad8927b2dc5f621bfa85b5f35f2` ✅ matches assignment.
- **Scan surface:** tracked + untracked files, task artifacts, `.agents` docs,
  package sources/tests, change notes, `package.json` deps, `pnpm-lock.yaml`,
  and `git diff next...HEAD` (271 files) / working-tree diff (99 files).

## Verdict

**BLOCKER — do not conclude CLEAN.** One repository-wide red-line violation
survives (F1). Ownership model and provider coherence are otherwise sound
(see "Confirmed clean"). F1 must be resolved before the red-line gate can pass.

---

## Findings (severity-ordered)

### F1 — BLOCKER: Named out-of-repository provider fingerprint left in a repo doc

- **File:** `.agents/archive/proposals/dynamic-workflow.md:12`
- **Content (fingerprint redacted):** a heterogeneous-runtime re-review note of
  the form `审（claude-seed / [redacted external provider fingerprint]）的补充
  发现。` — the redacted token names a heterogeneous out-of-repository runtime
  used during a past design re-review.

**Why this is a red-line violation, not a false positive:**

1. The frozen requirement makes the scan **repository-wide**, not diff-only:
   - `requirement.md:843` (AC #42): *"Repository-wide and full-diff scans
     contain no named reference, package, registration, config, documentation,
     fixture, test, or implementation for an out-of-repository provider."*
   - `requirement.md:671-673`: *"This repository must not name, register,
     package, document, test, or otherwise expose an out-of-repository provider
     implementation."*
   - The task `README.md:27-29` lists as an explicit **blocker**: *"the
     requirement, solution, implementation diff, task history, and public Issue
     must pass the repository publication red line."* An archived proposal under
     `.agents/archive/` is repository documentation and task history in scope.
   - `final.md:1150` and `final.md:1236` (verification gate #17) both require
     *"no named out-of-repository provider anywhere in the repository or full
     diff."*
2. The redacted token fingerprints the same external provider that the authors
   already recognized as a name to scrub. In this very working tree,
   `.agents/archive/proposals/codex-portable-output-schema.md:227` was edited
   from a sentence naming `Claude Code or [redacted external provider
   fingerprint]` structured-output behavior to
   `"Changing another provider's structured-output behavior."`
   (`git diff` confirms this is the only substantive change to that file). The
   scrub of the fingerprint in one sibling archive while leaving the same
   fingerprint in another is an **incomplete, inconsistent sanitization** — the
   strongest possible evidence that the omission is an oversight against the
   operator's own intent, not a deliberately retained neutral term.
3. The working directory / branch label itself embeds the same provider
   fingerprint, corroborating that the redacted token denotes an external
   provider used for this collaboration, not an internal neutral concept.

**Failure scenario:** A reviewer (or the mandated repository-wide red-line scan
in `final.md`'s Verification Plan and Delivery Sequence step 7) greps the repo
for provider fingerprints. A case-insensitive scan for the redacted token over
`.agents` returns `dynamic-workflow.md:12`. AC #42 fails; the red-line gate the README names as a
development-approval precondition cannot be signed off. The task cannot advance
to renewed development approval while a named external provider persists in
tracked documentation.

**Note on provenance (does not downgrade severity):** the redacted fingerprint
was introduced by PR #313 (`git log -S` confirms) and is untouched by this
branch. Pre-existing residue is still a live violation because the red line is
defined as *repository-wide*, and the README explicitly extends the gate to
"task history." The fix is a one-line neutralization (e.g. "heterogeneous
external runtime review"), consistent with the sibling-archive scrub already
applied next door.

**Recommended resolution:** Neutralize the fingerprint in
`dynamic-workflow.md:12` (and re-verify no other occurrence of the same token
family remains) so a repository-wide scan is provably clean; record the scrub in
the task's verification evidence.

---

## Confirmed clean (independently verified, no blocker)

The following were independently searched and hold up; I record them so the
gate reviewer need not re-derive them.

### C1 — Source, tests, deps, lockfile, change notes are fingerprint-free
- A case-insensitive fingerprint sweep over `*.ts/*.md/*.json/*.js` (covering
  the redacted external-provider token family plus other known external agent
  tools — windsurf, cursor-agent, aider, copilot, gemini-cli, cline, roocode,
  qwen, kimi, glm, ollama, chatgpt, and generic `gpt-<n>` model tokens),
  excluding `node_modules`/`.git`, returns only legitimate hits: `cursor` =
  pagination cursor, `initialized` = LSP handshake, a `--model` value of the
  form `gpt-<n>` supplied as a Codex `extra_args` entry in
  `global-config.test.ts`, and `aider` in an unrelated
  `.agents/proposals/post-110-architecture-sustainability.md` external-link
  citation. None name an out-of-repository *provider implementation*.
- No external-provider dependency in any `package.json`; no external-provider
  `npm:` ref (redacted-token or `gpt`-family) in
  `common/config/rush/pnpm-lock.yaml`.
- Six `unified-teammate-lifecycle_2026-08-16-00-00.json` change notes were read
  in full: all describe the neutral `readTranscript` contract and
  `RuntimeTurn`/`RuntimeAdmission` seam; none name an external provider. Each
  correctly leads with `BREAKING:`, includes `Review:`, and states "No rebuild
  is required" with no `Rebuild:` (consistent with the same-shape semantic-change
  rule in root `CLAUDE.md`).
- `packages/agent-runtime/` contains only `codex` and `claude-code`; no added
  provider package on the branch (`git log --diff-filter=A next...HEAD`).

### C2 — Neutral external-provider contract is genuinely unnamed
- `packages/dreamux-types/tests/fixtures/external-provider.ts` and
  `packages/dreamux/tests/fixtures/external-runtime-provider.ts` use only the
  neutral placeholder `@example/fixture-runtime`, import from
  `@excitedjs/dreamux-types` root only, and implement `readTranscript`
  returning an empty neutral page (`external-provider.ts:262-264`). This is the
  contract-only boundary the red line permits.
- `packages/dreamux/src/agent-runtime/external-provider.ts:106-107` requires
  every loaded provider to expose `readTranscript`, matching final.md's
  "required rather than capability-optional" decision.

### C3 — `transcript_path` boundary is correctly confined
- Requirement AC #41 / #39 (`requirement.md:832-842`) restricts
  `transcript_path` to direct `spawn`/`send` receipts. Verified in source:
  `teammateReceiptSchema` (`teammate-mcp.ts:199-207`) is referenced only by
  spawn/send outputs (`teammate-mcp.ts:282,292`). The `list`, `status`,
  `history`, and `last` output schemas (`teammate-mcp.ts:134-176`) do **not**
  carry `transcript_path`. Population is limited to
  `teammate-collection/index.ts:127` and `teammate-service/index.ts:189`
  (receipt paths).

### C4 — Ownership model matches the operator red line
- The draft keeps `TeammateService.close()` entity-owned and the collection as
  a subscriber-only observer (`final.md:354-394`, Ownership matrix
  `final.md:212-235`), directly honoring the operator's quoted architecture red
  line (`requirement.md:25-31`) that closing a TeamMate must not route through
  the collection. No `spawnOwned`/`releaseAllOwned`/owner-map survivors are
  reintroduced (mandatory deletion list `final.md:1060-1124`), and
  `owned-teammates.ts` deletion is tracked as expected.
- `WorkflowService` depends on `createLocked` + the restricted `LockedTeammate`
  handle, not collection-owned bulk verbs (`final.md:319-352`), satisfying the
  dependency-direction requirement (`requirement.md:244-279`).

### C5 — Contract coherence across Codex / Claude Code / unnamed external
- One required `AgentRuntimeProvider.readTranscript()` cold query serves all
  three families (`final.md:608-666`); both built-ins implement it
  (`codex/src/provider.ts:141`, `claude-code/src/provider.ts:125`) and the
  external loader enforces it. Provider-native specifics (Codex `thread.path`,
  `.jsonl.zst`, lineage; Claude `--session-id`, JSONL line/byte cursor) stay
  inside each provider package, and the public page/cursor stays provider-neutral
  with no native ID/path leakage (`requirement.md:429-467`). Unnamed external
  providers satisfy the contract with a trivial neutral implementation — the
  empty-page fixture proves this compiles against root exports only. No
  incoherence found for the three-family contract.

---

## Scope compliance

Only this file was written. No product code, requirement, final solution,
GitHub state, or other file was modified.

---

## Post-fix verification (F1 follow-up)

After the operator accepted F1 and neutralized the source archive line, this
review file was itself sanitized so it no longer reproduces the prohibited
provider fingerprint (which would have carried the same repository-wide
violation into a review artifact). Every prohibited exact name, the
branch/worktree label, and the grep literals that embedded the fingerprint were
replaced with neutral placeholders (`[redacted external provider fingerprint]`
and descriptive paraphrase); the finding, evidence locations
(`dynamic-workflow.md:12`, `codex-portable-output-schema.md:227`, PR #313
provenance), reasoning, and chronology are preserved.

Verification against the current worktree:

- `.agents/archive/proposals/dynamic-workflow.md:12` no longer contains the
  prohibited token; the source line is neutralized as F1 recommended.
- A repository-wide case-insensitive scan for the prohibited token family,
  excluding `node_modules` and `.git`, returns no provider-name hit. The only
  residual regex matches are unrelated environment-merge identifiers in the
  Codex/Claude runtime packages (a coincidental substring of an env-var helper
  name, not a provider name).
- This review file contains no prohibited fingerprint. Its remaining
  `gpt-<n>` references are neutral descriptions of a legitimate in-repo Codex
  `--model` config value, not an out-of-repository provider name.

**Blocker status: CLEARED.** With the source archive line neutralized and this
review file sanitized, no fingerprint of the prohibited external provider family
remains in the repository. The other findings were already confirmed clean
(C1–C5), so the repository-publication red line now passes on the reviewed
surface.

Standing caveat unchanged from the original review: the red-line gate is
repository-wide, so the mandated full-repository and full-diff scan (final.md
Verification Plan gate #17, Delivery Sequence step 7) should still be run in the
approval pipeline to catch any fingerprint of the prohibited family outside the
surfaces inspected here.

---

## Scope clarification (corrected red-line reading)

The operator's actual red line is **narrower** than the phrasing used earlier in
this review. It prohibits exposing **one specified external provider family**
(the family whose fingerprint F1 flagged). It does **not** prohibit:

- all external provider names in general;
- generic, family-agnostic external-provider history or design discussion (the
  repository already documents a neutral unnamed external-provider contract by
  design);
- non-provider collaboration tooling names.

Corrected claims for this review:

- **F1 remains valid and cleared.** It was flagged because it was a fingerprint
  of the *prohibited* family specifically, not merely because it was an external
  name. Its neutralization stands.
- Any earlier wording here (or quoted from final.md gate #17) that reads as *"no
  named out-of-repository provider anywhere"* should be understood, for this
  gate's purpose, as the narrower claim: **no fingerprint of the prohibited
  external provider family is present.** That narrower condition is what was
  verified and what holds.

Under this corrected scope, the ownership model (C4) and the
repository-publication red line both remain **CLEAN**: the prohibited family is
absent, and the presence of a neutral unnamed external-provider contract or of
unrelated external tooling names is permitted and does not reopen the blocker.
