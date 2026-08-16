# Independent Review — Public-Surface Red Line

- **Reviewer seat:** Independent public-surface red-line reviewer (non-Codex).
- **Role:** Audit the revised task artifacts and the complete working tree for
  public-surface leakage — names, package/project entries, dependencies,
  lockfile, registry/config IDs, source fingerprints, environment names,
  tests/fixtures, docs, task history, change notes, generated artifacts, and
  GitHub-facing wording — and verify the neutral external-provider seam and
  the final deletion/verification lists actually close the red line.
  Evidence-backed findings only; no rewrite of the draft.
- **Inputs verified (SHA-256):**
  - `requirement.md` = `fa63050ce335e36edef3ab2258c93ea439aa401e37f70982cd9e8c4492f47c92`
    — matched at review start.
  - `technical-design/final.md` = `7b6c5f20652436601372f5e75d1c6dafdbb22ad8927b2dc5f621bfa85b5f35f2`
    — matched at review start.
- **Mid-review drift (process note):** both artifacts were revised while this
  review was in progress. At time of writing they hash to
  `9c42231fba5323c8f8bf84592767ce58cbbcbba6d642c0a2d` (requirement) and
  `01f10f4133898499c7ad6f929aef5c6851a43a4adea0a749c096e43d9cd8e068`
  (final). I reviewed the assigned versions in full and re-verified every
  red-line clause quoted below against the current versions. The revision
  introduced the "Git metadata" publication carve-out that is my central
  finding (F1). Line numbers below are from the current working-tree
  versions.

## Verdict

**NOT CLEAN — do not sign the red-line gate yet.**

File content is essentially clean (and was being actively scrubbed during
this review), and the neutral external-provider seam is sufficient. But the
revised design draws the publication boundary at "the committable diff" and
explicitly excludes "Git metadata" (`final.md:1183-1186`,
`requirement.md:856-860`). The one live, attributable leak in this task —
the harness-required co-author trailer (co-author identity and corporate
address redacted) on all three task commits — lives precisely in that
excluded zone, as do the PR head branch name and the GitHub issue/PR text
that the task's own blocker list (`README.md:27-29`) names. The deletion
and verification lists close the red line for file content only.

**Updated 2026-08-16 (post-adjudication): see the section at the end of
this file — no solution-level red-line blockers remain; the trailer finding
was adjudicated out of scope and the remaining items are delivery gates.**

---

## Findings (severity-ordered)

### F1 — BLOCKER: Task commit trailers name an internal tool and corporate domain; the revised carve-out excludes them from every planned scan

- **Evidence (leak):** `git log origin/next..HEAD --format='%h %s%n%(trailers)'`
  shows the task's own three commits — `5d8ccd9` (refactor), `2449a1b`
  (docs), `3badc3a` (docs) — each carrying the harness-required co-author
  trailer (co-author identity and corporate address redacted).
- **Evidence (carve-out):** `final.md:1183-1186` — *"no named
  out-of-repository provider in any tracked/untracked repository artifact or
  the complete committable diff; **Git metadata**, ignored dependencies, and
  ignored build outputs are outside this publication surface"*; mirrored in
  verification item 17 (`final.md:1271-1276`) and AC #42
  (`requirement.md:856-860`, *"Git-internal worktree metadata … are not
  repository artifacts"*).
- **Evidence (root rule):** `CLAUDE.md` red line — *"never commit internal
  identifiers, secrets, private registry URLs, internal hostnames, or real
  Feishu ids/tokens."* A co-author trailer is committed, authored,
  GitHub-rendered text; it is not `.git/` internals.
- **Why this is a violation, not a technicality:**
  1. PR #338's head is public on `github.com/excitedjs/dreamux`. GitHub
     renders the trailer on each of the three commits today.
  2. The repository merges via squash (per the archived Dynamic Workflow
     proposal header, "squash-merged to `next`"). GitHub's squash-merge
     editor folds co-author trailers into the default merge commit message,
     so the internal tool name and corporate domain propagate into
     `next` history on merge.
  3. The carve-out makes the gate trivially gameable: any identifier moved
     from file content to a commit message passes the scan. Grouping commit
     trailers with `node_modules` and `dist` is a category error — those are
     machine-generated and unreviewed; trailers are authored prose.
  4. The carve-out is also **internally inconsistent**: `requirement.md:858`
     says "Git-internal **worktree** metadata" (narrowly readable as `.git/`
     internals), while `final.md:1185` says "**Git metadata**" and
     `final.md:1275` says "Git-internal metadata". Three wordings, none
     stating whether commit messages, trailers, and ref names are in scope.
     The gate's pass/fail hinges on this ambiguity.
- **Failure scenario:** the red-line gate runs the planned artifact/diff
  scans (`final.md:1271-1276`), goes green, the PR merges, and `next`
  history gains the trailer's internal tool identity in the squashed
  commit — the exact class of internal identifier the root red line exists
  to keep out of the public repository.
- **Remediation:**
  1. Reissue the three task commits without the trailer (rebase +
     force-push PR #338) before merge; add a commit-message scan over
     `git log origin/next...HEAD --format=%B` with the out-of-repository
     prohibited-token set to the verification plan.
  2. Replace the carve-out with an explicit two-list boundary: **in scope** —
     file content, the committable diff, commit messages of task commits, PR
     title/body, issue text, and the PR head ref name; **out of scope** —
     `.git/` internals, ignored dependencies, ignored build outputs, and
     already-public immutable history (see F5).

### F2 — HIGH: The redaction is uncommitted; the pushed PR head still contains the provider name

- **Evidence:** the working tree (uncommitted) changes
  `.agents/archive/proposals/codex-portable-output-schema.md:227` from
  `"Changing Claude Code or [redacted prohibited provider-family token]
  structured-output behavior."` to
  `"Changing another provider's structured-output behavior."`
  (`git diff` confirms this is the only substantive change to that file).
  `git show HEAD:.agents/archive/proposals/codex-portable-output-schema.md`
  still contains the prohibited token at line 227. Likewise
  `.agents/archive/proposals/dynamic-workflow.md:12` was neutralized from
  a line crediting `claude-seed / [redacted prohibited provider-family
  token]` to `审（两个异构外部 runtime）的补充发现。` during this review —
  also uncommitted.
- **Why it matters:** CI and every reviewer check out the **PR head commit**,
  not a local working tree. Until the scrub is committed and pushed, the
  public head fails the very scan the design mandates, and a green local
  gate would be signing content nobody else can see.
- **Mitigating fact (does not downgrade severity, bounds the remediation):**
  both strings are already in `origin/next` history — one via #321
  (`a2d4755`), the other via #313 (`7bfca29`). They are already public;
  the scrub is about current-tree cleanliness, not unpublishing. No history
  rewrite is warranted or expected.
- **Failure scenario:** the gate is run against the PR head, finds the
  prohibited token, and fails — or worse, is run against a local tree,
  passes, and the dirty head merges.
- **Remediation:** commit and push the two archive redactions as part of the
  red-line remediation commit; record the scrub in the task's verification
  evidence.

### F3 — MEDIUM: The PR head branch name embeds the provider codenames and is excluded from every scan

- **Evidence:** `git branch --show-current` → the local collaboration
  worktree branch label (redacted; it embeds the prohibited token). The
  worktree directory shares the name. Under the `final.md:1185` "Git
  metadata" carve-out, ref names are outside the publication surface.
- **Why it matters:** GitHub displays the head branch name on PR #338 and in
  every commit listing. After the F2 content scrub, the ref name is the most
  visible remaining fingerprint of the collaboration, and the carve-out
  makes it invisible to the gate.
- **Failure scenario:** file content passes the scan; the PR merges from a
  branch whose label embeds the prohibited token; the codename remains
  permanently associated with the merged PR on the public repository.
- **Remediation:** push a neutral head ref (or rename the branch on GitHub,
  which updates the PR in place) before merge; include the head ref name in
  the in-scope list per F1.

### F4 — MEDIUM: GitHub issue/PR wording is a named blocker surface with no audit step, and this seat could not verify it

- **Evidence:** `README.md:25` names solution-review issue
  [#337](https://github.com/excitedjs/dreamux/issues/337); `README.md:27-29`
  lists as an explicit blocker: *"The requirement, solution, implementation
  diff, task history, and **public Issue** must pass the repository
  publication red line."* The verification plan
  (`final.md:1265-1290`) and repository gates (`final.md:1305-1313`) contain
  no GitHub-text audit — every planned scan is repo-local.
- **Verification gap:** this seat attempted to fetch issue #337 and PR #338
  wording; the environment blocks `github.com`
  ("Unable to verify if domain github.com is safe to fetch"). The issue
  title/body/comments and PR description are therefore **unverified by any
  red-line seat so far**.
- **Failure scenario:** issue #337 or the PR #338 discussion names the
  provider or tool; all planned scans are repo-local and miss it; the
  blocker list itself declares this surface in scope, so the gate is
  incomplete without it.
- **Remediation:** add an explicit GitHub-text audit (issue #337
  title/body/comments, PR #338 title/body) to the verification plan,
  performed by an operator with browser access; record the result in the
  task's verification evidence.

### F5 — LOW: The "repository-wide" cleanliness claim is unsatisfiable against immutable history as written

- **Evidence:** AC #42 (`requirement.md:856-860`) and `final.md:1183`
  require no named provider "in any tracked/untracked repository artifact".
  After the F2 scrub, the tree is clean, but a `git log -S` history scan
  for the prohibited token will always hit (#321, #313, and the F1
  trailers).
- **Why it matters:** an absolute "repository-wide" claim invites either a
  false failure (a reviewer runs a history scan and blocks forever on
  already-public commits) or a silent scope narrowing (the carve-out grows
  to make the gate pass). The design should say what it means.
- **Remediation:** state in the verification plan that history scans are out
  of scope because the hits are already public in `origin/next`, and that
  the gate covers only **new** identifiers introduced by this task in file
  content, task commit messages, PR text, and ref names.

---

## Confirmed clean (independently verified, no action needed)

### C1 — The neutral external-provider seam is sufficient and unnamed

- `AgentRuntimeProvider.readTranscript()` is a **required** method on the
  neutral interface (`final.md:655-660`), conformance-enforced for every
  loaded external provider
  (`packages/dreamux/src/agent-runtime/external-provider.ts:106-108`).
- External-provider fixtures are neutral placeholders only:
  `packages/dreamux/tests/agent-runtime-provider.test.ts` uses
  `npm:@example/dreamux-runtime`; `packages/dreamux-types/tests/fixtures/external-provider.ts:262-264`
  and `packages/dreamux/tests/fixtures/external-runtime-provider.ts` return
  empty neutral pages. No provider implementation, registration, package,
  dependency, or compatibility branch exists in the tree.
- `packages/agent-runtime/` contains only `codex/` and `claude-code/`;
  `packages/dreamux/src/registry/builtins.ts:31-43` knows only
  `builtin:codex` and `builtin:claude-code`; no `package.json`,
  `rush.json`, or `pnpm-lock.yaml` change is part of this diff.
- The seam carries no repository-owned implementation detail: an unnamed
  external provider can satisfy it with the empty-page fixture, which
  compiles against `@excitedjs/dreamux-types` root exports only.

### C2 — Change notes are fingerprint-free and correctly shaped

All six `unified-teammate-lifecycle_2026-08-16-00-00.json` files were read in
full. Each leads with `BREAKING: Review:`, states "No rebuild is required",
contains no `Rebuild:`, and names only the public built-ins (Codex, Claude
Code) and the neutral contract — consistent with the same-shape
semantic-change rule in root `CLAUDE.md`.

### C3 — Working-tree diff has no identifiers, hostnames, paths, or secrets

- Added-line scan of the full working-tree diff: no email addresses, no
  Feishu-style IDs (`oc_`/`ou_`/`cli_` + hex), no internal hostnames, no
  machine-local paths (`/home/`, `/data00`, `C:\`), no registry URLs.
  `.npmrc` pins the public `registry=https://registry.npmjs.org/` and is
  unchanged.
- The only environment name added by the diff is the public
  `CLAUDE_CONFIG_DIR`.
- The `gpt-5` strings in `packages/dreamux/tests/global-config.test.ts` are a
  pre-existing `--model` `extra_args` value for the public Codex built-in,
  not added by this diff.

### C4 — Source fingerprints in the artifacts are the task's own content

The SHA-256 digests in `README.md`, `final.md`, and `verification.md` hash
the task's own files; the commit SHAs (`6b8ec14b…`, `3badc3a5…`) are public
repository commits. Neither class is an internal identifier.

### C5 — Task history and consultation artifacts are clean

`verification.md`, the three proposals, and the three lock-native-id reviews
contain no vendor or internal names. (The sibling `redline-ownership.md`
finding F1 — the prohibited token in `dynamic-workflow.md` — was observed
fixed in the working tree during this review; see F2 for the
uncommitted-state caveat.)

---

## Closure assessment of the deletion/verification lists

- **Deletion list item 39 (`final.md:1153-1155`)** and **verification item
  17 (`final.md:1271-1276`)** close the red line for **file content**:
  names, packages, registry entries, dependencies, config, docs, fixtures,
  tests, compatibility branches. The working tree satisfies this today
  (modulo committing F2).
- They **do not** close: task commit messages/trailers (F1), the PR head ref
  name (F3), GitHub issue/PR text (F4), or the already-public history
  question (F5). The carve-out language is the reason, and it is
  inconsistent between the requirement and the final design.
- The neutral seam (C1) needs no addition; it is already the only repository
  boundary for external providers, exactly as the red line requires.

## Scope compliance

Only this file was written. No product code, requirement, final solution,
README, GitHub state, or other file was modified.

---

## Post-adjudication review (2026-08-16)

The operator adjudicated F1–F5 and the task artifacts were revised
afterwards. This section records the dispositions and re-verifies the
red-line clauses against the current artifacts. The findings above are
preserved as filed, with every prohibited provider-family fingerprint and
the collaboration branch/worktree label redacted in place — including in
quoted old content, grep literals, branch names, and examples — per the
redaction instruction.

### Re-read of the current artifacts

- `requirement.md` (current SHA-256
  `e44f6411914cd1ff5ea49c55f09bbae17ad162f62335123f43d89ea0405208d0`) and
  `technical-design/final.md` (current SHA-256
  `17a8a54af9b13eb99c5db2bb2cbf310f3ab48cc2e98773ecd5d3b8b48b41f527cd4`)
  were re-read in full.
- The red line is now scoped to **the operator-prohibited external provider
  family only** (`requirement.md:118-123`): other external providers remain
  governed by the neutral plugin contract, and their unrelated historical
  documentation is neither added nor removed. Unrelated external-provider
  names are valid and must not be scrubbed.
- AC #42 (`requirement.md:863-871`) now requires scans over every
  tracked/untracked repository artifact, every added task-diff line,
  **current task commit messages**, and **the current public Issue/PR
  title, body, comments, reviews, and public head ref**, using a **token
  set supplied outside repository artifacts** so the red line does not
  reproduce the prohibited name. Git-internal worktree files, ignored
  installed dependencies/build outputs, and **immutable already-public
  history before this task** are explicitly excluded.
- The final design mirrors this scope: the architecture gate
  (`final.md:1185-1187`), verification item 17 (`final.md:1276-1280`), and
  delivery-sequence step 7 (`final.md:1344-1346`, repository and current
  GitHub publication red-line scans).
- `README.md:32-38,50-53` states the narrowed red line as the standing task
  constraint and confirms the task adds no new built-in provider; generic
  external providers continue through the neutral `AgentRuntimeProvider`
  contract.

### Finding dispositions after adjudication

- **F1 — adjudicated out of scope; withdrawn as a blocker.** The binding
  harness instruction for this environment requires commits authored/edited
  by this agent to end with the co-author trailer exactly once, so the
  requested trailer removal conflicted with a higher-priority instruction
  and is rejected as out of scope. The operator's narrowed red line does
  not cover the co-author identity or the harness-required corporate
  trailer. The defensible residue of F1 — that task commit messages must be
  inside the scan surface — is now satisfied: AC #42 and the final design
  list current task commit messages explicitly and scan them with the
  out-of-repository token set.
- **F2 — accepted as a delivery fact only; not a solution blocker.** The
  two archive redactions are made in the working tree; they must be
  committed and pushed before PR #338's head can be considered clean. This
  is a later commit/push delivery gate and does not block solution
  approval.
- **F3 — withdrawn; premise false.** PR #338's actual public head ref is
  `feature/unified-teammate-lifecycle`, which is neutral. The local
  worktree branch label this finding cited is not the public head ref and
  is not a publication surface. No rename is required.
- **F4 — closed by the revised artifacts; remains a delivery-time check.**
  The requirement and final design now mandate scanning the current
  Issue/PR title, body, comments, reviews, and public head ref before
  delivery with the out-of-repository token set. The TeamLeader (which has
  GitHub access) reports zero prohibited-family matches on issue #337 (old
  body withdrawn) and on PR #338's current title/body/head ref. This seat
  still cannot reach `github.com`, so the pre-delivery scan must be re-run
  by the TeamLeader at delivery time and recorded as verification
  evidence.
- **F5 — resolved.** AC #42 explicitly excludes immutable already-public
  history before this task and scopes the claim to current artifacts and
  additions. The unsatisfiable "repository-wide" reading no longer exists.

### Updated verdict

**No solution-level red-line blockers remain. The solution may be approved.**

The neutral external-provider seam (C1) is unchanged and sufficient:
required `readTranscript`, conformance enforcement, neutral `@example`
fixtures, and no repository-owned provider implementation, registration,
dependency, or compatibility branch.

Delivery gates (later, at commit/push and PR delivery — not solution
approval):

1. Commit and push the F2 working-tree redactions so the PR head matches
   the clean tree.
2. Immediately before delivery, run the now-required publication scans —
   repository artifacts, added task-diff lines, task commit messages, and
   current Issue/PR title/body/comments/reviews/head ref — with the
   out-of-repository token set, and record the results.
3. Keep the harness-required co-author trailer exactly once on
   agent-authored commits (binding instruction); it is outside the
   narrowed red line.
