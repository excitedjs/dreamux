# Contributing to the dreamux knowledge base

This file is for *writers* of `.agents/` content. Readers start at
[`root.md`](root.md).

Nothing in this KB is absolutely authoritative. Every page is description plus
rationale — evidence of what is and why — and any of it may be changed to fit
the current product scenario, knowingly: name what you are changing, why the
recorded reason no longer holds, and update the page in the same change.

## Knowledge-delta protocol

Before finishing any non-trivial change, ask:

> Did this move a package boundary, a CLI surface, a settled design decision,
> a Codex / Feishu protocol contract, a state/config format, or a
> cross-process invariant?

If **yes**: update the owning page in the same PR. A correct system with a
stale KB is worse than a buggy system whose KB tells you exactly where to look.

Also ask:

> Did this change add a callback seam that threads through three or more
> layers (container → collection → service → entity)? If so, should it be
> a named capability on an interface instead?

A new three-layer callback is a smell: prefer extracting a named interface or
capability object that the callee can depend on directly.

If **no** (bug fix inside one function, an obvious refactor, a TODO): don't
write a KB entry just to look diligent. The KB earns its keep by being terse.

## Document kinds

| Kind | When to use | Naming |
|---|---|---|
| `product/` | User-visible behavior stated independently of implementation — the baseline refactors diff against so behavior changes are made knowingly. Entries change only as explicit requirement decisions. | `README.md` catalog + companion pages |
| `domains/<area>.md` | The current shape of one area: ownership, contracts, invariants, traps. This is the single current-state tree — there is no separate `reference/` kind. | kebab-case |
| `tasks/<domain>/<slug>/` | One requirement's full derivation: lineage, rulings, design churn, delivery. Deliberately dense and messy — it is the evidence layer, not a reading path. Settled rulings from before the task system live here as backfilled records. | see `skills/dev-workflow/references/task-records.md` |
| `research/<slug>.md` | Frozen investigation snapshot; must end with a disposition section (Promoted / Deferred / Out of scope). Never updated in body — evidence, preserved in its original language. | kebab-case |
| `proposals/<slug>.md` | Genuinely active design work only. Once implemented, superseded, or abandoned, move it to `archive/` in the same change — an annotated graveyard is not "active". | kebab-case |
| `archive/<kind>/<slug>.md` | Preserved historical material off the default reading path. Keep the original slug, add a dated banner, add an index row with a current pointer. | keep original slug |
| `glossary.md` | Short definitions for overloaded Dreamux terms; each entry links its owner page. | fixed filename |

There is no `decisions/` kind. The "why" of a settled choice lives in its task
record (backfilled ones included); a domain page states the current fact and
ends with a one-line History pointer to the owning task-domain index. Do not
grow per-ruling trail lists on domain pages — they accrete.

## One owner per fact — split by what travels with the diff

Each fact has one owner file; other files link to it instead of restating it.
The split between a KB page and a directory `CLAUDE.md` is decided by **what
gets opened alongside the code diff**, not by abstraction level:

- load-bearing invariants a coder must know while editing a directory live in
  that directory's `CLAUDE.md` — it rides the same diff and review;
- cross-package maps, topology, product behavior, and traps live in the KB;
  the KB links down to directory invariants rather than copying them.

The #356 revert is the standing proof: it updated `service/CLAUDE.md` in the
same diff as the source and missed two KB copies of the same fact, which then
taught the next agent a shipped bug. Copies rot; owners travel.

## Conventions

- **English.** All KB content is written in English (repo rule). This is a
  writing convention, not a mechanical check; frozen `research/` evidence keeps
  its original language.
- **Current facts need source links.** Domain pages point at the files that
  implement the behavior they describe; `check.sh` verifies every cited
  `/packages/...` path resolves.
- **Regression Trap.** When the operator corrects a *class* of error — not
  just an instance — the owning page gains a `## Regression Trap` (or
  `## Locked Scope`) section in the same change: the trigger, the concrete
  historical mistake, and the rejected direction with its reason. A trap is a
  warning with a reason, not a prohibition; if the reason no longer holds,
  raise it with the operator. Delete a trap when the mechanism it guards is
  deleted or redesigned — traps are bounded, not a chronicle.
- **Since this was recorded.** Historical text (backfilled records, frozen
  snapshots) is never edited in place. Corrections go into a dated
  `## Since this was recorded` section beneath the preserved body.
- **Backfill provenance.** Content moved from a dissolved structure carries a
  banner naming the move date and origin; original dates and statuses stay
  verbatim.
- **Links.** Relative links inside `.agents/`; repo-root-absolute links
  (starting with `/`) from KB files to source files or always-loaded repo
  files. Task trees use absolute `/.agents/tasks/...` links (the task
  scaffold's convention).
- **Status matters.** Historical material must say that it is historical.

## Regression Trap: a green check.sh does not mean the facts are right

`check.sh` validates structure — links resolve, nothing is orphaned, cited
source paths exist. It does not read meaning. Two reproduced instances: a KB
page contradicted a load-bearing removed-surfaces test while CI stayed green,
and index annotations described fully implemented work as "draft". When you
change behavior, grep the KB for the facts you changed; nothing else will.

## Validation

Before committing KB changes, run:

```bash
.agents/scripts/check.sh
```

It validates links, reachability from `root.md`, and domains-page source-path
liveness. Failures are noisy on purpose; CI rejects anything it rejects.
