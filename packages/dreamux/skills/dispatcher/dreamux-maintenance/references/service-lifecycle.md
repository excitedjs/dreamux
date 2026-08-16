# Service Lifecycle And Reply Diagnosis

This reference owns current serve/daemon lifecycle, missing-reply, stuck-turn,
and Workflow run-state diagnosis, bundled-skill injection, runtime app-server
readiness, and same-version restart cautions.

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
- Completion preparation and each prepared submission attempt have an internal
  deadline. Deadline expiry is admission-ambiguous and terminal: Dreamux logs
  and drops that delivery instead of retrying or blocking entity, Workflow,
  Team, or server teardown indefinitely.

## Agent Identity And Native Transcripts

- Every dispatcher root agent, TeamMate, TeamLeader, and Team member has a
  server-owned `identity.json` in its role-scoped entity directory. It owns
  identity/lifecycle/worktree facts and the atomic native Runtime association:
  `session_id` plus nullable `transcript_locator`. It does not own rolling
  conversation previews or a Dreamux Turn archive.
- Use `history`, list, and status for identity/lifecycle recovery. Use `last`
  for completed conversation detail: it cold-reads the selected provider's
  native transcript without starting or resuming the Runtime. `last` accepts
  only `turns` (default 1, range 1 through 50), an opaque cursor, and
  `include_tools`; it returns chronological provider-neutral message/tool
  blocks under a fixed 262144-byte output budget.
- Native transcript reads are bounded. Follow `next_cursor` for older pages.
  `scan_unsupported` means the provider cannot safely inspect that native
  representation within its fixed scan bound; it is not permission to perform
  an unbounded Dreamux scan or create a cache/index.
- Direct TeamMate `spawn` and `send` receipts include
  `transcript_path: string | null`, independent of submission status. A known
  validated session keeps its path on duplicate, failed, ambiguous, or stopped
  submissions; `null` means no native transcript association has ever been
  established. The path is machine-local and operator-private. It may briefly
  name a file that the provider has not created or completely flushed yet.
- `transcript_path` is not present in list, status, history, `last`, Workflow,
  Team, Channel, completion, logs, metrics, or public errors. Do not publish it
  to a broad Channel.
- `identity.json` is fully server-owned. Do not edit, copy over, synthesize, or
  delete it as an operational repair. Existing files may contain the retired
  `turn_count`, `last_seen_at`, `last_prompt_preview`, or
  `last_assistant_preview` keys; Dreamux ignores those legacy extras and a
  normal later rewrite may drop them.
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

## Team Dissolve And Cleanup State

- Team state lives at
  `~/.dreamux/state/<dispatcher-id>/team/<team-id>/record.json` and is fully
  server-owned. Its nullable `dissolve` object contains the accepted operation,
  requester/generation, target handoff ids, first note/time, phase, public-safe
  error, cleanup-attempt count, and next retry time. Do not edit, clear, copy, or
  synthesize this object manually.
- Current phases are `waiting_for_team_idle`, `closing_resources`,
  `worktree_cleanup_pending`, `complete`, and `failed`. Team status is separate:
  a Team can be durably `closed` while managed worktree cleanup remains pending.
- `cleanup-pending` means Dreamux still owns retry responsibility. Inspect Team
  status/history and sanitized structured logs for dispatcher, Team, operation,
  phase, attempt, and public-safe error. Do not delete the Team record or managed
  worktree to clear the visible state.
- Dispatcher startup restores the Team availability fence and resumes active
  dissolve/cleanup work before normal Team, collaboration, Channel, workflow,
  or scheduler work is published. A same-version restart is a recovery action,
  not proof that cleanup completed; verify the terminal Team view afterward.
- Dirty or unmerged worktrees require an explicit operator decision and are
  never force-removed. `cleanup: keep` and non-managed workspaces are terminally
  retained. For a clean managed `delete-on-close` worktree, Dreamux runs only
  non-forced `git worktree remove <path>`: it does not use ref reachability as
  an eligibility check and it preserves the managed branch and its commits.
  Operational removal failures retry in the background.
- Branch or ref deletion is a separate destructive capability that requires its
  own explicit design and authorization; Team dissolve never performs it.
- `collaboration-spaces.json` is also fully server-owned. Its target-side
  operation/handoff fields correlate one closing target generation with the
  Team-owned operation; they are not safe manual repair switches.

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
