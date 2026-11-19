# Windows service entry revision

Status: approved for implementation on 2026-11-12 through the service-format
decision card. The operator selected the new entry and accepted the one-time
service reinstall. The revision is implemented; the [final design](final.md)
states the resulting contract and [verification](../verification.md) records
executed checks and remaining acceptance boundaries.

## Problem and evidence

The operator requested removal of unnecessary code, questioned the generated
`daemon.mjs`, and reported that Windows restart does not reliably launch a new
instance. Before this revision, control treated a Scheduler command or WMI
process-creation receipt as success without observing a responding replacement
server.

Task Scheduler does have native replacement: `StopExisting` stops an existing
task instance before starting another. That is not an observed whole-process-tree
exit barrier. The disposable Scheduler-root experiment started the second and
third fixture generations while all five recorded processes in the preceding
generation still had matching creation times and nonsignaled process handles.
They exited later. Task Stop likewise returned Ready with zero task instances
before the recorded processes finished exiting. The experiment did not run the
real server or establish the cause of the operator's historical failure.

A named Job becoming available also cannot replace process-handle waiting.
Windows removes a temporary object's name when its handle count reaches zero;
other references can keep the object alive. Therefore name acquisition does not
prove that all previous processes have exited or released files.

The proposal preserves the existing requirement to await owned-process exit.
It does not select `StopExisting`, change the logon trigger, or weaken stop into
a command receipt. These are engineering choices derived from the requirement,
not additional statements attributed to the operator.

## One service definition, published executable code

The Task Action points to the selected Node executable and a private service
entry shipped in the Dreamux package. Installation no longer generates code.
The Action's absolute WorkingDirectory remains `<DREAMUX_ROOT>/state`; its
parent is the root used by startup, status and control.

TaskDefinition.Data contains only the existing installation snapshots:

```ts
{ environment: Record<string, string>; execStart: string[] }
```

`environment` excludes `DREAMUX_ROOT`, which is derived from WorkingDirectory.
This retains the installation PATH, selected Node and custom DREAMUX_BIN command.
It is task-owned configuration, not a new file or registry. Logs, admin endpoint
and restart-intent paths come from the existing root path builders.

The entry opens the daemon logs and establishes the existing named service Job
before launching the PowerShell query for Data or any business child. It then
uses the existing SupervisedChild owner and append file descriptors. Bootstrap
errors go to the daemon stderr log. Its control invocation branches before
creating or joining any service Job, so an external controller stays outside
the tree it must stop.

Delete the generated JS template, regex parser, launcher file read/write/remove
paths, file-ledger entry and installation-time utils import URL. Windows returns
the native RegisteredTask.Path in the existing `unitPath: string` result field;
it is not passed to filesystem helpers or the file ledger. `serviceUnitPath`
then describes only the launchd/systemd files. Doctor continues to receive the
business `execStart` and captured environment, not the bootstrap Action command.

## Control and completion

External stop keeps the existing sequence: disable the Task, acquire/reserve
its named Job, terminate members and await their held process handles, then stop
the Task action. Keep the reservation until the Task is neither Running nor
Queued and reports no instances. Failure or an observation deadline does not
fall through to Run. Restore the prior enabled state in the existing cleanup.

Restart completes this stop before requesting one Run. Start/restart then wait
within a bounded startup deadline for the registered root's `server.status` and
verify that the returned server PID belongs to the newly opened service Job.
Opening that Job for observation must not acquire/create a placeholder Job.
An IPC response establishes that the server's admin endpoint responds; it does
not establish that every dispatcher or provider is ready.

A caller inside the old service cannot synchronously wait for its own exit.
Retain the external WMI controller for this path, but invoke the published entry
with a control verb and task name instead of constructing inline JavaScript and
a data URL. The result explicitly reports `handedOff`; it must not print the
external path's completion message. The controller runs the same stop/start and
readiness checks and writes failure to the registered service's stderr log.
The existing resumed notification uses that same registered root and remains
owned by the new server's existing restart-intent consumer.

## Registration and approved upgrade cost

The existing native credential dialog remains inside the registration PowerShell
process. A new task, login-mode conversion or changed Data updates the Action
and Data together from one TaskDefinition, using a supported credentialed XML
registration. Existing definition settings, triggers, description and run level
are retained. Password plus byte-identical Data permits the existing action-only
path; it is not evidence that arbitrary Data updates preserve stored credentials
without a password. Real credential reuse and definition storage remain native
acceptance boundaries. Task-object ACL preservation must not be inferred merely
from preserving the definition XML.

Removing the old JS parser means a task without the new Data cannot be operated
as though it had a known Global Job. Its old launcher may own a Local Job, and
WorkingDirectory does not establish that distinction. The proposal deliberately
does not introduce a legacy parser or migration fallback.

Consequently, an existing Windows alpha installation needs this one-time
sequence before upgrading:

1. With the old version still available, use the original Windows account and
   original DREAMUX_ROOT from a terminal outside the service tree.
2. Run the old version's `dreamux daemon uninstall` and confirm success. This
   removes the managed service and launcher, not config, state or logs. On
   failure, stop the upgrade; do not overwrite the old task with new install.
3. Install the new version and run `dreamux daemon install`, supplying the local
   Windows credential dialog. Existing configuration and sessions remain.

If the old version is unavailable, restore a usable old version first. This is
an upgrade-blocking service-format change and requires a corresponding
BREAKING/Rebuild change note. The operator accepted this one-time reinstall in
the service-format decision card. That implementation approval did not authorize
operating the running installation; subsequent delivery authority is recorded
in the [task README](../README.md).

## Verification boundary

After approval, verify the registered-root path and Task Data behavior with
Scheduler shadows; preserve cancellation, owner validation and update-failure
assertions. Exercise the published startup owner with real isolated Job/process
and IPC fixtures, including delayed readiness and failure without a second Run.
Verify self handoff separately from completion. Retain the owned-tree exit and
file-release assertions; do not replace them with state, count or name checks.

Any native Scheduler lifecycle check uses an independently reviewed disposable
UUID task and synthetic homes, never the operator's task. A credentialless
lifecycle fixture does not establish Password registration or cross-session
credential behavior. Real UI and credential acceptance remain separately scoped.
Run the full build, lint, test and test-aware typecheck gates on the integrated
result and obtain complete independent review. Merge remains paused.

## Primary contracts

- [Task instance policy](https://learn.microsoft.com/en-us/windows/win32/api/taskschd/ne-taskschd-task_instances_policy)
- [TaskDefinition.Data](https://learn.microsoft.com/en-us/windows/win32/taskschd/taskdefinition-data)
- [Kernel object lifetime and name removal](https://learn.microsoft.com/en-us/windows-hardware/drivers/kernel/life-cycle-of-an-object)
