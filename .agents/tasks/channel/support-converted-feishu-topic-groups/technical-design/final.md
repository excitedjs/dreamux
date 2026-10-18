# Support converted Feishu topic groups: final solution

Requirement input: [revision 2](/.agents/tasks/channel/support-converted-feishu-topic-groups/requirement.md), confirmed on 2026-10-13.
Source investigation: `next` after [PR #466](https://github.com/excitedjs/dreamux/pull/466); independent review and extension compatibility were checked against `next` after [PR #469](https://github.com/excitedjs/dreamux/pull/469).
Solution revision 1 incorporates the adjudicated independent review on 2026-10-13. Development authorization and its approved boundary are recorded in the [task README](/.agents/tasks/channel/support-converted-feishu-topic-groups/README.md#development-approval).

## User story and result

An operator registers an ordinary Feishu group using thread message format as a Collaboration Space. Accepted messages in its unbound topics receive their own Teams, just as native topic groups do. Switching to chat message format pauses automatic provisioning without losing the space policy or existing topic routes. Switching back restores provisioning without re-registration or a daemon restart.

Every saved explicit topic binding remains effective, including manual bindings and rebindings and bindings whose space policy has been removed. This wider rule was explicitly accepted by the operator. An ordinary group's unbound thread continues to its whole-chat binding, if any, or to the Dispatcher.

## Separate identity from permission to provision

Feishu's non-empty `thread_id` names the conversation. The group's current message format determines whether an unbound conversation can automatically receive a new Team. Those are different facts; the pre-change projection conflated them by making topic identity depend on `chat_mode=topic`.

Use the existing target kinds and existing binding-resolution order:

1. A group message carrying a non-empty `thread_id` projects to `topicTarget(chatId, threadId)` independently of current message format. Neither `root_id` nor `parent_id` substitutes for that identity.
2. A message without a thread retains its existing chat target. Direct chats retain their current non-bindable behavior.
3. An explicit topic binding wins, followed by a parent-group binding.
4. Only a still-unbound topic in a currently verified topic message format, with a registered space policy, enters automatic provisioning.
5. Otherwise the message reaches the Dispatcher.

| Platform information for a group message with a thread | Target | Automatic provisioning eligibility | Binding resolution |
| --- | --- | --- | --- |
| `chat_mode=topic` | Topic | Allowed | Existing topic, then parent group, then registered space |
| `chat_mode=group`, `group_message_type=thread` | Topic | Allowed | Same order as the native topic group |
| `chat_mode=group`, `group_message_type=chat` or absent | Topic | Disallowed | Existing topic, then parent group, else Dispatcher |
| Metadata lookup fails, times out, or returns no recognized mode | Topic | Disallowed | Existing topic, then parent group, else Dispatcher |

The missing-metadata row preserves authoritative existing bindings and does not invent permission to create a Team. Access and pairing still run before projection; this proposal does not admit a previously rejected sender.

## Owners and implementation

### Feishu transport: normalize the effective conversation format

In `packages/channel/feishu-transport/src/transport/feishu.ts`, extend the existing chat-get response description with `group_message_type`. Keep the optional `getChatMode(chatId)` signature and the existing `FeishuChatMode` union.

Its result denotes effective conversation format:

- raw `chat_mode=topic` returns `topic`;
- raw `chat_mode=group` with `group_message_type=thread` returns `topic`;
- other raw `group` results return `group`;
- raw `p2p` returns `p2p`;
- missing or unrecognized raw `chat_mode` still returns `undefined`.

The transport owns this Feishu field interpretation. Raw SDK fields do not enter Channel-neutral or Core contracts. Document the semantic adjustment to `getChatMode`: `topic` now includes ordinary groups using thread message format. Custom transports keep the same optional method and return type; they report effective format through that existing capability.

### Inbound targeting: fresh format observation, stable chat-kind knowledge

Give pure message identity a single owner in `packages/channel/feishu-channel/src/routing/target.ts`: a package-local `messageTarget(place)` helper composes the existing chat and topic constructors from `chatId`, optional `chatType`, and optional `threadId`. It performs no I/O. A group message with a non-empty thread id is a topic; a direct chat remains direct; a message whose API result supplies no chat kind retains the current group assumption. Neither reply ancestry nor a format lookup supplies identity.

In `packages/channel/feishu-channel/src/inbound/target.ts`, make `project(target, signal?)` accept that already normalized `FeishuTarget` and return the existing target plus its per-projection provisioning eligibility. `projectInbound` learns stable chat kind from the accepted event, calls the pure helper, and delegates to this projection. Only topic targets need the existing bounded chat-mode lookup to establish automatic provisioning eligibility.

Remove the session-lifetime `resolvedChatModes` cache. Replace it and `knownGroups` with one stable chat-kind map holding only `p2p` or `group`. Accepted inbound events teach that kind, and a successful platform lookup can establish it for the card-click access gate. The map never holds the mutable topic-versus-chat message format.

Retain the existing `pendingChatModes` map so simultaneous lookups for the same chat share one request. Remove each entry when that request settles. A later projection obtains a fresh platform result. Keep the existing two-second timeout, cancellation checks, and warning behavior; revise warning text to describe disabled provisioning instead of claiming that an observed thread has become a group target.

The class still reads no binding table and owns no routing policy. No dependency on `FeishuRouting`, space origin marker, format-change event subscription, expiry timer, persisted mode, or new recovery state is needed.

### Channel routing: carry the decision, not a duplicate chat identity

Replace the package-local projected `containerChatId: string | null` with `canProvision: boolean` on `FeishuInboundRoute` and the corresponding internal delivery inputs. The old field duplicated `target.chatId` and conflated a topic's parent with the ability to provision; a topic retains its parent even when provisioning is paused.

Change `FeishuRouting.plan(target, containerChatId)` to `plan(target, canProvision)`. It continues to resolve explicit and parent-group bindings first. Only when the still-unbound target is a topic and provisioning is permitted does it read the existing space policy by `target.chatId`. If no policy exists, it returns the Dispatcher plan. This topic-kind predicate is the routing owner's per-topic provisioning invariant, not a new input-validation or error mechanism. Targeting supplies a fresh format observation; routing still owns which kinds may receive a Team.

Propagate that package-local decision through the existing consumers, without a second route-selection implementation:

- `inbound/pipeline.ts`, `inbound/router.ts`, and the internal `FeishuInboundDelivery` shape in `feishu-submit.ts`;
- ask-user settlements and extension card forwards in `session/card-actions.ts`: obtain the card's actual target from the recorded landing through `messageTarget`, or through `outbound.locate`; then compute fresh eligibility once before ordinary delivery;
- message/card location in `outbound/index.ts`: `locate(messageId)` reads the message and returns its pure `FeishuTarget`, without a group-format lookup; remove the outbound object's now-unused targeting dependency;
- `feishu-extensions.ts`: `readMessageRoute` returns the target located above, and `sendCard` derives the target directly from the platform's send result through `messageTarget`. These identity-only paths perform no group-format lookup or format warning, and the instance API no longer needs a targeting dependency;
- both `owner(target)` and the newer `submitToBoundTeam` use binding-only plans with `canProvision=false`. Preserve the latter's synchronous expected-owner check immediately followed by ordinary typed Core submission. Do not add an awaited format lookup to that check or alter its result handling.

This propagation replaces an existing internal field; it adds no state, new route entity, or Core obligation. The persisted space policy's actual container chat identifier remains unchanged.

## Switches, failure boundaries, and compatibility

Changing group message format writes no routing state. The format is observed per projection, and only a verified topic-format result grants provisioning permission. There is no promise of an atomic transaction with an external Feishu setting change: a provisioning run already started under its captured policy completes under existing semantics; later inputs observe the current format.

Existing `team.create`, binding commit, submission, stale-Team reconciliation, and provisioning failure notices retain their current owners and behavior. Space unregistration continues to stop future provisioning without deleting old bindings or dissolving Teams.

`feishu-routing` schema, filenames, fields, and version stay unchanged. `space_id` remains its current origin metadata and is not promoted into an access or routing prerequisite. Existing records work after restart; no migration or manual rebuild is needed. API/MCP wire schemas and Core provider contracts do not change.

The accepted compatibility change is explicit: saved topic bindings in ordinary chat message format become effective. A group's unbound threads still fall back to its whole-chat binding, and messages without a thread retain their chat-level route.

Command addressing is explicit and remains tied to each existing entry point:

| Entry point | Addressing in chat message format |
| --- | --- |
| `/bind <team_name>` inside a thread | Still binds the whole containing chat through `containingChat`; its receipt remains in the thread where it was typed, and space conflicts still refuse |
| MCP `bind_channel` / `unbind_channel` | A supplied `thread_id` selects that exact topic; omitting it selects the whole chat, just as before |
| `/stop` / `/dissolve` inside an explicitly bound thread | Uses that thread's resolved Team; parent-group or Dispatcher behavior follows the existing command rules when no exact binding exists |
| `/help` / `/teams` | Existing command catalog and listing semantics remain unchanged; this task adds no `/unbind` command |

The official platform documents do not explicitly spell out the receive-event shape of an old-topic reply after switching to chat message format. This remains a live-evidence limit: if Feishu omits `thread_id`, the message uses its chat target and cannot reach an exact topic binding by ancestry. That avoids inventing an address, but does not demonstrate the old-topic continuity requirement. Later authorized live acceptance must observe the real event; local tests establish behavior when the platform supplies the thread identity.

Fresh eligibility lookups cost one chat-get request for a topic projection that will be used for delivery. Identity-only sends and reads avoid that cost. Existing two-second bounds, post-access placement, and in-flight request sharing remain; no cache, quota mechanism, retry family, or event subscription is added.

## Change boundary and knowledge updates

After development approval, change the transport normalization, pure target helper, Channel eligibility projection and existing local consumers, session/test composition affected by removal of the unused targeting dependencies, and the behavior tests that exercise those owners. Preserve the extension delivery capability from PR #469. Do not edit Core, add configuration, or convert or register any live group as part of local validation.

Update both package READMEs, `.agents/domains/channel.md`, and the relevant conversation-routing and Collaboration Space entries in `.agents/product/README.md`. Rewrite the current descriptions of group fallback on format lookup failure and session-lifetime format caching, rather than appending a competing description. Align affected targeting, transport, message-read, extension, and warning comments with the same model. Update `packages/dreamux/skills/dispatcher/dreamux-maintenance/references/builtin-feishu.md` to describe effective saved bindings and group-format changes, retaining its prohibition on hand-editing server-owned routing. Keep the maintenance root route accurate if its description needs adjustment.

Add ordinary Rush change notes for the affected published packages. These are behavior and capability-semantic changes with readable existing state, not upgrade-blocking changes. Do not use `BREAKING:`, `Rebuild:`, or a `major` change type on the transport's 0.x line.

## Verification

Use real owners and observed outcomes with synthetic platform inputs. Do not test source text or change assertions merely to accommodate an implementation shape.

| Acceptance boundary | Evidence to produce after approval |
| --- | --- |
| Native and converted topic formats | Real transport with chat-get responses for native `topic`, ordinary `group/thread`, and ordinary `group/chat`; verify effective results and preserve unknown-mode behavior |
| Switches in one running session | Start in `group/thread`, provision one topic, switch to `group/chat`, route the old topic to its Team and an unbound thread to Dispatcher with no `team.create`, then switch back and provision the unbound topic |
| Independent explicit bindings | Exercise an ordinary group's manually bound thread and a manually rebound space topic whose `space_id` is null; observe the saved Team receiving the message |
| Space removal and restart | Remove the policy while retaining bindings, reinitialize from the same real state directory, and observe old topics still reaching their Teams and unbound threads not provisioning |
| Parent fallback and top-level messages | Preserve whole-chat binding fallback for an ordinary group's unbound thread; a registered space's chat-mode top-level message reaches Dispatcher |
| Cards and egress | A question answer or extension forward in an old bound topic after a format switch still reaches its Team; an unbound chat-mode thread does not provision; cross-topic egress authorization remains tied to actual target ownership |
| Metadata failure | With failed, timed-out, missing, and unknown format results, exact topic bindings and parent-group bindings still receive the message, and no automatic provisioning occurs |
| Pure identity consumers | Extension `sendCard` and `readMessageRoute` return the actual target without any chat-get lookup or format warning; delivery paths still obtain a fresh format result |
| Command addressing | A `/bind` typed in a chat-mode thread binds the containing group and announces in the originating thread; MCP explicit topic inputs stay exact; `/stop` and `/dissolve` select the resolved topic Team |
| Topic-only provisioning and typed extension delivery | A real top-level group message never creates a per-topic Team; `submitToBoundTeam` retains its synchronous binding check, typed outcome propagation, and refusal when the expected binding changes |
| Access, concurrency, and conflicts | Rejected inbound performs no metadata lookup; concurrent projections share the in-flight lookup and subsequent projections see a new format; whole-chat/space conflict refusals leave state unchanged |

Complete the repository's monorepo gates after implementation:

```bash
node common/scripts/install-run-rush.js build
node common/scripts/install-run-rush.js lint
node common/scripts/install-run-rush.js test
node common/scripts/install-run-rush.js typecheck:tests
.agents/scripts/check.mjs
```

Focused tests may aid development, but they do not substitute for these gates. Review changed assertions against the source and approved requirement: old ordinary-thread collapse assertions may change for the accepted identity rule, while access, parent fallback, conflict, and no-provisioning guarantees remain load-bearing. Passing rewritten tests alone does not prove preservation.

No live group verification has been run. Any later live acceptance must name an authorized group, capture the old-topic receive-event shape after a format switch, and report separately from local controlled validation. Local gates do not establish that unobserved platform event shape.

## Entropy account and alternatives

The solution removes the mutable format cache, the separate group-kind set, the duplicate nullable chat identifier carried through delivery, and the targeting dependencies of identity-only outbound and instance-API consumers. It reuses existing topic targets, binding resolution, space records, timeout handling, and in-flight query sharing. It adds one per-projection eligibility fact in place of that nullable identifier, one pure helper composing existing constructors for multiple message-identity callers, and interpretation of one existing platform field.

Rejected alternatives add obligations without improving the accepted behavior: mode-change events need subscription and missed-event reconciliation; a TTL retains stale behavior until expiry; space-origin checks lose manually rebound topics; adding another persisted origin fact duplicates authoritative exact bindings. Reading bindings from targeting would also move routing policy into the projection layer. The selected separation keeps those owners intact.
