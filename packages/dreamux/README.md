# @excitedjs/dreamux

**Persistent AI teams, a conversation away.**

Dreamux is a local host that connects Feishu conversations to Codex and Claude
Code agents. Dispatchers coordinate tasks, TeamLeaders manage Teams, and named
TeamMates collaborate in a shared workspace with their own runtime sessions.

## Install

Requires Node.js **22.7+** on Linux, macOS or Windows, an installed and authenticated
**Codex 0.137+** or **Claude Code** CLI, and a configured Feishu bot application.

```bash
npm install --global @excitedjs/dreamux
dreamux onboard
dreamux doctor
dreamux status
```

The wizard writes local configuration and can register/start a user-level
service. For foreground operation, choose `dreamux onboard --no-register-service`
and then `dreamux serve`.

Prepare Feishu long-connection events, message/card permissions, and bot
availability first. Complete the pairing approval on your first conversation,
then resend the request. The full
[getting-started guide](https://github.com/excitedjs/dreamux/blob/next/docs/getting-started.md)
covers these steps and explains what `doctor` does and does not verify.

## Native Windows

Windows runs natively with Node.js 22.7 or newer. Normal runtime capabilities
use Node and native Windows bindings; PowerShell is used only to manage the
optional Task Scheduler service. After building the checkout, for example:

```powershell
node .\packages\dreamux\bin\dreamux onboard
node .\packages\dreamux\bin\dreamux daemon install --start
node .\packages\dreamux\bin\dreamux daemon status
node .\packages\dreamux\bin\dreamux doctor
```

For a foreground server, run `node .\packages\dreamux\bin\dreamux serve`.
An npm-installed package exposes the equivalent `dreamux` command.

The managed service is one Scheduled Task for the current user, starts at
user logon, and runs with limited privileges. `daemon start`, `stop`, `restart`
and `uninstall` manage it. Windows stop/restart forcefully terminate the full
process tree; they do not drain active turns. The packaged service entry reads
the captured launch command and environment from Task Scheduler Data;
rerun `daemon install` to refresh that installation-owned configuration.

Local administration uses a private named pipe, and Codex uses child stdio.
Native executables and npm Node shims work without a Unix socket or shell.
Use explicit `CODEX_HOME` to relocate Codex data; setting `HOME` alone does not
move native Windows Codex. Claude skill adapters use directory junctions.

## What this package provides

- One Node.js host for multiple Dispatchers and their Teams.
- Built-in Feishu, Codex, and Claude Code integrations.
- Role-scoped MCP tools for channels, TeamMates, Teams, workflows, and schedules.
- Runtime-injected skills for delegation, maintenance, and scripted workflows.
- Shared workspaces and optional managed Git worktrees.
- CLI diagnostics, onboarding, configuration inspection, and user-service control.

A Dispatcher is one trust domain. Chats handled by its agent share context;
use separate Dispatchers for unrelated private conversations. Workspace isolation
is off by default. Runtime sessions and identities persist, while unprocessed
inbound messages do not survive a host restart.

## Bundled skills

The Dispatcher receives `dispatcher-workflow` and `dreamux-maintenance`; the
TeamLeader receives `teamwork`, and both roles receive the shared
`dynamic-workflow` skill. These roots are injected at runtime, not copied into
the workspace during onboarding. For admin-created TeamLeaders, required-source
normalization protects `teamwork` and `dynamic-workflow` from custom skill-root
shadowing.

## Configuration and upgrade notes

For `builtin:codex`, every config field below has a default:

| Field | Default |
| --- | --- |
| `bin` | `"codex"` |
| `sandbox_mode` | `"workspace-write"` |
| `extra_args` | `[]` |
| `extra_env` | `{}` |
| `initialize_timeout_ms` | `10000` |

Older configurations may still contain `approval_policy` and `turn_timeout_ms`.
Both keys are ignored by the current config reader. Dreamux supplies approval
policy `never`; the old timeout setting (formerly documented with default
`600000`) is not passed into `CodexRuntime` and currently has no runtime effect.
Do not use either retired key to configure new installations.

Claude Code agents use a different provider config: its `turn_timeout_ms` is an
active stream-inactivity timeout. See the
[configuration guide](https://github.com/excitedjs/dreamux/blob/next/docs/configuration.md)
for both providers and complete examples.

Feishu `access.json` remains version 3 and needs no rebuild for the trusted-group
authorization change. Before upgrading from the earlier behavior,
review every non-empty `group.allow_chats` entry under both `allowlist` and `follow-user`.
Previously, `follow-user` ignored those entries and `allowlist` still applied
`dm_policy` and `allow_users`. Listed groups now trust their human membership
after the group block/mention checks, bypassing the user gate. Keep only groups
whose human membership should be trusted and whose passive known-bot observation
should remain enabled. The
[access guide](https://github.com/excitedjs/dreamux/blob/next/docs/configuration.md#feishu-credentials-and-access)
explains current policy and how to edit it while the host is stopped.

## Documentation

| Guide | Read |
| --- | --- |
| Product overview | [Repository README](https://github.com/excitedjs/dreamux#readme) |
| Documentation index | [All guides](https://github.com/excitedjs/dreamux/blob/next/docs/README.md) |
| Installation and first task | [Getting started](https://github.com/excitedjs/dreamux/blob/next/docs/getting-started.md) |
| Teams, topics, and automation | [Everyday usage](https://github.com/excitedjs/dreamux/blob/next/docs/usage.md) |
| Runtime and access settings | [Configuration](https://github.com/excitedjs/dreamux/blob/next/docs/configuration.md) |
| Service lifecycle and diagnostics | [Operations](https://github.com/excitedjs/dreamux/blob/next/docs/operations.md) |
| Providers and plugins | [Architecture](https://github.com/excitedjs/dreamux/blob/next/docs/architecture.md) |
| Working on the source | [Development](https://github.com/excitedjs/dreamux/blob/next/docs/development.md) |

These links follow the integration branch. Check `dreamux --version` and
`dreamux changelog` for the installed release. Source checkouts use Rush + pnpm;
per-package `npm install` cannot resolve their `workspace:*` dependencies.

## License

[MIT](https://github.com/excitedjs/dreamux/blob/next/LICENSE).
