# Unreadable-root preview boundary

Status: resolved and implemented under R75 on 2026-10-08; current full gates passed,
with complete resulting-tree independent review and knowledge closeout pending.

## Historical predictor scenario

An ordinary Dreamux root owned by a non-root user can have mode 0300: known
entries remain searchable and removable, but its contents cannot be enumerated.
The pre-R75 readonly predictor called readdir at
`packages/dreamux/src/onboard/uninstall.ts`, so preview fails with EACCES.
That implementation removed known configuration entries, then called rmdir without
requiring a directory listing. A foreign file makes that call report ENOTEMPTY
and preserve the root; an otherwise-empty root is removed.

The TeamLeader independently reproduced these filesystem facts on Linux uid
1001 with private fixtures. Both layouts allowed reading and unlinking the
known config file and refused enumeration. Root removal then succeeded only
for the empty layout. Permissions were restored and both fixtures removed.
This probe is syscall evidence, not a complete CLI or hosted-platform test.
The source writer also exercised that unchanged, built runUninstall owner on
both layouts. Its preview refused enumeration in both cases; actual uninstall
removed the empty root and retained the foreign-content root. Preview left
known file bytes and permissions unchanged. The service runner was fake,
filesystem operations were real, and both fixtures were cleaned up. The
TeamLeader matched the executed artifact and source hashes to current files.

This is a new preview observability premise, not the retained root-link,
mountpoint or directory-config failures of actual removal. Stat metadata does
not provide a portable emptiness or foreign-content oracle. Trying removal,
changing permissions or moving files during preview violates its no-writes
contract. Reporting skipped as known root retention also guesses the empty
layout's result.

## Historical unselected alternatives

| Choice | User-visible result | Implementation boundary |
| --- | --- | --- |
| Explicit unknown root outcome, recommended | Other definite planned entries are still shown. A warning names the unreadable root and states that its final removal cannot be determined; no root status asserts retained or removed. Known configuration unlink plans remain visible. | The existing entries/warnings result can express this partial preview by omitting the indeterminate root status and explaining it in warnings. No public status enum is required. Handle only the named enumeration-permission failure in the current owner; preserve actual deletion, readable-root predictions, provider protection and no writes. Use ordinary documentation/change notes, with no persistent migration. |
| Explicit fail-loud boundary | Preview terminates with a clear explanation that it cannot inspect this root. Actual uninstall retains its existing behavior. | Keep the unreadable-root refusal, document this exact observation boundary and test it. Narrow outcome 4's preview guarantee to inspectable roots rather than claiming parity for this layout. |

Neither alternative was selected. On 2026-10-08 the operator asked
“什么情况会出现这个问题？next分支上是怎么处理的？”. The TeamLeader
verified the remote next ref and read its uninstall source, then explained the
existence-only preview and recursive whole-root deletion. The operator replied
“先和 next 保持一致吧”. This is R75 and supersedes the predictor requirement.

## Historical next source comparison (2026-10-08)

The verified baseline is
[next uninstall source](https://github.com/excitedjs/dreamux/blob/9b7f731967eedf6ae740c255452766da7bafe53c/packages/dreamux/src/onboard/uninstall.ts#L120-L136).
Its preview checks existence and reports planned removal without listing root
contents. Actual uninstall recursively removes the whole root, including
other files inside it. Actual removal can fail after a successful preview;
this is a deletion plan, not a filesystem success guarantee.

The exact next access/recursive-removal filesystem calls were exercised on
Linux as a non-root user against private mode-0300 roots. Preview reports
planned removal in both layouts; recursive removal fails with EACCES. This
checks the relevant filesystem operations, not the complete next CLI or service
manager. Fixtures were restored and cleaned up.

## Selected next-compatible implementation

Remove the predictor and its transient ledger rather than adding an unknown
status, warning fallback or permission oracle. Keep current provider-derived
protected locations, service removal, root addressing and all unrelated repair
outcomes. The explicit R75 instruction supplies the changed product requirement
and authorizes this correction within the existing repair batch. The actual
runUninstall tests now prove successful no-write preview and propagated recursive
removal EACCES for both unreadable-root layouts. Current full default and enabled
model gates passed; [verification](verification.md) records those results.
Complete independent review and final knowledge closeout remain pending.
