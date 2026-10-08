# Source observations for review-fix design

Date: 2026-10-03. Read-only observations after PR #462. A fresh fetch left the
local feature branch and both reviewed remote baselines unchanged.

- `team/store.ts`: `get` registers every valid historical read; `list` calls
  it for every directory. `handle.update` looks the store up again by Team id,
  rather than using the captured store used by `current`/`create`. Releasing a
  map entry without changing that split would let an old handle target a
  different store. Cold reads must recheck concurrent registration.
- `team/index.ts`: create, rebuild, startup cleanup, and live ownership all
  need the same record owner. Recovery currently relies on `list` having
  loaded the store before `handle.current`; making reads transient removes
  that implicit initialization and requires an explicit acquisition boundary.
  Failed creation and rebuild must relinquish their ownership too.
- `team/service.ts`: `closed` resolves after child destruction and before
  physical cleanup. `runDissolve` and abandoned creation can still write the
  worktree fact after that promise resolves. Dropping the service cache at
  `closed` is therefore not the record's retirement point. A delayed admitted
  leader transition can queue behind `closed`; closed remains terminal.
- `dreamux-utils/transactional-store.ts`: the existing owner already has
  serialized mutation and `drain()`. Lifetime handling must not add another
  durable state or detach work still using that queue.
- Official package root defaults currently construct plugins; the provider
  loader selects a root default for an unqualified npm provider ref. Plugin
  loading selects the default too, while builtin import locations come from
  `BUILTIN_PLUGIN_PACKAGES`. Separate public provider/plugin entry points can
  be evaluated without a provider-name switch inside Core.
- Pairing lookup finds expired same-sender entries. The update must decide
  against the latest committed state, not replace it with the gate's earlier
  pruned snapshot. Concurrent approval must continue to win.
- COT's anchor target is the visible destination, which differs from its
  serving binding for parent-group fallback. The route owner knows which
  binding actually served a topic; retirement must preserve exact-topic routes.
- `codex --version` reports `codex-cli 0.159.0`. The current live test file
  contains classifier units only. Installed availability is not live behavior
  proof, and no live request was made in this audit.

The authoritative acceptance input is the linked revision-1 requirement.
These observations identify traps and evidence gaps, not a preselected design.

## Additional source checks after the first proposal

A terminal record is not proof that runtime ownership ended. For an unmanaged
Team or a terminal managed-worktree assessment, `runDissolve` can write
`closed` with a non-pending cleanup state before it starts `destroyChildren`.
Releasing the map at that commit would let a cold read observe hand edits while
the original live owner is still destroying its children. Construction can also
still own the handle at that point. Record semantics alone are therefore not a
sufficient release trigger. A failed cleanup job that settled is different from
an active cleanup job; a durable pending recovery fact is not itself a live
runtime holder.

The configured-provider loader invokes factories with a published factory
context, whereas the plugin loader invokes a zero-argument factory. Running
`contribute` a second time against a throwaway host would add provider selection
and lifecycle machinery to the provider path. Its no-I/O contract does not
prove absence of side effects; plugin code is ordinary JavaScript and providers
may depend on other contributions or API wiring. Compare explicit package
entry/export contracts before choosing that mechanism.

For COT, all uses of `anchor.target` outside normalization are lifecycle route
comparisons. Visible delivery is separately held as `chatId`/`messageId`.
`prepareVisibleAnchor` checks target and chat id agreement. A serving route may
therefore be stored without changing visible delivery, but every constructor,
binding-card fallback, and normalizer must preserve the same meaning.

An ordinary pre-close overlap also defeats the inference that an enqueued
`running` patch necessarily settles before retirement: a recovered `starting`
Team submits its leader while dissolve has queued a `closed` update that is
still awaiting its atomic file write. Submission sees the still-committed
`starting` value and queues `running` behind it. Once closed commits,
`destroyChildren` and that queued patch can run concurrently. For an unmanaged
worktree, cleanup returns without another queued record update, so reaching the
end of cleanup does not drain the queued patch. This schedule needs no failure
or unusual plugin. Use the existing queue's drain or an explicitly held queued
operation; do not assume promise order across independent resource owners.
Likewise, construction and its service can overlap; release must account for
the existing construction handoff rather than inferring it from status alone.
