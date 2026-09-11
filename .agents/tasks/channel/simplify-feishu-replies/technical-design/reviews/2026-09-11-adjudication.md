# Solution review: Claude and DeepSeek adjudication

Status: completed using the two received reviews. The operator explicitly ended
the wait for Seed and selected Claude and DeepSeek's work as the review basis.
Seed was closed with its incomplete history retained; no Seed verdict is claimed.

Conclusion at the time of the array-inclusive review (superseded in part by the
later scope reduction below): the native-Feishu direction stands. Two correctness
gaps in that strict identity-array proposal were accepted: incompatible-state error
propagation and the routing store's field-validation boundary. The reconciled
solution now specifies both. Code-input coverage and public-consumer accounting
are clarified; withdrawn findings do not become implementation mechanisms.
This is solution adjudication, not a fresh reviewer pass of the revised document
or implementation authorization. Source HEAD remains unchanged.

## Subsequent operator scope reduction

After the review summary, the operator ruled:

> 这样，Identity 改数组本期不做了。你只要确保自上而下的字符串是拼接起来的就可以了。

The current solution therefore keeps string identity and existing persisted
formats. Claude F1/R1, F2/R2, F3 and DeepSeek's identity-format note no longer drive
implementation in this release: their triggering format change is removed.
The proposed version bumps, scalar-rejection checks, error-propagation changes,
and rebuild requirements are removed with it. This is a scope change, not a
refutation of the reviewers' conditional findings. The historical adjudication
below remains evidence for the original proposal, not the current work list.
Native-Feishu, code-coverage, and public-consumer dispositions still apply.
No additional review result or development approval is claimed.

## Subsequent transport consumer-scope ruling

> 不用考虑 claudemux 了，那个已经archive 了。
> feishu-transport 就是当前仓库唯一的使用者，我没有把这个玩意对外提供给别人使用的预期

External compatibility no longer supports retaining the renderer, shared
`editText`, or obsolete helpers. The current solution removes those unused
mechanisms after native-post/semantic parsing take over; it keeps raw card I/O
and native COT for their current callers. The verified historical claudemux
imports below remain accurate evidence of that inspected revision, but are not
a present product requirement. Claude F4's earlier preservation disposition is
superseded by this operator ruling, not by a new factual claim about those imports.
The pure splitter may now move because its renderer owner is being retired;
its earlier alleged card-mechanism dependency remains refuted.

## Finding accounting (historical array-inclusive proposal)

| Finding | Source-grounded disposition |
| --- | --- |
| DeepSeek F1 | Persisted shapes change, but release notes and owning documentation are already required. The reviewer corrected the claimed omission. Record actual upgrade effects without promoting a reviewer's interpretation of the operator's waiver into a ruling. |
| DeepSeek F2 | Withdrawn after recheck. Reply and introduce acknowledgement use the same `transport.send`, so both become post. Name the latter in presentation-change accounting; it does not keep the renderer alive. |
| DeepSeek F3 | Withdrawn after recheck. The splitter has no imports, card types, or card constants. Directory placement is not a mechanism dependency. |
| Claude F1 / R1 | Accept the missing incompatible-state error-propagation contract. Writers always emit the field, with string or null values, not always null. An ordinary new validation error would be swallowed as absence. Strict array storage must reject unsupported state without replacing identities or reclaiming Team names. |
| Claude F2 / R2 | Accept the need to attach the changed space schema to `routing/store.ts:validated()`. It exists but checks the document envelope, not identity fields. Enforce the contract at this schema/version owner rather than provisioning. |
| Claude F3 | Conditional release-note consequence of the chosen state boundary. Describe actual startup/recovery effects; no live deletion or rebuild is authorized by a review. |
| Claude F4 / R5 | The external renderer consumer is now verified. Retaining the public renderer and `mentionName` has a real caller. Narrow the independent external `FeishuTransport.send` claim, which that consumer does not establish. |
| Claude F4 helper move | Reject as a required change: `render/split.ts` is already a pure independently importable helper. Reuse requires neither a wrapper nor relocation based only on its directory name. |
| Claude F5 / R4 | Accept explicit regression coverage for legacy post text rows forming a fence. Native `code`/`code_block` already produce code parts; styled text produces inline spans. The claimed omission of native Markdown code-part production is refuted by frozen `final.md:344`: "Transport owns these code boundaries and emits code parts." Clarify source coverage without adding a parser. |
| Claude F6 / R3 | Withdrawn as a finding. The plan already consolidates sending. Name `client.request` and removal of `MessageApiWithReply` to make the intended deletion explicit. |

Claude withdrew reader-side scalar acceptance as historical compatibility
behavior. The permanently string-valued MCP input is a separate forward contract.
Persisting one joined scalar would lose independent identity fragment boundaries
through restore; it is not an equivalent implementation of the array requirement.

## State-read failure evidence

- `team-collection/store.ts:85-98`: `get` returns null on any parse error, and
  `list` consumes `get`. `readTeam` already checks a record version.
- `agent-entity/identity-store.ts:144-158`: only `LegacyStateError` is rethrown;
  other parse errors become warnings and null.
- `dispatcher-service/identity.ts:62-88`: null from the reader triggers an
  `upsert` of a fresh identity with null session ID and empty skill sources.
- `feishu-channel.ts:364-369,422-444`: `TEAM_NOT_FOUND` on a bound delivery leads
  to route removal and resubmission to the Dispatcher.
- `routing/store.ts:145-180`: `validated()` owns envelope/version checks and
  currently casts through space rows. Enforce arrays before consumers spread
  the field.

The reconciled proposal uses the existing versions and `LegacyStateError` for
the strict-format boundary, with the proposed versions advancing to 2. It
specifies rejection propagation and untouched files, distinguishing unsupported
state from ordinary absence. The resulting old-state rejection and manual
rebuild consequence must be visible before development approval; no actual
cleanup is authorized. These findings do not justify a migration manager,
address ledger, or consumer-side old-shape adapter.

## Verified public consumer

Primary-source inspection used public `excitedjs/claudemux` commit
`83bb8b962c41bda3a564dc0c058fca78e7ca4cd3`, with a complete repository tree response.
The following files were fetched at that immutable revision:

- [Manifest](https://github.com/excitedjs/claudemux/blob/83bb8b962c41bda3a564dc0c058fca78e7ca4cd3/plugins/feishu-channel/package.json#L15)
  pins `@excitedjs/feishu-transport` to `0.0.2`.
- [Local transport](https://github.com/excitedjs/claudemux/blob/83bb8b962c41bda3a564dc0c058fca78e7ca4cd3/plugins/feishu-channel/src/feishu.ts#L37)
  imports `cardToContent`, `renderMarkdownToCards`, and `RenderedCard`. Calls at
  lines 245 and 707 serve its own edit and send paths.
- [Edit tool](https://github.com/excitedjs/claudemux/blob/83bb8b962c41bda3a564dc0c058fca78e7ca4cd3/plugins/feishu-channel/src/server.ts#L525)
  calls the consumer's local `transport.editText`.
- [Message handler](https://github.com/excitedjs/claudemux/blob/83bb8b962c41bda3a564dc0c058fca78e7ca4cd3/plugins/feishu-channel/src/handlers/im-message.ts#L14)
  imports shared `mentionName`, with production calls at lines 78 and 95.
- [Inbound formatting](https://github.com/excitedjs/claudemux/blob/83bb8b962c41bda3a564dc0c058fca78e7ca4cd3/plugins/feishu-channel/src/inbound-content.ts#L143)
  defines a local `applyMentions`; it is not a shared-package helper call.

This proves renderer and `mentionName` use. It does not prove an external caller
of shared `FeishuTransport.send`, shared `editText`, or shared `applyMentions`, nor
prove that none exists elsewhere. The dependency is pinned: a removal affects
that consumer's future upgrade, not its running pinned installation. Retention
must state actual evidence and scope judgment without inventing current callers.

## Remaining work

Report these dispositions to the operator and synchronize the public
solution-review Issue with the reconciled local proposal before development.
Development still requires the operator's explicit interactive-card approval.
No product code, tests, runtime configuration, or live persisted state changed
in this adjudication. The documentation checks do not substitute for the planned
implementation checks.
