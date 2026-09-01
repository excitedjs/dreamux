# Feishu sender-name reliability and minimal attachment markup

- **Status:** Implemented; current behavior is in
  [Channel runtime](/.agents/domains/channel.md) and
  [Feishu inbound attachments](/.agents/tasks/channel/feishu-access-foundations/requirement.md#feishu-inbound-attachments)
- **Date:** 2026-07-23
- **Affects:** `@excitedjs/feishu-transport`,
  `@excitedjs/feishu-channel`, model-visible Feishu inbound turns
- **Related design:**
  [Feishu inbound structured body](feishu-inbound-structured-body.md),
  [Feishu inbound attachments](/.agents/tasks/channel/feishu-access-foundations/requirement.md#feishu-inbound-attachments)

## Intent

Make accepted Feishu messages identify a human sender reliably enough for the
current message, while reducing inline attachment markup to the minimum facts
the model can act on.

## Verified pre-change facts

- Feishu receive events normally carry a sender `open_id` but no display name.
  Dreamux therefore uses the optional `contact.v3.user.get` transport seam
  after the access gate accepts the message.
- The configured bot can resolve the current sender and has the required
  permission. A live bot-identity lookup returned the correct name in 678 ms.
- The pre-change lookup budget was 800 ms at both the transport and Channel work
  boundaries. That leaves little room for cold connection and scheduling
  overhead. Source and tests confirm that a successful response arriving after
  the budget is discarded for that message. The live lookup does not prove
  that the observed nameless message crossed the boundary, because 678 ms is
  below 800 ms; the narrow budget is the leading reliability diagnosis, not a
  measured postmortem of that individual request.
- The pre-change Channel renderer repeated attachment facts. A downloaded
  resource exposed `type`, `name`, `key`, `path`, and `status`; a failed
  resource also exposed a separate `reason`. The neutral runtime attachment
  already carried the structured file fact independently of this model-visible
  XML.
- A later accepted message in the same live environment did contain the sender
  name. This proves the identity and permission path is viable; it does not make
  the 800 ms cold-path contract reliable.

## Scope

The transport-owned contact lookup budget becomes 2,000 ms. The Channel uses
the same upper bound or the remaining per-message enrichment deadline,
whichever is smaller. The lookup is awaited before submission and may
therefore add up to that bounded latency; it is not described as non-blocking.
The bound is roughly three times the measured 678 ms warm-path call, leaving
room for cold connection setup and scheduling jitter without consuming a large
share of the 60-second message enrichment deadline.
Event-provided names, accepted mention cache seeds, and known bot names still
avoid the API entirely.

The lookup remains best-effort. A timeout, transient error, missing scope,
session revocation, or missing name must not reject or indefinitely delay the
message. Existing per-transport positive caching, concurrent-miss
deduplication, per-user version fencing, mention precedence, and session abort
handling remain authoritative.

The transport caches only positive names. Every accepted unnamed human whose
positive cache misses starts or joins a same-user contact lookup. Feishu code
`99991672`, any other nonzero response, and transient failures affect only that
attempt; the next positive-cache miss retries the API. Per-user versions still
prevent stale names from overwriting a newer result or mention seed.

Only the Channel-owned inline XML becomes smaller:

```xml
<attachment path="/owned/cache/image-a1b2.jpg" />
```

is the complete representation of a successfully downloaded resource.

```xml
<attachment status="not_downloaded" key="img_example" />
```

is the complete representation when automatic download fails, is unsupported,
times out, or is skipped by an automatic-download limit. The existing detailed
reason remains available to diagnostics and the exported structured
`FormattedFeishuAttachment`; it is not repeated in model-visible XML.

When Feishu supplies no resource key, the failure markup remains honest as
`<attachment status="not_downloaded" key="" />`. It must not invent a key.

The outer Channel `message_id` plus the resource key preserve the lookup
identity requested by the operator. The current lark-cli resource-download
command also requires a `type` flag; current Feishu keys make that value
typically derivable (`img_...` maps to `image`, while `file_...` maps to
`file`), but not every documented image key has such a prefix. The operator has
explicitly chosen not to repeat `type` in the attachment XML. The renderer does
not add a command or tool hint. Resource
type/name and the downloaded local path remain available to the neutral runtime
attachment where applicable; status/reason remain in the exported
`FormattedFeishuAttachment` and diagnostics rather than being duplicated into
successful inline markup.

The key is model-visible only for a non-downloaded resource. A downloaded
resource is identified to the model by its local path and deliberately does not
retain the key in inline XML.

This model-visible shape supersedes the verbose attachment examples and
attribute list in the accepted
[Feishu inbound attachment decision](/.agents/tasks/channel/feishu-access-foundations/requirement.md#feishu-inbound-attachments).
That decision and the current Channel runtime reference must be updated in the
same change. In particular, a successful inline attachment intentionally stops
retaining the key after the cache path is available.

## Constraints

- `@excitedjs/feishu-transport` remains the SDK and contact-cache owner.
- `@excitedjs/feishu-channel` remains the model-visible XML and
  download/cache-policy owner.
- Dreamux core and Agent Runtime interfaces gain no Feishu-specific fields.
- No persistent identity store, extra message read, user-token fallback, or
  required permission is introduced.
- The sender lookup still occurs only after access acceptance. Dropped and
  pairing-only messages perform no contact read.
- Session close must still revoke a pending lookup and prevent stale
  submission or cache overwrite.
- Attachment occurrence order, download de-duplication, cache limits, neutral
  runtime attachments, diagnostics, XML escaping, and the 160,000-character
  body cap remain unchanged.

## Acceptance

- A production transport lookup resolving at 1,200 ms supplies `sender_name`
  to the same accepted message; the previous 800 ms contract would fail this
  case. Tests do not assert success exactly at the 2,000 ms timer boundary.
- A lookup beyond 2,000 ms degrades and delivery continues after the bounded
  wait. A later attempt can retry, and stale/aborted responses cannot overwrite
  a newer mention or contact result.
- Repeated `99991672` responses affect only their individual attempts. A later
  positive-cache miss for the same or a different user still performs a
  contact read, and a later successful name is positively cached.
- Event-provided, mention-seeded, and known-bot names still perform zero
  contact reads.
- Missing-scope, transient-error, timeout, concurrent lookup, retry, and
  stop/restart lifecycle tests remain green.
- Every downloaded inline occurrence renders exactly
  `<attachment path="..." />`, with no `type`, `name`, `key`, `status`, or
  `reason` attribute.
- Every non-downloaded inline occurrence renders exactly
  `<attachment status="not_downloaded" key="..." />`, with no `type`, `name`,
  `path`, or `reason` attribute. A missing key is represented by an empty
  escaped `key` value.
- Repeated resource occurrences retain their original positions while sharing
  one fetch/cache result and one neutral runtime attachment.
- Adversarial paths and keys are escaped exactly once and cannot forge Channel
  markup.
- At least one integration test injects the SDK client into the real
  `createFeishuTransport` path and drives a raw receive event through access
  acceptance, the real sender resolver, Channel session, and submitted turn.
  A companion close/restart test proves a late real-resolver result cannot
  mutate the positive cache or submit through a stale session.
- Feishu Channel and Transport typecheck, lint, focused tests, full repository
  tests, change verification, knowledge-base validation, and public-artifact
  secret scanning pass normally.

## Out of scope

- Expanding merged-forward or quoted message bodies.
- Persisting sender names across process restarts.
- Naming bot/app senders absent from the event and known-bot ledger.
- Changing lark-cli, adding a model-facing download instruction, or changing
  Feishu resource API semantics.
- Changing attachment download size, count, aggregate-byte, or time limits.

## Complexity-reduction follow-up

The review follow-up keeps the surrounding Linuxbrew, PATH, onboard, and release
work in the same change while reducing Feishu inbound state and test duplication:

- Ordered content `parts` are the sole internal representation. Compatibility
  `text` and de-duplicated `resources` are projected once at the transport
  boundary; positional resource occurrences remain ordered and share one
  download per unique resource.
- One Channel-owned bounded-operation primitive provides absolute deadlines,
  session abort fencing, settle-once cleanup, and optional late-value cleanup.
  Attachment count and byte budgets belong to the attachment resolver, and
  session object identity fences restarts.
- Production-path tests use the real `createFeishuTransport` normalization path
  with only SDK and WebSocket edges injected, including sender-name coverage.
- Each accepted unnamed human message makes one thin contact lookup attempt.
  Event names and known bot names still avoid the API; the Channel bounds the
  attempt by the lesser of two seconds and the remaining global deadline.
  Failures, malformed responses, nonzero codes, aborts, and timeouts affect only
  that message and never suppress the next lookup.

This simplification must preserve post/card parsing, source order and escaping,
lazy merged-forward and reply references, quoted parent type, attachment and
render budgets, one fetch per unique resource, session close/drain and late
cleanup, route verification, the 60-second global deadline, per-operation
deadlines, and issue #63 non-blocking submission.
