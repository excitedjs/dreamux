# Contributing to the dreamux knowledge base

This file is for *writers* of `.agents/` content. Readers should start at
[`root.md`](root.md).

## Knowledge-delta protocol

Before finishing any non-trivial change, ask:

> Did this move a component boundary, a cross-process protocol, a CLI
> command surface, a release-relevant decision, or an architecture
> invariant?

If **yes**: update the KB in the same PR. A correct system with a stale
KB is worse than a buggy system whose KB tells you exactly where to look.

If **no** (bug fix inside one function, an obvious refactor, a TODO):
don't write a KB entry just to look diligent. The KB earns its keep by
being terse.

### Typical YES

- new package added / removed under `packages/`
- a CLI subcommand added / removed / renamed (issue #4 made `dreamux` the
  unified surface — see [the CLI naming decision](decisions/cli-and-package-naming.md))
- a settled design decision after debate (write a decision record)
- a new external dependency that materially shapes the runtime (a
  database engine swap, a new IPC mechanism)
- a Codex / Feishu protocol version bump that required code changes

### Typical NO

- a bug fix inside one function whose contract didn't change
- a test added for an already-documented behavior
- refactors that don't move boundaries
- in-progress scratch notes — those go in your PR description, not here

## How to write

- **English.** All KB content in English regardless of conversation
  language. (Repo-level rule, see [`/CLAUDE.md`](../CLAUDE.md).)
- **Short.** Bullets over paragraphs. Verify each claim against code
  before committing — KB drift is more costly than missing content.
- **Repo-root-absolute links** (start with `/`): `/packages/dreamux/src/...`,
  `/CLAUDE.md`. Avoid `../../` chains; they break when files move.
- **Cite the source.** Decision records name the PR / issue / commit
  that made them concrete. Component docs link the source files they
  describe.

## Document kinds

| Kind | When to use | Naming |
|---|---|---|
| `components/<thing>.md` | A piece big enough to have its own contract / mental model (server, CLI, codex-client, feishu-bot, repo-structure) | kebab-case, no number |
| `decisions/<slug>.md` | A choice that was debated and settled; future maintainers need the *why* | topic slug, kebab-case, no sequence number |
| `domains/<area>.md` | A cross-cutting contract that spans multiple components | kebab-case |
| `proposals/<slug>.md` | An active design under discussion | kebab-case |
| `research/<slug>.md` | A frozen investigation snapshot; must end with an explicit "disposition" section (Promoted / Deferred / Out of scope) | kebab-case |
| `rules/<slug>.md` | A process rule that applies to KB authors themselves | kebab-case |

## Decision record template

```markdown
# <decision title>

- **Status:** Accepted | In progress | Superseded by [link]
- **Date:** YYYY-MM-DD
- **Affects:** components / packages / surfaces
- **PR / Issue:** link

## Context

The forces — what made this a decision worth recording.

## Decision

What was chosen. One sentence if possible.

## Consequences

Costs, constraints, foot-guns, and enforcement / guards (tests, lint
rules, code review checklist).

## Alternatives considered (optional)

Only when a future reader is likely to ask "why not X?" — keep it short.
```

## Validation

Before committing KB changes, run:

```bash
.agents/scripts/check.sh
```

It validates internal links and surfaces any orphaned files. Failures
are noisy on purpose; CI will reject anything the script rejects.
