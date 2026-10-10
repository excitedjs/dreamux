# TeamLeader solution-review adjudication

The operator selected a TeamLeader draft with independent Seed, Codex and Claude
reviews. The final solution is `../final.md`. Review reports preserve each seat's
evidence and may refer to earlier draft text. This table owns the decisions.

| Finding | Decision and source basis |
| --- | --- |
| Codex F1: Claude version boundary | Withdrawn under the operator's explicit simplicity ruling. Reuse the existing protocol; record the test binary version only. No Claude gate, probe or compatibility layer. |
| Codex F2; Seed D2: host queues | Delete the host queues. Current Claude binary serializes bridge actions natively. Codex common.rs assigns switching and pairing separate scopes; native pairing rechecks enabled state before returning. Use Claude request-ID correlation and existing close settlement, not the additional promise execution chain suggested by Seed. |
| Claude F1: internal startup override | Delete it. The requirement removes Dreamux's saved/global setting, not native preferences. The decisive reason is scope and unnecessary override, not a claim that no external client can save a preference. |
| Claude F2; Seed D1/D3 | Delete the optional-method guard and status echo. The live action is mandatory like interrupt; the caller already knows the action. Return connection information only. |
| Seed B2; Claude F2 | Define missing URL/manual code and pairing errors as provider errors that also state the earlier enable acknowledgement. No new partial-result type, automatic rollback or assertion that the current state remains enabled. |
| Claude F3: forwarding family | Accept the accounting omission. List all five forwarding methods and the cleanup recorded with PR #444; preserve current access/admission ownership in this bounded task. Do not evade the line gate. |
| Claude F4; Seed B1: Codex floor | Keep doctor/onboard-only enforcement and an ordinary note; no new launch restriction. Propose one constant change to 0.140.0 for ephemeral params. Config-key removal alone is upgrade-blocking. |
| Seed B1: old-version persistence claims | Reject this factual portion. At rust-v0.137.0 and rust-v0.139.0, enable/disable take Option<()>; startup defaults remote_control_enabled to false and enable changes an in-memory boolean. They do not use the later durable preference implementation. Object params are expected to produce a native deserialization error; no live old-version result is claimed. |
| Seed D4 and minor corrections | Add no timeout branch or test. State expiry conversion from seconds explicitly. Update the stale experimental-method handshake comment in implementation. |
| Multi-instance relay behavior | Leave as implementation-stage evidence. Shared registration alone proves neither successful isolation nor connection interference. Add no speculative home/transport/registration machinery. |

All source-backed design findings are resolved in the final solution. No further
design review round is required for these deletions and factual corrections.
Implementation and native live acceptance have not started and need operator
approval against the final requirement and solution.

## Return-shape clarification

During approval review, the operator asked whether the connection result was
aligned between providers, then explicitly selected a record because future
providers may return different information. The final signature is
`Promise<Record<string, JsonValue>>`. The dedicated connection type, union of
the two built-in shapes, and `null` return are removed; no additional information
is `{}`. Provider-owned entries pass through core for generic channel display.
The operator's result-shape decision was not development approval.
