# Technical design

## Ownership

Codex translates `thread/name/updated` (`threadId`, `threadName`) into
`{ kind: 'session.title.changed', title: string }` through the existing leased
`AgentRuntimeStateSink`. Provider-native thread matching stays in the Codex
package. A null native name is not a replacement Team intent.

Core routes the neutral fact to the owning Team through an awaited handler
installed when its leader is built. A member or dispatcher has no Team-title
consumer. The Team persists the title through its existing record owner and
write queue. No Agent title field, separate title cache, event bus, or new file
is required. The handler must preserve the generation fence at the queued write
boundary; a title must not cause an empty identity write.

The title event does not edit an existing leader identity's recovery intent.
If that identity is missing, the existing Team reconstruction path still uses
the current Team intent to create it; no second recovery field is introduced.

The state sink resolves after the corresponding owner's write is durable.
There is no transaction across Team and Agent files. Persistence errors retain
the existing state-fence failure semantics: a failed title write terminates
that native runtime, just as another failed durable state publication does.
This is an implementation choice to preserve the sink's durable-acknowledgment
contract; no new retry or silent-loss path is introduced.

The existing terminal-state rule protects a closed Team's status. A final
title can still update its intent while the leader lease is valid during
teardown; this change does not add a separate metadata freeze rule.

## Display and compatibility

The existing `team.list` projection already exposes `TeamRecord.intent`, and
the Feishu card already renders it. Updating the authoritative record is enough
for the next command to display the title. The persisted shape and existing
records remain readable; only the meaning of later intent updates changes.
Update the owning maintenance reference and knowledge records accordingly.

This consumer does not install a title producer. Dreamux's private app-server
does not automatically name its threads, so the intent changes only when a
client writes a name through that same instance and the notification arrives.

## Verification

- Provider tests replay the native notification and distinguish foreign threads
  and nullable names from the runtime's own usable title.
- Core tests use the neutral sink and real state owners to verify leader-only
  persistence, restored Team behavior, and stale-generation rejection.
- Verify the existing Team-list/card projection with the updated value.
- Run the required monorepo gates and KB check, then independently review the
  whole change. Where feasible, exercise real Codex name RPCs without a model
  turn; do not present mocked transport tests as a deployed client acceptance.
