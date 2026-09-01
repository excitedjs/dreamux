# Harness Gaps

## Current state

- Goal: Track the executable-guard gaps that let architecture drift survive CI, until each is implemented or deliberately rejected.
- State: `intake`
- Requirement: [Open gaps](/.agents/tasks/architecture/harness-gaps/requirement.md)
- Next action: Operator prioritization; each gap is independently implementable.

## Provenance

Distilled 2026-09-01 from the frozen
[post-110 sustainability research](/.agents/research/post-110-architecture-sustainability.md)
during the KB reorganization; per the operator's ruling, taste and style are
not enforced through lint/UT — these gaps are mechanical consistency guards,
not taste gates.
