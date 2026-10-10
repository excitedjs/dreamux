# Independent draft review: Seed

Recorded by the TeamLeader from the independent read-only report on 2026-10-10.
The reviewer reconstructed the user story before evaluating the draft, read
upstream source after #466, and made no edits or runtime checks. This records
the reviewer's arguments; the final solution owns adjudication.

## Conclusion

The instance owner and direct typed-client path are the smallest coherent
mechanism. No host execution service, durable handle or second classifier is
needed. Before finalizing, settle outcome naming and disclose input echo.

## Findings

1. **Do not overload provisioning's `unsubmitted` shape.** Its existing
   `message` payload differs from the new precondition `reason` payload;
   the new union cannot be passed to existing broad outcome helpers unchanged.
   Prefer an independent precondition status. This is a naming decision,
   not a blocker for the mechanism.
2. **No anchor claim does not mean no input echo.** Core's agent service
   projects input before runtime admission. The Feishu COT subscriber
   suppresses ordinary chat echoes using correlations registered by
   `beginInboundSubmission`. The new direct path registers no correlation,
   so an existing standing anchor can display the input as role `user` in
   the `input` namespace. Without an anchor there is no display. State whether
   this existing event behavior remains or whether suppression is intended,
   and observe it explicitly instead of claiming display neutrality.
3. **Explain reminder choice for timer input.** The generic chat reminder
   may be irrelevant to some timer decisions. The optional override prevents
   a functional blocker, but document that a caller may supply its own note
   or deliberately use an empty note. The reviewer suggests timer callers
   make that choice explicit rather than receiving a default silently.

## Supported premises and limitations

- A synchronous committed-routing check followed by typed invocation does
  not promise a routing/Core transaction. A later rebind cannot retarget the
  captured call; this window is already disclosed correctly.
- Keeping business recovery and scheduling outside the host is correct.
- The reviewer supports lifecycle-owned readiness, unlike the other review's
  lower-state alternative; this remains a design argument for adjudication.
- Two-instance behavior and the exact no-anchor/standing-anchor display
  branches have not been run. The report supplies source evidence, not
  implementation acceptance or development authorization.

The reviewer did not compare the proposed echo against the downstream's current
direct submission path. That comparison belongs to the TeamLeader's final
adjudication; no new product policy is established by this report.
