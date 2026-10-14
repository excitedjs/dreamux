# Greenfield cross-review input

All three independent requirement-revision-3 greenfield proposals have been
received. Read only their current greenfield sections as current positions;
earlier rounds remain history. Perform exactly one cross-review and append
your accepted/rejected arguments, source corrections and complete revised
recommendation to your own assigned file. Product and implementation hold
boundaries remain as recorded in `greenfield-input.md`.

The TeamLeader's [working notes](/.agents/tasks/mcp/enable-team-member-messaging/technical-design/greenfield-root-notes.md)
are hypotheses and concrete falsification cases, not a preferred answer to
adopt. Compare a single Core reporting owner consuming two legitimate inputs
with a single authoritative notification event; do not conflate those claims.

## Required source adjudication

1. **Test the proposed payload partition against the actual Codex interruption.**
   `turn-manager.ts:finalize` omits result publication for interrupted native
   terminals, but still settles bound submissions with `kind: completion` and
   a completed/partial-text `RuntimeCompletion`. The baseline already did so;
   the delivered adapter test explicitly preserves it. It is not exclusively
   a tokenless stopped/failed answer. Show the exact recipient/outcome/wording
   in your design for this case. If the partition needs a new distinction,
   name its public contract and authoring cost; do not silently change the
   result or expand unbound interruption reporting.
2. **Complete the single-event correspondence model.** MiMo's event carries
   `answered: RuntimeRequest[]`, while current `submit` returns a provider-owned
   submission asynchronously. A terminal may precede the admission response.
   Specify who creates a request handle, when Core binds its reply recipient,
   how the provider refers to it, and how event-time policy finds that binding
   without losing order, waiting on an unknown promise, leaking Core types or
   adding unnamed admission bookkeeping. A keyed input correlation or object
   lookup is an identity mechanism too; distinguish it from completion identity
   rather than claiming all identity disappeared. Rejected/skipped/ambiguous
   admissions, folded requests and close racing admission must remain coherent.
3. **Enumerate residual consumers before claiming deletion.** Explicitly
   requested TeamLeader replies can fold N requests into one result (Q5).
   Workflow reads `Turn.settled`; `teamSubmitResult` publicly returns
   `turn_id`. Describe what preserves those consumers and what identity/fold
   semantics actually remain after member reports become single-source.
4. **Do not delete an admission fence as a forwarding hop.** Current
   `DispatcherService.submitInput` uses the aggregate `fence.admit`;
   `DispatcherAgent.submitInput` directly calls its Agent. If unifying owner
   ports, say where that gate lives after the change, preserve queued-delivery
   semantics and prepared-agent lookup points, and count any new wrappers or
   methods honestly. Scope ownership and contained recipient are distinct facts.
5. **Separate ideal adoption from current compatibility facts.** A native-only
   member route loses bound reporting too when an old provider never emits the
   new event; it is not the delivered overlapping shape's bound-only behavior.
   Give both host/provider skew directions without treating a README minimum
   version as runtime enforcement. Unknown external inventories affect adoption
   risk, not whether the ideal can be derived. Follow the repository's ordinary
   API change-note policy; no persisted migration was authorized.

Compare the complete revised mechanisms on concepts, maintained state,
cross-layer hops and real removals, not votes or line counts. Return a concrete
recommendation and its strongest surviving counterexample. Do not call a
source-resolvable fact or a hypothetical future recipient a product blocker.
No new implementation or test work is authorized.
