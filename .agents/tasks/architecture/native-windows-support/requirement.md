# Requirement

## Confirmed behavior and desired outcome

The installed CLI required Bash and Unix process/IPC facilities and could not
start natively on Windows. The operator selected native Windows source support
rather than WSL, and authorized implementation, a PR to `next`, and an alpha
published from the PR branch, in that order.

Windows must run the same foreground server, local administrative commands,
provider sessions, workflow children, and managed user-service lifecycle.
Tests and CI must exercise native Windows behavior. Portable Node path APIs
should replace platform conditionals when they express the same contract.

## Scope and invariants

- Support native Windows without requiring Bash or WSL for normal CLI operation.
- Preserve Linux/macOS behavior and the existing logical admin path and lock.
- Keep provider-specific transport and home rules inside their provider packages.
- Enforce private native ACLs where Unix uses owner-only permissions.
- Stop owned Windows descendants and release files before reporting completion.
- Isolate every package test process from operator account/application homes.
- Retain behavioral assertions; specialize only genuinely platform-specific OS contracts.
- Publish a PR before dispatching the branch alpha release. Do not merge the PR.

## Acceptance criteria

- The compiled launcher, foreground server and admin/MCP traffic work on Windows.
- A real installed Codex initializes over its Windows transport in a disposable home.
- Native process tests preserve literal arguments, including multiline prompts, and reap descendants.
- Task Scheduler installation, status, start, stop and removal work for the current user.
- Rush build, lint, test and test typechecking pass, with native Windows included in CI.
- Test homes are disposable; explicit live model runs may copy authentication into a fixture, never modify the original home.
- PR and branch alpha artifacts identify the reviewed implementation.

## Coverage limits

Real model completion requires separately opted-in, usable provider authentication.
Windows forced process termination does not provide Unix signal-based graceful drain.
