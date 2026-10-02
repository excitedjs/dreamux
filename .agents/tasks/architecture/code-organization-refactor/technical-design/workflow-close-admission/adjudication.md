# R73 solution adjudication

## Status

Complete. Three independent proposals and the single cross-review round have
settled. The TeamLeader verified every material claim against source and selected
the [final solution](final.md). No unresolved product question or material
technical disagreement remains. The operator explicitly approved development
against this final solution on 2026-10-02 before the implementation writer
started; the task README owns the sent-card and approving-response evidence.

## Source checks of initial claims

| Claim | Disposition |
| --- | --- |
| Admission belongs at `TeammateCollection.createLocked` | Supported: the collection already holds the actual owner and owns allocation/publication. Every neighboring caller verb uses that owner. |
| Retain the outer Dispatcher wrapper after adding collection admission | Rejected: two checks would occur in separate promise continuations. Close between them could retract the outer admission, violating the preserved pre-close admission boundary. |
| The unfenced verb was merely an accidental oversight | Too broad: the R71 final design explicitly preserved that asymmetry pending a product ruling. R73 now settles it; do not rewrite its history. |
| The new early Team refusal must preserve the old late refusal's Dispatcher wording | Rejected as an interpretation of revision 1. The requirement preserves Team-then-Dispatcher owner ordering and the existing owner error contracts. Newly refused requests use that owner; the separate already-admitted late-publication error remains unchanged. Disclose the earlier Team error in the final design. |
| The public async signature may be removed because the declared result type stays a Promise | Not selected: `WorkFence.admit` can throw synchronously. Keep `async createLocked` so direct collection callers continue receiving a rejected Promise. Workflow handles both forms, but preserving this boundary costs no new mechanism. |
| The entire admitted construction is time-bounded disk IO | Not established: construction includes awaited launch taps, and foreign tap duration is not bounded. State that the tracked span ends at construction/lock handoff, rather than at a submitted turn; do not promise a time bound or add a timeout. |
| R73 requires run-level cancellation or suppressing every failed call | Rejected: existing `executeAgent` catches the refusal, classifies its call from the already-reserved terminal intent, and releases its semaphore slot. The operator ruled only on new construction. |
| A refused Team-close construction guarantees a stopped Workflow run | Not established: the existing runner may reserve a natural completed/failed terminal intent before Workflow stop reaches it. Preserve terminal arbitration rather than promising a uniform terminal status. |

## Selected details and rejected overclaims

Select Codex's inline admitted body while retaining the public async method;
MiMo and DeepSeek's private helper is an equivalent same-owner spelling, not
an architectural defect. The final design chooses the smaller implementation
without elevating that spelling into a new repository rule.

All authors accepted public async retention, one admission, separate early and
late errors, and no timing promise for launch taps. Their historical initial
drafts retain superseded claims; the appendices and final solution control the
implementation. DeepSeek appended a further factual correction withdrawing
its contradictory always-stopped run claim. MiMo's failed-before-stop example
does not exclude completed winning first: `requestTerminal` and `reserveStop`
preserve whichever terminal intent was already reserved. Both completed and
failed may therefore survive a later stop request. No error classification or
terminal-preemption change is selected.

Retain the narrow `WorkflowTeammateFactory` interface; removing its obsolete
wrapper comment is sufficient. No public construction capability, tool, CLI
surface, persisted schema, or provider feature is removed. R72 requires only
recording that existing onboard behavior is accepted, not preserving unknown
wrappers through a new mechanism.

## Verification limits

Current surviving Workflow runner tests do not exercise real collection
admission. Four green Rush gates would therefore be build/regression evidence,
not proof of the new close race. Preserve R43's child-test boundary and record
focused real-owner admission/handoff cases for final PR #453 coverage. Any
implementation-phase acceptance evidence must distinguish controlled local
providers from a live-provider run.
