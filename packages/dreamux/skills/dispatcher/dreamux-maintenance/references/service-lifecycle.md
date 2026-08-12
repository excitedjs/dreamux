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
- A successful active `workflow_stop` is a truthful terminal barrier: it returns
  `{ run_id, status }` only after status/list, the durable record and end
  journal, terminal delivery routing, and the release of every TeamMate
  exclusively owned by that run all agree. The first stop intent grants
  submitted agent turns a five-second natural-settle grace, then owner-cancels
  the remaining turns. A stop can also join an in-flight natural
  `completed`/`failed` finish and returns that status.
- A pre-terminal owner-release failure rejects the stop (and any natural
  terminal attempt) without writing `end`, a terminal record, or a delivery:
  the run stays process-live with a durable `running` record and closed
  admission, and a later stop or owner-close path retries against the original
  deadline. This is a retryable stop state, not a durable defect — do not edit
  the run's files to clear it. A server shutdown interrupting a public stop
  rejects it with `SERVER_SHUTTING_DOWN`.
- Shutdown finalization freezes unresolved agent calls as `stopped` in the
  durable record and leaves owned runtime cleanup to the collection-wide sweep.
  Startup likewise marks a durable `running` Workflow record as `stopped`;
  Workflow journal replay and run resume are not supported. A restart is
  therefore not a way to continue a Workflow and must not be presented as one.

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
