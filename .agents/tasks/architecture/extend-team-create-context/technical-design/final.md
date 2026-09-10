# Implementation scope

## Ownership and behavior

Keep the existing owners. Configuration loading and onboarding own workspace
defaults; the worktree manager already implements both choices. Change defaults
to false and retain explicit values. Do not add a second workspace mechanism.

Add the selected optional `TeamCreateContext` to the neutral canonical command
type and schema. Include context in the existing request hash. Carry it through
the create call without interpreting its provider payload. Project it only on the
creation response and a `TeamCreatedEvent` in the existing dispatcher event stream.
Publish after a fresh creation succeeds; an idempotent existing result can project
the same metadata without republishing. The existing durable Team record stays
unchanged. The stream seals the new event with its normal JSON/event mechanism.

The Feishu channel subscribes through its existing session event registration.
Its handler recognizes `builtin:feishu`, validates the exact `{ chat_id, title }`
payload, uses the existing routing owner to bind, updates COT route ownership, and
sends the existing binding notification. Track handler work in the current
session lifecycle, log failures, and drain it on close. No new durable queue,
recovery registry, Core binding table, or transport primitive is required.

Provider recognition and payload parsing live in `feishu-team-create.ts`.
`FeishuBindingOperations` owns both manual binding and creation-event binding;
both use one private route-install operation for bind, release, claim, and card
notification. This preserves one owner for the sequence instead of copying it
into a second event handler. The existing listener-failure logger also handles
creation-event failures, with `event_kind` identifying the failed event.

## Verification

Cover omitted/empty/explicit workspace settings and onboarding preservation,
repository-free Team/TeamMate cwd selection, context parsing and request
idempotency, metadata absence on ordinary reads, single fresh creation events,
and Feishu binding/card/error/session-close behavior. Keep public fixtures
synthetic. Run all four repository gates through Rush: build, lint, test, and
typecheck:tests, plus knowledge and task checks. Independent review examines the
complete change against the selected behavior and current source.

## Scope and release

Implementation lives in the host, neutral types, and Feishu channel packages,
their tests, and current guidance. Existing runtime implementations and platform
extensions are not needed. Add ordinary change files for affected publishable
packages through Rush. Persisted files remain readable without manual action.

The previous policy isolated omitted-repository work by default. The operator now
wants shared cwd by default; explicit isolation remains available. The new
creation event adds a neutral creation fact so binding remains channel-owned.
Importing platform-specific logic into Core or persisting opaque context would
introduce ownership and state beyond the selected source behavior.
