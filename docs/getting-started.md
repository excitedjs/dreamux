# Getting started

[Documentation](README.md) / Getting started

This guide takes you from an installed runtime to a working conversation with
Dreamux. The default setup uses Codex and Feishu; Claude Code is also built in.

## 1. Prepare the host and runtime

| Requirement | What to prepare |
| --- | --- |
| Host | Linux or macOS, with Bash and Node.js **22.7 or newer** |
| Agent runtime | **Codex 0.137+** or a working **Claude Code** CLI, authenticated as the host user |
| Workspace | A directory the agent can access; install Git if you will use managed worktrees |
| Feishu | A bot application you can configure and publish, its App ID and App Secret, and access to its owner or creator for pairing |
| Network | Outbound access to Feishu and to the selected runtime's model service |

Check the tools you intend to use:

```bash
node --version
codex --version
# If you selected Claude Code instead:
claude --version
```

Authenticate and run a small task directly in the selected CLI before setting up
Dreamux. Dreamux uses that runtime's authentication and model access; installing
Dreamux does not install or authenticate the runtime for you.

The managed service uses Linux systemd user services or macOS launchd. On a host
without a working user service manager, use the foreground path below. Native
Windows service installation is not provided.

## 2. Prepare a Feishu bot

Create a self-built application in the
[Feishu Developer Console](https://open.feishu.cn/app), enable its bot capability,
and make it available to the people who will use it. Feishu's
[bot tutorial](https://open.feishu.cn/document/develop-an-echo-bot/introduction)
explains the application setup flow.

Use **long-connection / WebSocket delivery**. Dreamux connects outward through
the Feishu SDK; it does not require a public webhook server or webhook
verification/encryption fields in its config.

Configure the platform permissions for receiving messages, sending bot replies,
reading the conversations you use, and interacting with cards. Subscribe to the
following events/callbacks as appropriate:

| Event or callback | Used for |
| --- | --- |
| `im.message.receive_v1` | Receiving chat messages; required for conversation |
| `card.action.trigger` | Pairing approvals and interactive question cards |
| `im.chat.member.bot.added_v1` | Observing bot membership changes |
| `drive.notice.comment_add_v1` | Document-comment delivery, if you use document subscriptions |

The exact permissions depend on which features you enable. The
[receive-message API documentation](https://open.feishu.cn/document/server-docs/im-v1/message/events/receive)
provides the platform requirements for message events. Two Dreamux-specific
setup details deserve attention:

- **Group information:** the bot must be a member of the group and have a
  permission accepted by Feishu's chat-information API, such as
  `im:chat:readonly`. Dreamux reads the group's current message format before
  automatically creating topic Teams.
- **Pairing approver:** Dreamux reads application information to identify the
  creator and eligible App Owner. The transport reports
  `application:application:self_manage` or `admin:app.info:readonly` when that
  lookup fails. Grant the applicable permission in your app configuration.

Publish or update the application after changing its settings. Save its App ID
and App Secret for the onboarding wizard. Dreamux does not create or publish
this Feishu application for you.

## 3. Install and onboard

Install the published package:

```bash
npm install --global @excitedjs/dreamux
```

Run the interactive wizard from a terminal:

```bash
dreamux onboard \
  --dispatcher-id main \
  --dispatcher-cwd "$HOME/projects/agent-workspace"
```

The wizard asks for the runtime provider, channel provider, their settings, and
whether to register and start a user service. Defaults are `builtin:codex` and
`builtin:feishu`. Select `builtin:claude-code` if you prepared Claude Code.

The wizard creates the workspace if needed, writes
`~/.dreamux/config.json` with mode `0600`, prepares state/log directories, and
runs provider diagnostics. It registers and starts the service if you accepted
those options. Bundled orchestration skills are supplied to agents at runtime;
there is no separate skill-copy step.

Without `--dispatcher-id` and `--dispatcher-cwd`, the defaults are `dispatcher`
and your current directory.

### Foreground operation

To keep the server attached to your terminal, decline service registration or
run:

```bash
dreamux onboard --no-register-service
dreamux serve
```

Leave that terminal open and run checks from another terminal. Choose either
foreground operation or the managed service for the same Dreamux root.

### Non-interactive setup

For automation, `--yes` accepts defaults and takes the remaining values from
options. Provider JSON arguments should include the matching ID prefix:

```bash
dreamux onboard --yes --dry-run \
  --dispatcher-id main \
  --dispatcher-cwd "$HOME/projects/agent-workspace" \
  --agent main=builtin:codex \
  --agent-config-json 'main={"sandbox_mode":"workspace-write"}' \
  --channel primary=builtin:feishu \
  --channel-config-json 'primary={"app_id":"<APP_ID>","app_secret":"<APP_SECRET>"}' \
  --no-register-service
```

This is a preview using placeholders. For a real install, supply local values
and remove `--dry-run`. Prefer the interactive secret prompt for manual setup
so credentials do not enter shell history. A dry run prints the planned file
ledger and skips real provider diagnostics.

This example opts out of service registration. After the real onboarding run,
start `dreamux serve` and leave it running; perform the checks below in another
terminal. To switch to a managed service instead, run `dreamux daemon install`.

## 4. Check the installation

```bash
dreamux doctor
dreamux status
dreamux dispatcher status --id main
```

Use the ID you chose during onboarding. `doctor` checks local setup; `status`
and `dispatcher status` query the running server.

A successful doctor report is not an end-to-end Feishu test. It does not verify
live app credentials, platform permissions, or access-state validity; the Claude
Code check does not verify authentication. The next step verifies the actual
conversation path.

## 5. Pair and send your first task

1. Open a direct message with your Feishu bot and send a short greeting.
2. Under the default access policy, an unapproved user receives a pairing card.
   Have the application creator or eligible App Owner approve it.
3. **Send your request again after approval.** The request that triggered pairing
   is not automatically replayed.
4. Ask for a small, observable task:

   > List the files in your workspace and explain what you can help me do here.

Direct messages reach the Dispatcher. In a group, add the bot and @-mention it.
Pairing approves a user; it does not implicitly trust everyone in that group.

Next, try [creating a Team](usage.md#start-a-team-for-a-task), or configure a
[collaboration space](usage.md#use-a-topic-group-as-a-collaboration-space) for a
repository you work on regularly.

If the bot stays silent, follow the symptom table in
[operations and troubleshooting](operations.md#troubleshooting).
