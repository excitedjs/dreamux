# Everyday usage

[Documentation](README.md) / Everyday usage

Talk to Dreamux in Feishu. Use ordinary language to describe the outcome, the
repository, and any constraints. The examples below are requests to an agent;
only the slash commands are fixed syntax interpreted directly by the channel.

## Know who is answering

| Role | Responsibility |
| --- | --- |
| **Dispatcher** | Your main entry point. Handles unbound conversations, creates Teams, and can delegate directly to TeamMates. |
| **TeamLeader** | Coordinates one Team, its task, and its members. Answers the chats or topics bound to that Team. |
| **TeamMate** | A named agent with its own runtime session, instructions, and history. Team members share the Team's workspace. |

A direct message always reaches the Dispatcher. A group topic first uses its
own Team binding, then the group's binding. Otherwise, the Dispatcher receives
it, or a configured collaboration space provisions a Team.

Conversations handled by the Dispatcher agent share its context. Use separate
Dispatchers for unrelated private work; different chats alone do not provide
that separation.

## Start a Team for a task

Tell the Dispatcher where to work and what to deliver:

> Create a Team for `/path/to/project` in a managed Git worktree. Investigate
> why the build fails, propose a fix, and have a separate teammate review it.
> Ask me before merging.

If you configured both runtimes, you can also request roles:

> Use a Codex TeamLeader and a Claude Code reviewer.

These names refer to runtime families; the agent selects actual configured
runtime IDs. Inspect or add those entries in the
[configuration guide](configuration.md#add-another-runtime).

A Team shares one workspace among its members. Managed worktrees separate that
workspace from the source checkout. By default, workspace isolation is off, so
ask explicitly when you want a worktree. Parallel writers still need to agree
on which files they own inside a shared Team workspace.

## Bind a conversation

Ask the Dispatcher to bind a group or topic to the Team:

> Bind this topic to the Team you just created.

Future accepted messages on that route reach its TeamLeader. You can bind a
whole group with `/bind <team_name>`; use the natural-language tool flow for a
single topic. Direct messages cannot be bound to a Team.

**Unbinding and dissolving are different.** Unbinding removes a route and leaves
the Team alive. Dissolving closes the Team and removes its bindings. A dissolved
Team cannot be reopened with `team.send`; a closed ordinary TeamMate can be
reopened by sending it another task.

## Use a topic group as a collaboration space

A collaboration space is a Feishu topic group configured to create a Team for
each new topic. This gives recurring work a natural organization: a group for
the project, a topic for each task, and a Team behind each topic.

Ask the Dispatcher:

> Register this topic group as a collaboration space for `/path/to/project`.
> Create each Team in a managed worktree and use the configured Codex runtime
> for its TeamLeader.

Once the policy is configured, start a new topic and @-mention the bot with your
task. Dreamux creates the Team and binds that topic to it. Follow-ups stay with
that Team.

The group must currently use Feishu's **topic message format**. An ordinary
thread in a normal message group is not enough. The bot needs group information
read permission to determine this format, including for groups converted to
topics after creation.

A group can either be bound as a whole to one Team or registered as a
collaboration space. Release a whole-group binding before turning it into a
space. Updating the space policy affects future Teams; existing Teams and their
bindings remain. Removing the space policy does not dissolve existing Teams.

## Follow up while work is running

Send a correction in the same conversation:

> Keep the API unchanged. Focus the fix on the parser.

The input is submitted without waiting for the current task to finish. The
runtime decides whether inputs join a running turn or become later work; do not
assume one completion per message or an immediate change in behavior.

For visibility, ask the TeamLeader:

> Show the implementer's recent activity while it is still working.

Recent activity can be read without starting or resuming the member. Follow up
with the same member when continuity matters:

> Ask the same reviewer to verify the revised patch.

Ordinary TeamMates can discover and message their owner and peers in the same
collection. They cannot address arbitrary agents in other Teams. A send receipt
means the message was admitted; the recipient must explicitly send a reply.
Feishu COT labels an explicit message to a TeamLeader as
`TEAMMATE MESSAGE FROM <sender>` while preserving its full content for the model.
Native completed or failed turns report to the member's owner, including work
started by a peer. This is live coordination, not a durable offline mailbox:
owner delivery is not guaranteed to replay after an outage.

## Use channel commands

Start the message with the command. In groups, @-mention the Dreamux bot as well;
these commands require the mention even if ordinary group messages do not.

| Command | Effect |
| --- | --- |
| `/help` | List the available commands and their usage. |
| `/teams` | Show all running Teams on this Dispatcher, grouped by repository, with their bound conversations. |
| `/bind <team_name>` | Bind the **whole group** to an existing open Team, even when issued inside a topic. |
| `/stop` | Interrupt the agent directly answering this conversation: its TeamLeader or Dispatcher. TeamMates continue running. |
| `/dissolve` | Close the Team bound to this conversation, subject to workspace cleanup checks. |

These commands run in the channel without asking a model to interpret them.
`/teams` is Dispatcher-wide, so its list is not limited to the Team answering the
current group.

For bot-to-bot collaboration, a separate `/introduce @PeerBot` flow registers a
trusted peer bot for the group. The sender must be explicitly in `allow_users`;
being in a trusted group alone is insufficient. Subsequent peer-bot messages
must @-mention Dreamux. This does not create a TeamMate or bind a Team.

## Schedule follow-up work

Ask the Dispatcher or TeamLeader to create a scheduled prompt:

> Every weekday at 09:17 UTC, inspect the open issues and post a summary here.
> Create a recurring scheduled prompt for this.

The corresponding five-field cron expression is `17 9 * * 1-5`, with the time
zone explicitly set to `UTC`. You can also request a one-shot reminder, pause a
job, change its prompt, list jobs, or delete one.

Jobs belong to the agent that creates them and are stored durably. A due job
submits its prompt even if that agent is already working. The prompt must tell
the agent what to do and where to reply: the scheduler itself does not post
messages or spawn members.

Keep the host running for scheduled delivery. Missed runs are not replayed after
downtime; a missed one-shot is disabled without firing.

## Run a coordinated workflow

For a defined sequence of work, ask for a Dynamic Workflow:

> Run two read-only reviews in parallel, then summarize their findings.
> Use a Dynamic Workflow and report any failed review steps.

The bundled skill guides the agent in writing a script with explicit stages,
parallelism, and result collection. Each workflow agent is a fresh member;
workflow agents do not use ordinary peer messaging. The tool returns a run ID
so the owner can inspect or stop it while it runs.

The script controls orchestration, not model reproducibility. Active scripts do
not resume execution across a server restart. See the bundled
[Dynamic Workflow skill](../packages/dreamux/skills/shared/dynamic-workflow/SKILL.md)
for the script contract and examples.

## Follow document discussions

You can ask an agent to subscribe to a Feishu document's comment events. The
subscription routes events Feishu already delivers to the bot; it does not grant
access or make every comment on every shared document visible.

For example, a bot-authored document can deliver all comments, while another
person's document may only notify the bot when it is mentioned or someone
replies in a thread it joined. The bot must be able to access the document.

## Finish a task

Review the result, commit or merge any work you want to keep, and then ask to
dissolve the Team or use `/dissolve` from its bound conversation.

Managed worktrees default to deletion on close unless configured to be kept.
Uncommitted, untracked, or unmerged work can block cleanup. Resolve the work
before retrying; deleting a worktree does not automatically delete its Git
branch or committed history. A reused directory is kept.
