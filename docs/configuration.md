# Configuration

[Documentation](README.md) / Configuration

Dreamux separates operator configuration from server-owned state. Start with
`dreamux onboard`; use this page when you need to edit the resulting setup.

```bash
dreamux config path
dreamux config show
```

The default file is `~/.dreamux/config.json`. `DREAMUX_ROOT` relocates the entire
Dreamux root, including configuration, state, cache, logs, and the admin socket.
Use the same root for the server and its CLI commands.

On Unix, the config file must have mode **exactly `0600`**. `config show` redacts
secret-like values; it has no raw-output mode. Before editing the file manually,
stop the managed service or foreground process and confirm it has exited. Then
edit, run `dreamux doctor`, and start the host again. The running configuration
service holds an in-memory snapshot; a later agent-driven configuration write
can otherwise overwrite an external edit.

## A complete starter config

This example defines one Codex runtime and one Feishu-backed Dispatcher. Replace
the workspace path and credential placeholders before use.

```json
{
  "agents": [
    {
      "id": "coding",
      "provider": "builtin:codex",
      "config": {
        "sandbox_mode": "workspace-write"
      }
    }
  ],
  "dispatchers": [
    {
      "id": "main",
      "cwd": "/path/to/agent-workspace",
      "enabled": true,
      "workspace": {
        "enabled": false
      },
      "agentRuntime": "coding",
      "channels": [
        {
          "id": "primary",
          "provider": "builtin:feishu",
          "config": {
            "app_id": "<APP_ID>",
            "app_secret": "<APP_SECRET>"
          }
        }
      ]
    }
  ]
}
```

`agentRuntime` names an **entry ID**, such as `coding`, rather than a provider
reference such as `builtin:codex`.

## Host configuration

| Field | Meaning |
| --- | --- |
| `agents[]` | Named runtime configurations available to Dispatchers and their agents. Each has a unique `id`, a `provider`, and provider-owned `config`. |
| `dispatchers[].id` | Unique, path-safe Dispatcher name, also used by CLI commands and state paths. |
| `dispatchers[].cwd` | Explicit working directory for the Dispatcher. `~` and `~/…` are expanded. |
| `dispatchers[].enabled` | Whether the Dispatcher starts; defaults to `true`. |
| `dispatchers[].agentRuntime` | ID of an entry in `agents[]`. |
| `dispatchers[].workspace.enabled` | Default workspace isolation policy when a spawn does not specify one; defaults to `false`. |
| `dispatchers[].channels[]` | Nonempty list of channel configurations, each with `id`, `provider`, and `config`. |
| `plugins[]` | Optional additional plugins; see [extensions](#plugins-and-external-providers). |

Channel IDs must be unique within a Dispatcher, and a Dispatcher may declare at
most one channel per provider reference. Adding multiple Dispatchers gives each
its own agent context and state. Avoid using one Dispatcher as the shared entry
point for unrelated private users.

### Workspace policy

With isolation disabled, an unspecified workspace reuses the Dispatcher cwd.
Enabling `workspace.enabled` opts into the default workspace creation behavior;
explicit Team or member workspace requests still select their intended mode.
For repository tasks, request a managed Git worktree and a base reference when
you need branch separation.

A Team's members always share its Team workspace. A managed worktree separates
files and Git branches; runtime sandbox settings control process access.

## Codex runtime

Provider: `builtin:codex`. All fields below are optional.

| Field | Default | Meaning |
| --- | --- | --- |
| `bin` | `"codex"` | CLI executable or path |
| `sandbox_mode` | `"workspace-write"` | `read-only`, `workspace-write`, or `danger-full-access` |
| `extra_args` | `[]` | Additional Codex CLI arguments |
| `extra_env` | `{}` | Environment overrides for this runtime |
| `initialize_timeout_ms` | `10000` | App-server initialization timeout |

Dreamux requires Codex **0.137+** and supplies approval policy `never`; configure
sandbox access for the work you intend to authorize. `approval_policy` and
`turn_timeout_ms` are not current Codex options in this configuration surface.

Codex uses its native configuration and authentication. Its home defaults to
`~/.codex`; set `extra_env.CODEX_HOME` on a named runtime if you need a different
home. Native model options can be supplied through `extra_args`, for example
Codex's `-c` options. Dreamux also supplies its own MCP configuration.

`CODEX_HOST_CODEX_BIN` is a process-level binary override above the configured
`bin`. For managed services, prefer a configured `bin` or per-runtime environment
settings over relying on variables exported only in an interactive shell.

## Claude Code runtime

Provider: `builtin:claude-code`. All fields below are optional.

| Field | Default | Meaning |
| --- | --- | --- |
| `bin` | `"claude"` | CLI executable or path |
| `model` | `null` | Model override; otherwise Claude Code's own selection applies |
| `permission_mode` | `null` | `default`, `acceptEdits`, `plan`, or `bypassPermissions`; otherwise native defaults apply |
| `remote_control` | `false` | Enable Claude Code Remote Control at session startup |
| `extra_args` | `[]` | Additional CLI arguments |
| `extra_env` | `{}` | Environment overrides for this runtime |
| `turn_timeout_ms` | `600000` | Maximum stream inactivity while awaiting a result |

The inactivity timeout resets when stream output arrives; it is not a cap on the
whole task. Dreamux does not currently enforce a Claude Code minimum version.
Use a version compatible with its resident stream-json integration.

Remote Control is an external Claude UI feature. It is separate from sending a
follow-up through Dreamux, and its URL is logged when the runtime provides one.

## Add another runtime

Add this object to the `agents` array alongside the existing Codex entry:

```json
{
  "id": "reviewer",
  "provider": "builtin:claude-code",
  "config": {
    "bin": "claude",
    "permission_mode": "plan"
  }
}
```

The Dispatcher can continue using `coding`, while a Team or TeamMate selects
`reviewer`. You can define multiple entries using the same provider with
different model arguments, environment, or permissions.

## Feishu credentials and access

Provider: `builtin:feishu`. Its provider config has two required fields:
`app_id` and `app_secret`. Access policies and conversation bindings do **not**
belong in this block.

To display reasoning in the Feishu COT card, add `"cot": { "reasoning": true }`
inside this channel's `config`. Omission, an empty `cot` object, and an explicit
`false` keep reasoning hidden. Enabled reasoning uses native reasoning events
with a `Thinking...` prefix. Reasoning fragments pass through without redaction;
other activity retains its existing redaction. COT updates are spaced at least
500ms apart, and ordinary assistant text still appears as completed blocks.
Some upstreams deliver reasoning increments only near block completion.

The default access state pairs unapproved users, requires a group @-mention,
and lets unlisted groups follow the sender's user authorization. Pairing is the
normal way to approve a user. See [first-message setup](getting-started.md#5-pair-and-send-your-first-task).

Access policy lives at `~/.dreamux/state/<dispatcher-id>/access.json`:

| Field | Owner and meaning |
| --- | --- |
| `version` | Channel-owned schema version; currently `3`. |
| `dm_policy` | Operator policy: `all`, `allowlist`, `pairing`, or `disabled`. |
| `group.policy` | Operator policy: `block`, `allowlist`, or `follow-user`. |
| `group.allow_chats` | Operator list of trusted groups; human members pass the user gate after group block/mention checks. |
| `group.require_mention` | Operator setting for ordinary human group messages. |
| `allow_users` | Shared authority: live pairing may append users; an independent operator may maintain it while stopped. |
| `pending` | Channel-owned pairing ledger; do not edit. |

An unlisted `allowlist` group is dropped. An unlisted `follow-user` group uses
the user authorization path. Explicitly trusting a group trusts its human
membership, so choose groups accordingly.

For manual access maintenance, use an independent operator: stop the host,
confirm process exit, re-read the file, apply only the intended policy or
`allow_users` change by atomic replacement at `0600`, validate the complete
shape, and restart. Preserve `version` and `pending`. A running channel holds
its state in memory and can overwrite an external edit. The
[access maintenance reference](../packages/dreamux/skills/dispatcher/dreamux-maintenance/references/feishu-access-v3.md)
contains the complete schema and absent-file procedure. `doctor` does not
validate this file.

Bindings, collaboration-space policies, peer-bot records, and document
subscriptions have their own channel-owned state. Manage them through the
channel tools; do not hand-edit those records.

## Plugins and external providers

Feishu, Codex, and Claude Code plugins are loaded automatically. Optional
plugins use `plugins[]`, either as a reference string or a `{ "ref", "config" }`
object. The following is a format example, not an existing package to install:

```json
{
  "plugins": [
    {
      "ref": "npm:@example/dreamux-plugin",
      "config": {}
    }
  ]
}
```

A provider can also be selected through `npm:<package>` or
`npm:<package>#<export>`. The package must already be installed where Dreamux's
loader can resolve it; a config entry does not install dependencies. Only load
packages you intend to execute in the host process.

The repository's `builtin:bootstrap` plugin is an unpublished development
package, not part of a published Dreamux installation. See
[architecture and extensions](architecture.md) for the extension contracts.

## Environment and service startup

Managed services capture their own launch environment. They do not automatically
inherit shell-only API keys, proxies, or runtime home overrides. Put variables
needed by a particular runtime in that runtime's `extra_env`, or configure the
runtime's native authentication for the service user.

Use `dreamux daemon install` after changing Node/runtime installation locations
so the service definition is regenerated. See
[operations](operations.md#manage-the-service) for the lifecycle commands.
