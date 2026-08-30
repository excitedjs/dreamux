# Service Lifecycle And Reply Diagnosis

This reference owns current serve/daemon lifecycle, missing-reply, stuck-turn,
Workflow run-state, and cron job-store diagnosis, bundled-skill injection,
runtime app-server readiness, and same-version restart cautions.

## Server And Service

- `dreamux serve` is the foreground server entry point. The public
  `dreamux daemon install|uninstall|start|stop|restart` command group manages
  the user service; `serve` is not self-daemonizing.
- Check launchd or systemd only for service-lifecycle questions. Explain before
  changing units, linger, environment, or shell startup.
- Use `dreamux doctor` to inspect configuration, provider loading, service
  state, and runtime app-server readiness. Use `dreamux status` for current
  Dispatcher and process facts; neither command proves Channel delivery.
- Current durable state is under `~/.dreamux/state/`, volatile runtime files are
  under `~/.dreamux/run/`, and logs are under `~/.dreamux/logs/`. Use the path
  authorities reported by Dreamux instead of guessing alternate roots.

## Missing Replies And Stuck Turns

- For missing replies, distinguish Channel ingress, Dispatcher acceptance,
  runtime execution, TeamMate completion delivery, and Channel egress.
- For stuck turns, inspect the relevant runtime and Dreamux state before a
  restart. A restart does not prove that a turn completed or a reply was sent.
- Treat a successful submit as acceptance only. Confirm completion and then the
  provider-visible reply separately.
- Runtime admission `failed` means the provider proved that native admission
  did not occur and the same immutable prepared completion may be retried.
  `ambiguous` means the native boundary may have been crossed; do not retry it.
  An untyped provider rejection is ambiguous. Runtime stop fences new admission
  synchronously and waits for already-started admission calls to settle before
  it reports completion.
- Every settled turn is reported to the Agent that was waiting for it,
  including one that failed or was stopped without a native provider result. A
  missing completion is therefore a delivery problem, not evidence that the
  turn ended badly.
- Completion preparation and each prepared submission attempt have an internal
  deadline. Deadline expiry is admission-ambiguous and terminal: Dreamux logs
  and drops that delivery instead of retrying or blocking entity, Workflow,
  Team, or server teardown indefinitely.

## Agent Identity And Recent Activity

- Every dispatcher root agent, TeamMate, TeamLeader, and Team member has a
  server-owned `identity.json` in its role-scoped entity directory. It owns
  identity/lifecycle/worktree facts and one nullable `session`: the provider's
  own session object, persisted verbatim and read back only by that provider.
  Dreamux reads `session.id` and nothing else. `identity.json` owns no
  conversation preview and no Dreamux Turn archive.
- Use `history`, list, and status for identity/lifecycle recovery. Use `last`
  for what a TeamMate is doing or has just done: it reads the provider's recent
  Activity Records without starting or resuming the Runtime, so it also shows a
  turn that is still running. `last` accepts `limit` (default 20, range 1
  through 200), an opaque `cursor`, and `include_tools`; it returns assistant
  messages and tool records oldest first, with `next_cursor` and `truncated`.
- Activity Records carry assistant message text and tool name plus lifecycle
  status. Tool arguments and tool output are never exposed, and a provider's
  raw native lines are never surfaced.
- Activity reads are bounded. Follow `next_cursor` for older pages; that bound
  is not permission to perform an unbounded scan or to build a cache or index.
- `identity.json` is fully server-owned. Do not edit, copy over, synthesize, or
  delete it as an operational repair.
- Dreamux never creates, opens, stats, lists, validates, repairs, migrates, or
  deletes a current-layout entity `turn.jsonl`. Any such file is inert legacy
  residue. Its contents, version, permissions, parseability, or absence cannot
  block startup or lifecycle behavior, and no manual cleanup or rebuild is
  required.

## Workflow Run State

- Dispatcher-scoped Workflow state lives under
  `~/.dreamux/state/<dispatcher-id>/workflow/<run-id>/`; TeamLeader-scoped
  Workflow state lives under
  `~/.dreamux/state/<dispatcher-id>/team/<team-id>/workflow/<run-id>/`. Each
  run's `record.json` and append-only `journal.jsonl` are fully server-owned. Do
  not edit, truncate, copy over, synthesize, or delete either file as a repair
  action.
- Use `workflow_status` and `workflow_list` in the original caller scope for
  public run inspection. Treat `record.json` and `journal.jsonl` as narrow
  diagnostics only when the supported surfaces are insufficient; sanitize
  scripts, arguments, results, prompts, paths, ids, and errors before reporting.
- `workflow_run.max_concurrency` defaults to 16 and accepts only 1 through 16.
  Do not change durable state to override that bound. A run can start at most
  1000 agents across its complete lifecycle; `parallel()` accepts at most 4096
  functions and `pipeline()` accepts at most 4096 items per call.
- A returned `{ run_id }` is a durable acceptance receipt, not proof that script
  compilation, metadata validation, runtime execution, completion delivery,
  or visible Channel delivery succeeded. Inspect the run's terminal state and
  then the delivery boundary separately.
- Startup completes a `running` Workflow record from its already-committed
  terminal journal fact when present; otherwise it marks the interrupted run
  `stopped`. Workflow execution and completion delivery do not resume; journal
  replay and run resume are not supported. A restart is therefore not a way to
  continue a Workflow and must not be presented as one.

## Cron Jobs

- Dispatcher cron jobs live in
  `~/.dreamux/state/<dispatcher-id>/cron-jobs.json`; a TeamLeader's live in
  `~/.dreamux/state/<dispatcher-id>/team/<team-id>/cron-jobs.json`. Both are
  fully server-owned. Do not edit, copy over, synthesize, or delete a job by
  hand as an operational repair; use `cron_create`, `cron_update`, and
  `cron_delete` in the owning scope.
- A job's only action is `{ kind: "prompt-agent", prompt, intent? }`: it injects
  its prompt into the Dispatcher or TeamLeader that owns the schedule. Cron
  spawns no agent and addresses no Channel, and a job carries no delivery
  target. A store file containing a `spawn-teammate` action or a `deliver`
  field is not current state: it fails loud when read, and `dreamux doctor`
  names the file. Delete that job or the store file and recreate the schedule.
- A due job is submitted through ordinary admission, so it may fold into a turn
  that is already running. Firing proves submission, not a visible reply.

## Team Dissolve And Cleanup State

- Team state lives at
  `~/.dreamux/state/<dispatcher-id>/team/<team-id>/record.json` and is fully
  server-owned. Do not edit, clear, copy, or synthesize it manually.
- Dissolve is a submission. The caller's receipt (`{ accepted, team_name,
  status: submitted }`) proves only that the request was accepted; the stop and
  the close run behind it and are never reported back to that caller. Read the
  Team's status afterward to learn what actually happened.
- The record's `status` and its `worktree.cleanup_state` are the only durable
  dissolve facts. There is no persisted dissolve operation, phase, retry
  counter, or generation. A dissolve interrupted before its closed record
  simply did not happen: the Team is still open and can be asked again.
- A Team can be durably `closed` while `worktree.cleanup_state` is still
  `cleanup-pending`. That state, plus `worktree_cleanup_force`, is the whole
  recovery input: dispatcher startup finishes the pending reclamation from the
  record alone, without materializing the closed Team. Do not delete the Team
  record or the managed worktree to clear the visible state.
- Dirty or unmerged worktrees require an explicit operator decision. A default
  dissolve is non-forced and never force-removes one: it leaves the Team open
  and running rather than closing it. `force: true` on the dissolve is that
  decision — it authorizes `git worktree remove --force` and discards the
  uncommitted, untracked, or unmerged work in the managed checkout. `cleanup:
  keep` and non-managed workspaces are terminally retained. For a managed
  `delete-on-close` worktree, Dreamux runs `git worktree remove <path>`, forced
  only under that authorization: it does not use ref reachability as an
  eligibility check, and neither form deletes the managed branch or its
  commits.
- A Team's cron store file is deleted while its resources close, before the
  closed record is committed. A dissolve that fails after that point leaves the
  Team open with no scheduled jobs left to arm; that loss is intended. A
  deletion that itself fails leaves the file in place and fails the dissolve.
- Branch or ref deletion is a separate destructive capability that requires its
  own explicit design and authorization; Team dissolve never performs it.
- Where a Team is reachable from the outside is Channel state, not Team state.
  A dissolved Team's routes are invalidated by the Channel that owns them.

## Bundled-Skill Injection

Bundled skills are injected by role. Inspect the runtime skill-source config
and logs instead of copying bundled skills into a workspace. A missing skill is
an injection/source-readiness problem, not evidence that workspace installation
is required.

## Same-Version Restart Cautions

- A managed service may use
  `dreamux daemon restart --notify-resumed --dispatcher <current-id>`.
  Foreground `dreamux serve` needs an operator-coordinated stop/start and an
  external recovery path.
- Warn before renaming or disabling the current Dispatcher, removing its
  Channel, changing its Agent Runtime provider, or changing Channel
  credentials. Each can break the active recovery path.
- The caller may be reaped during a restart. Do not depend on the pre-restart
  turn to observe success; continue only from the injected restart notice or an
  independent operator's verification.
