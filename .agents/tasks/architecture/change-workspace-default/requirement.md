# Requirement

## Operator wording

Scope clarification, 2026-09-11 12:23:

> 我明确一下需求啊，只把workspace 的默认值改了，

The TeamLeader restated only `true` to `false`, with explicit configuration
preserved, and waited for separate development authorization.

Development authorization, 2026-09-11 13:04:

> 开始开发

## Current alignment

- Current source at `2de0689b` defaults workspace isolation to true in the
  configuration loader, its default lookup, and the new-dispatcher onboarding seed.
- Required change: Set that default to false. Explicit true and false keep their
  existing meaning and survive configuration round-trips and re-onboarding.
- Scope is only this default change. No Team creation contract or other behavior
  is added to the request.

## Acceptance criteria

- Omitted workspace policy, an empty workspace object, the default lookup, and
  newly onboarded dispatchers consistently use false.
- Explicit configuration remains unchanged; existing isolation behavior is retained.
- Regression checks and current documentation state the same default.

## Decisions and unknowns

- No blocking unknowns or additional product decisions are needed.
