# Independent draft review: DeepSeek

Recorded by the TeamLeader from the independent read-only report on 2026-10-10.
The reviewer read the requirement, draft and upstream source after #466, did not
read other reviewers, and made no edits or runtime checks. This records the
reviewer's arguments; the final solution owns adjudication.

## Conclusion

The main owner and mechanism are coherent: one instance method, an effective
binding precondition, no provisioning/fallback and no implicit anchor claim.
No evidenced functional blocker was found. Two additions need requirement
accounting, and three type/contract details need precision.

## Findings

1. **Readiness adds an unrequested lifecycle fact.** The existing lifecycle
   distinguishes only alive/aborted. The requirement says usable after start,
   not that pre-start contract violations need a separate typed refusal.
   `session/session.ts` initializes the command client before extension
   initialization, so a pre-start submit would actually work. Other outbound
   APIs rely on the documented initialize-local-IO-only obligation instead of
   a start gate. Prefer extending that obligation to the new method. If an
   activation fact is retained, only `OwnedFeishuLifecycle` may activate it.
2. **Reminder preservation is absent from the requirement.** An optional
   replacement preserves existing extension-owned model instructions, but
   can suppress `CHANNEL_REMINDER`. Its omission would also change real
   downstream behavior. Account for preservation explicitly and distinguish
   replacement from concatenation; do not hide this policy in implementation.
3. **The new `unsubmitted` payload collides with provisioning's payload.**
   Existing `FeishuSubmitOutcome.unsubmitted` means provisioning produced no
   recipient and carries a message; the draft replaces it with reason codes.
   Prefer a distinct precondition discriminant, or explicitly explain the
   changed meaning and payload.
4. **Name the exact narrower command return declaration.** The Core-only
   parser and the command client wrapper produce different subsets. Narrow
   the client's `teamSubmit` return type, including caught rejection/error,
   and reuse one named command-outcome type rather than an unexplained
   type-level subtraction or a second classifier.
5. **Attribute precedence differs from existing card forwards.**
   `session/card-actions.ts` puts caller attrs last. The draft makes channel
   address fields authoritative. Explain the intentional difference while
   preserving the existing forward contract.

## Supported premises and acceptance additions

- `routing.plan(target, null)` is also the existing `owner` implementation,
  observes committed routing and resolves topic inheritance synchronously.
- Payload/presentation separation is coherent: Core consumes no anchor;
  claiming one is the submitter's display responsibility.
- Lifecycle tracking registers synchronously and can drain a command to its
  actual answer even after abort. Commands do not accept a cancellation signal.
- The downstream removal account preserves cwd, binding and legacy-journal
  state-root discovery; it does not delete the entire bridge.
- Observe no new pre-admission receipt as well as no anchor move. If reminder
  replacement and address precedence remain, verify both through the real
  command payload, including one Core-rendered reminder slot.
- Explain when new authors should choose detached `forward` versus the new
  operation. New delivery does not establish an absent presentation anchor.

No runtime evidence is supplied. The narrow no-anchor scenario and pre-start
behavior of existing transport operations remain source-based observations.
