# Cooperative Windows service shutdown

Status: the operator approved implementation and isolated verification on
2026-11-13 by selecting "Fix and verify". Live service operations are excluded.

## Observed gap

The operator reported that CoT did not become interrupted on restart and
suspected Windows stop/restart did not leave Node time to clean up. Read-only
inspection of the installed `0.29.0-alpha.ge0477c515e92` and pre-correction source
confirmed that managed stop disabled the Task, acquired its Job, called
`WindowsJob.terminate()`, then invoked Task Stop and checked instance exit.
`TerminateJobObject` cannot be postponed or handled by the terminated process.
The retained-handle wait proves process exit, not application cleanup.

The existing CLI signal path instead calls `Server.shutdown()` with a 15-second
deadline. Dispatcher shutdown stops runtime producers, drains admitted work and
closes channels. Feishu session close calls the CoT adapter before closing the
bot; open cards receive an interrupted terminal intent, with up to five seconds
to drain writes. CoT state is memory-only, so a new process does not backfill a
card whose terminal write was lost to a hard kill. Network failure can still
prevent delivery even when cleanup runs. No live restart or card inspection
was performed to reproduce the reported event.

## Approved implementation

- Windows control first requests cooperative process shutdown through the
  existing admin transport at the registered Task root. It must identify the
  responding server as belonging to the owned Job before directing shutdown;
  an unrelated foreground server is not a service-control target.
- The status probe is bounded to one second. `retainMember` opens QUERY and
  SYNCHRONIZE rights, verifies the same process handle against the Job and
  keeps it across the expected-PID request and finite native exit wait. A
  process already gone continues to final cleanup; a live nonmember is refused.
- Reuse the serving process's existing shutdown path and 15-second bound.
  Application shutdown remains owned by the host, not the Job utility or the
  Feishu provider. No CoT persistence, recovery ledger or second control
  transport is introduced.
- A command acknowledges a shutdown request without awaiting the entire
  shutdown inside that invocation. `Server.shutdown()` drains admitted
  commands, so awaiting it from its own command would self-wait. Acceptance
  and final process exit remain distinct results.
- Preserve the external-controller handoff for callers inside the service
  Job, the Task disable/start reservation, and original Enabled restoration.
  Give an identified, responding server a bounded opportunity to finish; an
  unavailable or unresponsive server still requires forced service cleanup.
- Retain Job termination for remaining owned processes and held-object exit
  confirmation, followed by Task instance checks. Restart performs its single
  Run only after stop completes, then verifies the new responding server's
  Job membership. A failed stop must not launch a replacement.

This deliberately changes normal Windows stop/restart from immediate forced
termination to cooperative shutdown followed by forced cleanup when needed.
It is not a longer sleep before or after killing the process, and it cannot
guarantee remote card delivery during a network failure or process crash.

## Verification and boundaries

Use disposable homes, an owned Job and real admin IPC with Scheduler operations
intercepted. Assert that shutdown is requested before native termination, that
a delayed application close gets its cleanup opportunity, that request handling
does not await itself, and that an unresponsive server still reaches the
existing forced cleanup/exit fence. Keep failed-stop/no-Run and self-handoff
behavior covered. Test the host-to-channel shutdown chain with a fake Feishu
transport and assert the interrupted terminal is sent before the transport
closes; no real channel messages are test outputs.

The running service, installed package, real Scheduler task and credentials
remain untouched during this code/isolated-test slice. Ordinary-permission
installation acceptance remains deferred by the operator, and R5 remains
deferred; neither is reopened by this proposal. Normal local gates and a
complete-delta review are required before any delivery decision.
