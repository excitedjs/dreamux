# Requirement

## Initial request

- Operator request, translated into English: At least allow an ordinary Feishu group switched to topic message format to be bound as a Collaboration Space.
- The initial request also mentioned switching back to ordinary chat message format. The accepted reverse-switch behavior is recorded below.

## Current alignment

- Status: Confirmed requirement revision 2, aligned on 2026-10-13.
- Desired outcome: Allow ordinary Feishu groups switched to thread message format to operate as Collaboration Spaces with one Team per topic.
- Desired behavior: The converted group supports the same Collaboration Space registration and per-topic Team flow as a native topic group. Switching back to chat message format preserves the space policy and existing topic Team routes, pauses automatic provisioning for unbound threads, and routes unbound threads and messages without a thread to the Dispatcher. Switching back to thread message format restores automatic provisioning.
- Scope: Converted groups, observation of their mutable message format in a running session, and routing and provisioning when a registered group changes that format. All existing explicit topic bindings remain effective independently of group message format or space registration, including manually bound and rebound threads in ordinary groups.
- Non-goals: No deployment, live group conversion, or changes to Core ownership are authorized by task creation.

## Intake source diagnosis and protocol evidence

The source diagnosis below was established before development, against `next`
after PR #466. It explains the change; the final implementation and verification
are recorded separately rather than replacing that historical diagnosis.

- Feishu distinguishes native topic groups (`chat_mode=topic`) from ordinary groups using thread message format (`chat_mode=group`, `group_message_type=thread`). The latter can switch between chat and thread message formats. Source: [official thread introduction](https://open.larksuite.com/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/thread-introduction).
- After switching back to chat message format, Feishu preserves existing topics and allows members to continue interacting within them. Source: [official group message-type guide](https://www.feishu.cn/hc/en-US/articles/630899543442-switch-message-type-in-a-group).
- `packages/channel/feishu-transport/src/transport/feishu.ts:getChatMode` read only `chat_mode` and did not consume `group_message_type`.
- `packages/channel/feishu-channel/src/inbound/target.ts:FeishuInboundTargeting.project` required both a non-empty `threadId` and a mode of `topic` to project a topic target and its container chat. Other group messages received a group target and no container chat.
- `FeishuInboundTargeting.chatMode` cached successful results for the session lifetime. The provider had no group-configuration-change event handler to refresh that fact.
- `packages/channel/feishu-channel/src/routing/index.ts:FeishuRouting.plan` consulted the Collaboration Space policy only when projection supplied a container chat. A converted group's misclassified message therefore could not start per-topic provisioning, even when registration succeeded.
- `FeishuRouting.bindSpace` performs no platform group-mode validation. It refuses a chat already bound as a whole to a Team; `FeishuRouting.bind` enforces the converse. This conflict rule is separate from topic detection.
- `packages/channel/feishu-channel/src/routing/operations.ts:FeishuBindingOperations.bindChannel` passes `spaceId: null` for manual topic bindings and rebindings. `FeishuRouting.bind` writes that value to an existing row. A topic created by a space and then manually rebound therefore retains its exact topic binding but loses its space origin marker. That marker cannot identify every old topic that must survive a format switch.
- `FeishuRouting.unbindSpace` removes the policy without deleting the existing topic bindings. Existing product behavior treats unbinding a space as stopping future provisioning, rather than removing Teams or their routes.
- Evidence boundary: These findings were source and official-protocol evidence gathered before implementation. No converted production group was inspected or reproduced. Implementation does not replace the outstanding live-event evidence described below.

## Constraints and existing product contracts

- A group has either a whole-chat Team binding or a Collaboration Space policy, never both. Preserve this rule from the [product catalog](/.agents/product/README.md).
- Native topic groups retain their existing Collaboration Space capability.
- Topic identity remains Feishu's `thread_id`; `root_id` and `parent_id` are reply ancestry, not substitutes for topic identity.
- Feishu transport and Channel code own external group facts and routing. Core receives ordinary Team commands and no Feishu-specific group policy.
- `/bind` keeps its existing whole-chat meaning even when typed inside a thread; its receipt stays in the originating conversation. There is no `/unbind` slash command in the existing catalog. MCP `bind_channel` and `unbind_channel` keep their existing explicit addressing: supplying `thread_id` selects one thread, and omitting it selects the whole chat.
- `/stop` and `/dissolve` follow the conversation's resolved binding, which now honors an explicit topic binding in chat message format. No new slash command is requested.
- The extension `submitToBoundTeam` capability introduced by [PR #469](https://github.com/excitedjs/dreamux/pull/469) retains its synchronous expected-owner check and typed delivery outcomes. No format lookup is inserted between its binding check and Core invocation.
- The product catalog's Collaboration Space provisioning and conversation-routing entries must describe the accepted reverse-switch behavior and support for converted groups.
- A group-format change does not unbind the space, dissolve existing Teams, or replace an existing topic's Team. The current Team lifecycle still owns a closed or dissolved Team; this requirement does not recreate it merely because a group changes format.
- The operator explicitly accepted the wider binding rule on 2026-10-13: all existing topic bindings take effect, including manual topic bindings in ordinary groups. This is an accepted product change, not an implication of the initial converted-group request.
- An unbound thread in ordinary chat message format does not create a Team. It continues through the existing parent-group binding, if any, or reaches the Dispatcher. A registered space excludes a parent-group binding by the existing conflict invariant.

## Acceptance criteria

- A native topic group continues to support automatic per-topic Team provisioning.
- An ordinary group switched to thread message format can register as a Collaboration Space and its accepted topic messages reach the per-topic Team flow.
- A running session observes switches between chat and thread message formats without requiring a daemon restart.
- Switching a registered group to chat message format leaves the space policy and existing topic bindings unchanged. An accepted message in an already bound topic reaches its existing Team; an unbound thread reaches the Dispatcher without creating a Team.
- A registered group's message without a thread reaches the Dispatcher in chat message format.
- Switching the same group back to thread message format restores automatic provisioning for an accepted message in an unbound topic, without requiring re-registration; existing topic Teams remain in place.
- Manually bound and rebound threads reach their explicitly bound Team in ordinary chat message format, even without a current space policy or a non-null space origin marker.
- Unregistering a space leaves its explicit topic bindings effective. An unbound thread does not provision a Team after that policy is removed.
- A thread without its own binding still uses an ordinary group's existing whole-chat binding; a group with neither a binding nor a space policy reaches the Dispatcher.
- Whole-chat binding conflicts retain their existing refusal and leave routing unchanged.
- A top-level group target cannot enter per-topic provisioning. The routing owner enforces this topic-only product rule alongside the current-format eligibility fact.
- The reverse-switch routing and provisioning behavior remains correct across a process restart from existing persisted space and binding records.

## Decisions and unknowns

- Confirmed operator decisions: On 2026-10-12, the operator approved creating this task and continuing requirement and solution work through the task-creation question card.
- Confirmed outcome: Support ordinary groups switched to thread message format as Collaboration Spaces.
- Confirmed reverse-switch decision, translated into English: Preserve existing Teams and pause new provisioning. The operator selected the card option whose description preserves the space registration, routes bound topics to their original Teams and unbound topics to the Dispatcher, and restores provisioning after switching back to thread message format.
- Confirmed explicit-binding decision on 2026-10-13, translated into English: All existing bindings take effect. The selected option includes manual topic bindings and rebindings in chat message format, preserves old routes after space unregistration, and does not automatically provision unbound threads in chat message format.
- Assumptions: No live group will be converted or bound by implementation or automated local validation. Live verification, if needed, must use an explicitly authorized group.
- Platform evidence limit: The official documents describe threads and preservation of old topics after a format switch, but the exact inbound event shape of a reply inside an old topic after switching to chat message format has not been observed live. The routing rule uses the platform-supplied `thread_id`; it does not invent an identity from reply ancestry. Capture that event in a later explicitly authorized live acceptance and keep that evidence separate from local controlled tests.
- Blocking requirement unknowns: None. Independent solution review and explicit development approval were completed on 2026-10-13; the task README owns their evidence and the remaining delivery stages.
- Review path: A TeamLeader-authored solution with external independent review, following the conversation's explicit external-review arrangement. This is not the minimal-change fast path: the requirement deliberately changes the effectiveness of existing explicit bindings in ordinary chat message format.
- Development authority: The sent-card evidence, explicit operator response, and approved boundary are owned by the [task README](/.agents/tasks/channel/support-converted-feishu-topic-groups/README.md#development-approval).
