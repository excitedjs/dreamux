# Contributing to the dreamux knowledge base

This file is for *writers* of `.agents/` content. Readers should start at
[`root.md`](root.md).

## Knowledge-delta protocol

Before finishing any non-trivial change, ask:

> Did this move a package boundary, a CLI surface, a settled design decision,
> a Codex / Feishu protocol contract, a state/config format, or a
> cross-process invariant?

If **yes**: update the KB in the same PR. A correct system with a stale KB is
worse than a buggy system whose KB tells you exactly where to look.

Also ask:

> Did this change add a callback seam that threads through three or more
> layers (container → collection → service → entity)? If so, should it be
> a named capability on an interface instead?

Current callback seams in the codebase:

- `initiatorFor` — `DispatcherService` → `CompletionRouter` (delivery target resolution)
- `leaderChannelDescriptors` — `DispatcherService` → `TeamCollection` → `TeamService` → `buildLeader()` (channel MCP descriptor provisioning)
- `getRuntime` + `submitScheduled` — container → `SchedulerService` (runtime access and scheduled input submission)

Each is acceptable because it back-references a capability the caller owns but the
callee cannot import without a cycle. But a new three-layer callback is a smell:
prefer extracting a named interface or capability object that the callee can
depend on directly.

If **no** (bug fix inside one function, an obvious refactor, a TODO): don't
write a KB entry just to look diligent. The KB earns its keep by being terse.

## How to write

- **English.** All KB content is English regardless of conversation language.
  (Repo-level rule, see [`/CLAUDE.md`](../CLAUDE.md).)
- **Current facts need source links.** Reference docs point at the files that
  implement the behavior they describe.
- **Short and owned.** Each fact has one owner file. Other files link to it
  instead of restating it.
- **Links.** Use relative links inside `.agents/` when linking to other KB
  files. Use repo-root-absolute links (start with `/`) when linking from KB
  files to source files, package files, or always-loaded repo files such as
  `/CLAUDE.md`.
- **Status matters.** Historical material stays preserved, but it must say that
  it is historical, superseded, or archived.

## Document Kinds

| Kind | When to use | Naming |
|---|---|---|
| `reference/<thing>.md` | Current behavior for a repo piece or operational mental model. Use for "what exists now". | kebab-case, no number |
| `decisions/<slug>.md` | A choice that was debated and settled. Use for "why was this chosen". | kebab-case, no sequence number |
| `domains/<area>.md` | A current cross-cutting runtime contract that spans several reference pages. | kebab-case |
| `glossary.md` | Top-level terminology index for overloaded Dreamux terms. Keep it short and link source/reference docs for behavior. | fixed filename |
| `proposals/<slug>.md` | Active design proposal only. Once implemented, superseded, or abandoned, move it to `archive/` or promote the settled result to a decision/reference page. | kebab-case |
| `archive/<kind>/<slug>.md` | Preserved historical material that should not be a default reading path. | keep original slug |
| `research/<slug>.md` | Frozen investigation snapshot; must end with a disposition section (Promoted / Deferred / Out of scope). | kebab-case |
| `rules/<slug>.md` | A process rule that applies to KB authors themselves. | kebab-case |

## Decision Record Template

```markdown
# <decision title>

- **Status:** Accepted | In progress | Superseded by [link]
- **Date:** YYYY-MM-DD
- **Affects:** packages / surfaces / invariants
- **PR / Issue:** link

## Context

The forces that made this a decision worth recording.

## Decision

What was chosen. One sentence if possible.

## Consequences

Costs, constraints, foot-guns, and enforcement / guards (tests, lint, review
checklist).

## Alternatives Considered

Only when a future reader is likely to ask "why not X?" Keep it short.
```

## Validation

Before committing KB changes, run:

```bash
.agents/scripts/check.sh
```

It validates links, archive reachability, and decision index completeness.
Failures are noisy on purpose; CI will reject anything the script rejects.
