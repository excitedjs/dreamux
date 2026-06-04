# Top-level design

- **Status:** Accepted
- **Date:** 2026-06-03
- **Affects:** server runtime, dispatcher lifecycle, Feishu channel, Codex MCP, admin/outbound IPC, global config, state files, logs, CLI admin surface, workspace-local dispatcher skill ownership
- **PR / Issue:** Local architecture clarification on 2026-06-03; supersedes the persistence and automatic-outbound parts of issue #2, the runtime-dir parts of `global-config-dir`, and loopback HTTP MCP as the default Feishu MCP transport

## Context

The MVP goal is to make `dreamux` run as a local dispatcher host:

- Feishu inbound messages reach one dispatcher.
- The dispatcher injects accepted messages into one Codex thread.
- Codex can reply to Feishu only by explicitly calling a dispatcher-scoped
  Feishu MCP tool.
- Local operator credentials live in `~/.dreamux/config.json`.

The current source tree accumulated runtime concepts before the MVP worked:
SQLite state, `runtime_dir`, automatic outbound forwarding of model text, and a
loopback HTTP MCP listener. Those pieces hide the product boundary and create
wrong security defaults.

This decision locks the MVP boundary.

## Architecture

`dreamux serve` is one local Node server. It hosts multiple dispatchers in the
same process. Each dispatcher owns exactly one Feishu channel, one Codex
app-server child process, one Codex thread, and one dispatcher-scoped Feishu MCP
stdio session.

```mermaid
flowchart LR
  Feishu["Feishu Open Platform"] <--> Channel["Feishu long-connection channel"]
  Channel --> Gate["access and mention gate"]
  Gate --> Queue["in-memory coalescing queue"]
  Queue --> Codex["Codex app-server child and one Codex thread"]
  Codex -->|"MCP stdio"| MCP["feishu-mcp stdio shim"]
  MCP -->|"local outbound RPC over admin.sock"| Outbound["serve-owned dispatcher outbound endpoint"]
  Outbound --> Channel

  subgraph Dispatcher["one dispatcher"]
    Channel
    Gate
    Queue
    Codex
    MCP
    Outbound
  end
```

Two dispatchers must never share a Feishu app identity, channel instance, MCP
stdio process, Codex app-server child process, Codex thread, or dispatcher state
file.

## Trust Domain

One dispatcher is one shared-context trust domain.

All gate-passing inbound messages for a dispatcher enter the same Codex thread.
If one dispatcher accepts messages from multiple chats, later turns can see
earlier content from the other chats in that dispatcher. This is intentional for
the MVP and is not per-chat isolation.

Operators must use separate dispatchers, with separate Feishu app identities,
when chats should not share context. Future chat-to-session routing is out of
scope for this decision.

The access gate and `doctor` or `status` surfaces must warn when one dispatcher
is configured for, or has observed, more than one allowed chat. The warning must
state that the dispatcher shares one Codex context across those chats.

## Operator Config

`~/.dreamux/config.json` is the only dreamux operator-editable config source.
It holds dispatcher declarations, local Feishu credentials, and the dispatcher
cwd used for the workspace-local skill install.

Example shape:

```json
{
  "dispatchers": [
    {
      "id": "dispatcher-a",
      "cwd": "/path/to/workspace",
      "enabled": true,
      "feishu": {
        "app_id": "APP_ID",
        "app_secret": "APP_SECRET"
      },
      "codex": {
        "extra_args": [],
        "extra_env": {
          "EXAMPLE_FLAG": "1"
        }
      }
    }
  ]
}
```

`feishu.app_id` is a unique dispatcher identity. Across all declared
dispatchers, including disabled dispatchers, an app id must map to exactly one
dispatcher. `dreamux serve`, `doctor`, and `onboard` must fail or report a
blocking error when two dispatchers use the same app id.

Rules:

- Feishu credentials belong only in `~/.dreamux/config.json` for MVP.
- The config file is owner-only (`0600`) because it may contain local Feishu
  secrets.
- Access-gate allowlists are not part of `config.json`. They live in the
  per-dispatcher `access.json` file described below.
- The long-connection MVP uses `app_id` and `app_secret`. Webhook-only
  verification/encryption fields are not part of the MVP schema. If a future
  webhook fallback adds them, they must be treated as secrets:
  owner-only config, redacted from `config show`, `status`, `doctor`, and logs,
  and never passed to Codex or MCP shim processes.
- `app_secret` must be redacted from `config show`, `status`, `doctor`, and
  logs.
- `codex.extra_env` is merged over the server process environment before
  starting that dispatcher's Codex app-server.
- `codex.extra_args` is passed to `codex app-server`.
- dreamux-generated MCP config overrides are injected last, so the dispatcher
  always receives the Feishu MCP server for its own channel.
- dreamux follows Codex's own `~/.codex/` home for Codex auth, config, and
  memory. dreamux must not create dispatcher-private `CODEX_HOME` directories
  for the MVP.
- dreamux does not pin, bundle, or manage the operator's Codex CLI version.
  Codex compatibility is enforced by `doctor`, live tests, and version
  diagnostics.

## State And Logs

State and logs are server-owned. They are not operator-editable config.

```text
~/.dreamux/
  config.json
  state/
    server.json
    admin.sock
    dispatcher-a/
      status.json
      access.json
      codex.sock
  logs/
    dreamux-server.log
    feishu-channel/
      dispatcher-a.log
    codex-app-server/
      dispatcher-a.log
```

`server.json` stores process-level status only: pid, status, version, started
time, admin socket path, and last error.

`status.json` stores dispatcher process status, last-known Codex thread id,
child process status, and diagnostic timestamps. It must not contain Feishu
credentials.

`access.json` stores dispatcher-local access state. The MVP shape is:

```json
{
  "version": 1,
  "dm": {
    "allow_users": ["USER_ID"]
  },
  "group": {
    "allow_chats": ["CHAT_ID"],
    "follow_users": ["USER_ID"],
    "require_mention": true
  },
  "observed_chats": ["CHAT_ID"],
  "warnings": [
    "dispatcher shares one Codex context across multiple Feishu chats"
  ],
  "last_gate": null
}
```

It must not contain credentials, queued inbound messages, dedupe state, or a
reaction ledger.

`codex.sock` is the Codex app-server WebSocket-over-Unix-socket endpoint for the
dispatcher. It is not the Feishu MCP transport. The Feishu MCP default transport
is stdio.

Socket path builders must live in `src/runtime/paths.ts`. They must enforce a
short Unix socket path budget before spawning child processes. Dispatcher ids are
validated as stable path segments and length-checked so derived `admin.sock` and
`codex.sock` paths stay within Linux and macOS `sun_path` limits.

There is no `runtime_dir`, no SQLite database, no persisted inbound message
queue, and no persisted reaction ledger.

## Dispatcher Lifecycle

On startup, the server:

- loads `~/.dreamux/config.json`;
- validates dispatcher ids, app id uniqueness, socket path budgets, and access
  gate configuration;
- starts one Feishu long-connection WebSocket client per dispatcher;
- starts one Codex app-server child per dispatcher;
- prepares one dispatcher-scoped Feishu MCP stdio command for the Codex thread;
- resumes the saved Codex thread id when available.

If a Codex app-server child process exits, or the dispatcher loses the child
WebSocket connection, the server marks the dispatcher degraded, restarts the
child with backoff, and attempts to resume the saved thread id.

There is no turn timeout. A stuck Codex turn does not cause a child-process
restart. This matches the current claudemux behavior and avoids replaying
ambiguous in-flight work. Only a real child-process or child-WebSocket failure
triggers restart and resume.

Inbound messages are not persisted. A server restart drops queued and in-flight
inbound work.

## Feishu Inbound

Inbound transport is Feishu SDK long-connection WebSocket. Webhook delivery is
out of scope for the MVP.

The MVP handles `im.message.receive_v1`. Other Feishu event kinds are ignored
until a later decision adds them.

Accepted messages enter one per-dispatcher in-memory queue. The queue is
serialized: only one Codex turn runs per dispatcher at a time.

Consecutive inbound messages from the same chat are coalesced into one Codex
turn. If a chat already has a pending batch, new messages for that chat are
appended to that batch. If the chat has the running turn, new messages become
the next batch for that chat. Cross-chat batches remain serialized through the
single dispatcher thread.

The dispatcher keeps an in-memory, bounded `message_id` dedupe window so Feishu
redelivery does not create duplicate turns during the same server process
lifetime. This window is safe to lose on restart.

Each inbound message block passed to Codex includes:

```xml
<feishu_message
  chat_id="CHAT_ID"
  chat_type="group"
  message_id="MESSAGE_ID"
  sender_id="USER_ID"
  sender_name="Sender Name"
  create_time="2026-06-03T00:00:00.000Z">
Message text after best-effort parsing.
</feishu_message>
```

A coalesced turn contains multiple `feishu_message` blocks from the same chat in
receive order. The prompt must tell Codex to use the `message_id` it is replying
to, usually the newest message in the batch.

Mention parsing follows the Feishu channel plugin style:

```xml
<at id="USER_ID">Display Name</at>
```

When rich content parsing fails, the dispatcher still passes `message_id`,
`chat_id`, `sender_id`, and `sender_name` into the Codex turn and instructs Codex
to use the Feishu skill and `lark-cli` fallback to fetch message text.

`sender_name` is a best-effort seam. Feishu `im.message.receive_v1` does not
provide a sender display name in the native event envelope today, so the MVP
emits `sender_name=""` unless a later channel enricher supplies one. Codex should
use the Feishu skill fallback when it needs a human-readable sender name.

Messages rejected by the access gate are discarded. Rejected messages do not
enter the Codex thread.

## Access Gate

The access gate is dispatcher-local.

For one-on-one chats, the sender must be allowed.

For group chats, the MVP follows the claudemux Feishu channel shape:

- the chat must be allowed when a chat allowlist is configured;
- the sender must be allowed when a follow-user allowlist is configured;
- the bot must be mentioned for a group message to enter the dispatcher.

When no group chat allowlist or follow-user allowlist is configured, group
messages are still mention-gated. This keeps bootstrap usable while preventing
ambient group chatter from entering the dispatcher.

The gate adds a channel-owned received reaction only after a message is accepted
and enqueued. If the message is rejected, no reaction is added.

When one dispatcher is configured for, or observes, multiple allowed chats, the
gate records an operator warning that those chats share one Codex context.

## Feishu MCP

Codex sends Feishu outbound actions only through a dispatcher-scoped MCP server.
Model text is never automatically forwarded to Feishu.

The default MCP transport between Codex and the Feishu MCP server is stdio.
`dreamux` injects a per-dispatcher MCP server command into the Codex thread. The
generated command path must be an absolute `dreamux` launcher path, resolved from
the launcher-provided `DREAMUX_BIN` environment variable when available and from
the package bin path otherwise. Schematically:

```text
<dreamux-bin> feishu-mcp --dispatcher dispatcher-a
```

The stdio process is a thin MCP shim. It is scoped to exactly one dispatcher,
implements the MCP protocol on stdin/stdout, and forwards outbound requests to
the live `dreamux serve` process through a dispatcher-scoped outbound RPC on the
local admin socket. It must not expose a TCP listener.

The shim does not read `~/.dreamux/config.json`, does not receive Feishu
credentials in argv or environment variables, does not create a Feishu SDK
client, and does not hold channel or reaction state. The only process that reads
Feishu credentials and owns the Feishu SDK long-connection client is
`dreamux serve`. The generated command or environment may pass only routing
metadata such as the dispatcher id and admin socket path.

The serve-owned outbound RPC endpoint performs `reply` and `react` for the
specified dispatcher. A successful `reply` also clears the current-process
channel-owned received reaction for the replied message. This keeps Feishu
credentials and reaction ownership in the same process that added the reaction.

The default stdio design does not need a bearer token because the Codex-facing
transport is a parent-child pipe and the shim-to-serve hop uses the local
file-permission-scoped admin socket.

If stdio lifecycle management or per-dispatcher injection proves infeasible, the
only allowed fallback is loopback HTTP with a mandatory per-boot,
dispatcher-specific bearer token. The token must be passed through an
environment variable or file descriptor, or stored in a `0600` file under
server-owned state. It must never be written to `config.json`, logs, repo files,
or a world-readable file. An unauthenticated HTTP fallback is not allowed.

The MVP MCP tool surface is:

- `reply`: send a message to a Feishu chat. Parameters are `chat_id`, `text`,
  optional `message_id`, and optional `mention_user_ids`. The `message_id`
  should be the inbound Feishu message id when the model wants Feishu to keep
  topic-mode replies under the original topic.
- `react`: add a model-owned reaction to a Feishu message. Parameters are
  `message_id` and `emoji`.

`edit_message` and model-owned `remove_reaction` are out of scope for the MVP.

Reply failures return an MCP tool error and are logged. There is no persisted
outbound retry queue.

## Reaction Ownership

Channel-owned reactions and model-owned reactions are separate in process
memory only.

The serve process records the received reactions its channel added during the
current server process lifetime. After a successful `reply` through the
serve-owned outbound RPC endpoint, the channel clears only those current-process
channel-owned reactions for the replied message.

The model-owned `react` tool only adds reactions requested by Codex. The channel
must not clear model-owned reactions.

Because reaction ownership is not persisted, a server restart can leave an old
channel-owned received reaction behind. This is an accepted MVP limitation.

## Feishu Skill Fallback

The dispatcher assumes the operator already has the Feishu skill and `lark-cli`
available in Codex. `dreamux` does not install that skill in this MVP.

When the dispatcher cannot parse inbound rich content, it should tell Codex to
use the Feishu skill and `lark-cli` with the provided `message_id` to fetch the
message body.

## Dispatcher Skill And TM

`@excitedjs/tm` is a direct dependency of `@excitedjs/dreamux`. The package ships
a `tm` bin wrapper.

When `dreamux` starts a dispatcher Codex thread, it injects the package `tm` bin
location into that thread's `PATH`. This lets the dispatcher skill call bare
`tm` without constructing long `npx` commands.

During `onboard`, `dreamux` copies the bundled dispatcher skill into:

```text
<dispatcher cwd>/.codex/skills/dispatcher/SKILL.md
```

The workspace-local skill is intentionally not installed into the operator's
global `~/.codex/skills`.

`uninstall` removes dreamux-owned config, state, logs, and service integration
by default. It reports workspace-local dispatcher skill paths that were created
by `onboard`, but it does not delete files under operator workspaces by default.

## CLI And Admin

`dreamux serve` is the foreground server entry point.

The admin socket is local-only and file-permission scoped. CLI commands such as
`status`, `doctor`, `dispatcher status`, and future dispatcher control commands
talk to the server through the admin socket. The `feishu-mcp` stdio shim also
uses this socket for dispatcher-scoped outbound RPC.

The admin socket is not the Feishu MCP transport.

`dreamux dispatcher stop` and `dreamux dispatcher start` are the manual recovery
path for a stuck turn. Stopping a dispatcher drops its in-memory queue and
in-flight turn state; starting it follows the normal child start and thread
resume path.

## Out Of Scope

- Per-chat Codex threads or chat-to-session routing.
- Webhook inbound delivery.
- Webhook-only config fields such as Feishu encrypt keys or verification tokens.
- SQLite-backed runtime state.
- Persisted inbound queues.
- Persisted reaction ledgers or startup cleanup of old reactions.
- Restarting Codex because a turn is merely slow or stuck.
- Automatic forwarding of model output to Feishu.
- Installing or managing the global Feishu Codex skill.
- Pinning, bundling, or hosting a specific Codex CLI version.
- Feishu `edit_message` and model-owned `remove_reaction`.

## Known Limitations

- A dispatcher that accepts multiple chats shares one Codex context across those
  chats. This is a trust-domain choice, not isolation.
- Server restart drops queued and in-flight inbound messages.
- Server restart can leave a previously added channel-owned received reaction
  visible in Feishu because no reaction ledger is persisted.
- A stuck Codex turn can block that dispatcher queue until the child process or
  child WebSocket actually fails, or until the operator stops and starts that
  dispatcher through the admin socket.
- Same-chat coalescing reduces turn count, but per-chat batches and the
  cross-chat queue are in-memory and not globally size-bounded in the MVP. A
  stuck turn plus continued inbound traffic can grow memory until operator
  intervention or process restart.
- Codex version drift can still break protocol behavior. `dreamux` detects and
  reports this through `doctor`, live tests, and version diagnostics instead of
  pinning Codex.

## Validation Targets

- Missing `~/.dreamux/config.json` fails loudly and points to `dreamux onboard`.
- Duplicate Feishu app ids are rejected across all declared dispatchers,
  including disabled dispatchers.
- `app_secret` is redacted from config display, status, doctor output, and logs.
- Socket path builders reject paths that would exceed the supported Unix socket
  path budget.
- `dreamux serve` starts one Feishu long-connection WebSocket per dispatcher.
- A fake `im.message.receive_v1` event reaches the correct Codex thread.
- Same-chat message bursts are coalesced into one Codex turn.
- Redelivered `message_id` values are deduped within one server process.
- Unauthorized messages are dropped before entering Codex.
- Multi-chat dispatcher access emits an operator-visible trust-domain warning.
- Codex receives a dispatcher-scoped Feishu MCP stdio shim, not a loopback HTTP
  listener, on the default path.
- The live Codex compatibility gate starts a real Codex app-server with the
  injected stdio MCP config and asserts `mcpServerStatus/list` exposes the
  Feishu `reply` and `react` tools.
- The `feishu-mcp` shim forwards `reply` and `react` to `dreamux serve` through
  the local admin socket and never reads Feishu credentials.
- If HTTP fallback is ever implemented, it refuses to start without a per-boot,
  dispatcher-specific bearer token delivered through env, fd, or a `0600` state
  file.
- Codex text output alone sends nothing to Feishu.
- The MCP `reply` tool reaches the serve-owned outbound RPC endpoint, sends
  Feishu output, and clears only current-process channel-owned received
  reactions for the replied message.
- The MCP `react` tool adds model-owned reactions that channel cleanup does not
  remove.
- Restarting the server does not try to clean up old received reactions.
- Codex app-server child or child-WebSocket failure triggers backoff restart and
  thread resume.
- A stuck turn alone does not trigger child restart.
- `uninstall` reports workspace-local dispatcher skill paths but does not delete
  them by default.
