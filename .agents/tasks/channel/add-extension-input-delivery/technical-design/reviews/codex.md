# Independent draft review: Codex

Recorded by the TeamLeader from the independent read-only report on 2026-10-10.
The reviewer read the requirement, draft and upstream source after #466, did not
read other reviewers, and made no edits or runtime checks. This records the
reviewer's arguments; the final solution owns adjudication.

## Conclusion

No evidenced architecture blocker was found. The draft retains the existing
owners, adds no host execution service and keeps business reliability out of
Core. One acceptance gap and two public statements need correction.

## Findings

1. **Exercise real host publication in the integration arm.** Existing
   `tests/feishu-extensions.test.ts` manually constructs a host and calls
   plugin contribution/server methods. It cannot prove the real
   `packages/dreamux/src/plugin/host.ts` server-then-publication sequence.
   Register the test extension through that real publication hook, then use
   the real provider/session and Core. No extra test framework is required.
2. **Limit the display-neutral claim to no explicit anchor claim.**
   Bypassing `beginInboundSubmission` prevents anchor advancement,
   correlation registration and a pre-admission receipt. It does not silence
   later Core input events. The COT adapter can append an uncorrelated input
   at an existing standing anchor or create a presentation there. Explain
   this conditional behavior and observe it in the anchor regression arm;
   do not add suppression flags or special attrs.
3. **State source identity's actual scope and empty-value semantics.**
   Core keys include the recipient entity and source ID, not channel or
   extension origin. Empty IDs bypass deduplication. Retries of one decision
   need the same ID, and distinct decisions for the same recipient need
   distinct IDs. Decide whether empty IDs are valid here; do not add a new
   ledger or automatic instance namespace.

## Supported premises and qualification

- Routing is an invocation-time check of committed bindings, not a transaction
  with Core. No fallback/provisioning is correct for this new operation.
- Actual outcomes reuse the typed client; no second classifier is necessary.
- The reviewer supports a lifecycle-owned readiness fact because `isLive`
  does not represent bot startup. This is a design argument rather than a
  source requirement for a new pre-start refusal; final adjudication must
  resolve it against the existing initialize/start calling obligation.
- The payload split does not create a second admission owner.
- Removing sibling delivery ports does not remove journal/unknown/repaint
  policy or solve downstream timer and persistence-order defects.

All new behavior, close concurrency and assembly acceptance remain unrun.
No finding or review conclusion grants development approval.
