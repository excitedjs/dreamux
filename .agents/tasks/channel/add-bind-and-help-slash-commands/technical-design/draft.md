# Technical solution — Feishu `/bind` and `/help`

Requirement: [requirement.md](/.agents/tasks/channel/add-bind-and-help-slash-commands/requirement.md).

## What changes, in one sentence

The Feishu command table stops being a name-only table: a row gains the two
strings that describe it, recognition hands the row its parsed arguments, and
two new rows use both.

## 1. Recognition returns an invocation

`detectFeishuSlashCommand` today returns a name and throws the rest of the line
away. It starts returning what it recognized:

```ts
export interface FeishuSlashCommandInvocation {
  readonly name: FeishuSlashCommandName;
  readonly args: yargsParser.Arguments;
}
```

The remainder of the line — everything after the matched token — is parsed once,
at the point of recognition, and travels with the name. There is exactly one
parse site, and the type crossing `FeishuInboundDelivery.command()` stays one
type rather than becoming a name plus a loose string.

`FeishuSlashCommand` is renamed `FeishuSlashCommandName`, because the union is
now one field of the invocation rather than the whole of it.

One trap in the existing decoder: it lowercases the line into `lower` for
matching. The remainder must be sliced from the **original** `text`, not from
`lower` — `validateTeamId` accepts `A-Z`, so slicing `lower` would turn
`/bind MyTeam` into a bind of `myteam`.

## 2. `yargs-parser`, and the one setting it needs

The operator ruled the library in. It is used for real — it is the parse at
recognition, not an unused dependency:

```ts
import parser from 'yargs-parser';

const PARSER_CONFIG = {
  configuration: { 'parse-positional-numbers': false },
} as const;
```

That setting is not defensive. Measured on `yargs-parser@21.1.1`:

| input | default | `parse-positional-numbers: false` |
| --- | --- | --- |
| `123` | `_: [123]` (number) | `_: ['123']` |
| `1e5` | `_: [100000]` | `_: ['1e5']` |
| `0x1f` | `_: [31]` | `_: ['0x1f']` |

All three are legal team names under `validateTeamId` — it requires a leading
letter or digit and allows ASCII alphanumerics, dots, underscores and dashes.
Without the setting, `/bind 1e5` binds a Team called `100000`. Dotted names
(`team.v2`, `9.9`) survive both ways; positional dot-notation is a flag feature.

Dependency shape:

- `dependencies`: `yargs-parser@^21.1.1` — already resolved in
  `pnpm-lock.yaml` as the CLI's transitive dependency, so nothing new enters
  the store.
- `devDependencies`: `@types/yargs-parser@^21.0.3` — the runtime package ships
  no declarations. Also already in the lock, via `@types/yargs`.
- It is ESM (`"type": "module"`, `import` condition on `.`), and the package's
  `esModuleInterop` / `allowSyntheticDefaultImports` are already on, so the
  `export =` declaration imports as a default.
- This is `@excitedjs/feishu-channel`'s first non-workspace runtime dependency.
  It stays inside the channel package; nothing about it reaches core. The
  package `description` currently claims it "depends on @excitedjs/dreamux-types
  + @excitedjs/feishu-transport only"; that sentence is updated in the same
  change.
- `rush.json` has no `approvedPackagesPolicy`, so there is no approved-packages
  file to add an entry to.
- **This changes a declared package boundary.**
  `packages/channel/feishu-channel/CLAUDE.md` states the package "depends on
  `@excitedjs/dreamux-types`, `@excitedjs/dreamux-utils`, and
  `@excitedjs/feishu-transport` **only**", and its Boundaries section repeats
  the allowed-upstream list. The operator's ruling changes that boundary, so
  the file is edited in the same change to name `yargs-parser` and say what it
  is for. This is the Knowledge Delta trigger for this task: a package boundary
  moved.

Only `args._` is read. `Arguments` carries an `[argName: string]: any` index
signature, so reading a named flag would hand `any` to the lint gates — no row
reads one, and none may without revisiting this.

## 3. The table row gains its own description

```ts
interface CommandDefinition {
  readonly usage: string;
  readonly summary: string;
  execute(context: CommandContext): Promise<FeishuSlashCommandReply>;
}
```

`defineCommand` is deleted. Its only job was wrapping `execute` in a try/catch
that produced a hand-written `Command /stop failed` label per row; the label is
built at dispatch from the table key instead, so the command's name stops being
duplicated as a string in five places:

```ts
export async function dispatchFeishuSlashCommand(
  invocation: FeishuSlashCommandInvocation,
  context: CommandContext,
): Promise<FeishuSlashCommandReply> {
  const command = COMMANDS[invocation.name];
  try {
    return await command.execute({ ...context, args: invocation.args });
  } catch (error) {
    return {
      kind: 'text',
      text: `Command /${invocation.name} failed: ${errorMessage(error)}`,
    };
  }
}
```

Same output as today, one fewer function, one fewer place a name is spelled.

The table is reordered alphabetically — `bind`, `dissolve`, `help`, `stop`,
`teams` — so `/help` has a defensible order without a sort call. Reordering is
safe: recognition matches a whole token, and no command name is a prefix of
another.

## 4. `/bind`

### 4a. The target handed down must carry its kind

`bindChannel` takes a `FeishuBindTargetSelector` — `{ chatId, threadId? }` — and
converts it with `selectorTarget`, which maps a bare `chatId` to
`chatTarget(chatId, 'group')`. It can only guess, because a chat id does not say
whether it is a group or a direct message. The repository already knows this and
wrote it down, in the header of
`tests/feishu-session-bindings.test.ts`:

> `bindChannel`'s `isBindableTarget` p2p guard is not exercised here: its own
> `FeishuBindTargetSelector` input has no `kind` field, and `selectorTarget`
> always maps a bare `chatId` to a `group` target, so a p2p target can never
> reach this method through its public surface.

So a `/bind` in a direct message would not hit the p2p refusal. It would write a
`group\0<dm-chat-id>` row. That row routes nothing — `plan()` answers
`dispatcher`/`not_bindable` for a p2p target whatever rows exist, which is the
reachable enforcement the same comment names — but it is junk in
`list_bindings`.

Two ways to close it:

- **(a) recommended — the binding operation takes a `FeishuTarget`.**
  `bindChannel`/`unbindChannel` accept a target instead of a selector;
  `selectorTarget` moves to `tools/routing-tools.ts`, where the selector is what
  it actually is: an MCP wire shape being converted at the MCP boundary. `/bind`
  then hands down the target `projectInbound` produced, kind included, and
  `isBindableTarget` becomes reachable for the first time. Two internal call
  sites, one seam interface in `tools/types.ts`, two tool call sites.
- **(b) the command checks `context.target.kind === 'p2p'` itself.** Two lines,
  no signature change — but it puts a bindability rule in the command while the
  binding layer's own guard stays dead, and the awkwardness above stays true.

(a) is recommended: afterwards the rule is "a binding operation takes a target",
one concept instead of a selector plus a guessing conversion. It does not fix
the MCP tool's guess — `bind_channel` still receives a bare `chat_id` and still
cannot tell a DM from a group. That limitation is recorded, not fixed here:
only inbound projection knows a chat's kind.

The chat a target belongs to becomes a named capability in `routing/target.ts`,
next to `resolutionChain`, rather than a branch inside the command:

```ts
/** The chat a target lives in: a topic's parent group, or the target itself. */
export function containingChat(target: FeishuTarget): FeishuTarget {
  return target.kind === 'topic' ? chatTarget(target.chatId, 'group') : target;
}
```

That one function is the operator's "永远绑整个群": a topic resolves to its
group, a group stays itself, and a direct message stays a direct message so the
refusal fires.

### 4b. The command

```ts
bind: {
  usage: '/bind <team_name>',
  summary: 'Route this group to a Team.',
  async execute(context) {
    const [first] = context.args._;
    if (first === undefined) {
      return { kind: 'text', text: `Usage: ${COMMANDS.bind.usage}` };
    }
    if (context.spaceContainer !== null) {
      return {
        kind: 'text',
        text:
          'This chat is a Collaboration Space, which gives each of its topics ' +
          'its own Team. Bind a chat that is not a Collaboration Space.',
      };
    }
    await context.bindChannel({
      target: containingChat(context.target),
      teamName: String(first),
      display: null,
    });
    return BIND_RECEIPT;  // open question Q5, see below
  },
}
```

What it deliberately does **not** do:

- It does not validate the team name. `bindChannel` asks Core for
  `team.status`, and Core's `validateTeamId` rejects a malformed name in its own
  words. A second grammar in the Channel would be a copy that can drift.
- It does not check whether the chat is already bound. The operator ruled
  rebinding is ordinary; `bindChannel` reports the previous Team on its card.

### 4c. Open question Q5 — what a successful `/bind` answers

The draft first assumed `silent`, borrowing `/dissolve`'s reason: `bindChannel`
already sends `bindingBoundCard`, so a receipt would be the second message about
one event. Checking where that card lands showed the reason does not transfer
everywhere. `notificationTarget` returns `{ conversationId: chatId }` with no
`replyTo` for any non-topic target, and in a topic-mode group a message with no
`replyTo` opens a **new topic**.

So for `/bind` typed inside a topic of an ordinary (non-Space) topic group:

- the card announcing the bind appears as a new topic, not in the topic the
  command was typed in;
- and if that topic has a binding row of its own, `resolutionChain` keeps
  routing it to its old Team, so the conversation the operator typed in is
  unchanged.

Under `silent` that operator sees no answer at all. This is a consequence of the
"永远绑整个群" ruling rather than a reason to revisit it, and it is on a
clarification card to the operator. The three answers are: a text line only when
the command was typed somewhere other than the chat it bound; always silent;
always a text line.

## 5. `/help`

```ts
help: {
  usage: '/help',
  summary: 'Show this list.',
  execute: async () => ({
    kind: 'text',
    text: [
      '**Dreamux commands**',
      ...Object.values(COMMANDS).map((c) => `- \`${c.usage}\` — ${c.summary}`),
    ].join('\n'),
  }),
}
```

A `kind: 'text'` reply is already delivered as an interactive card holding one
`markdown` element, so this renders as a card without any card-building code.
Because it reads the table, a new row appears in `/help` with no second edit.

## 6. Context additions

`CommandContext` gains three fields, all already held by the
`FeishuChannelSession` that builds the context in `feishu-channel.ts`:

| field | source |
| --- | --- |
| `args` | the invocation, merged in at dispatch |
| `target` | `input.target`, already a parameter of `command()` |
| `spaceContainer` | `this.routing.spaceForContainer(input.target.chatId)`, `?? null` |
| `bindChannel` | `this.bindings.bindChannel(...)`, already wired for the MCP tools; its signature changes under 4a |

No new plumbing, no new seam.

## 7. Verification plan

Unit tests in `packages/channel/feishu-channel/tests/feishu-slash-commands.test.ts`
(existing file) covering each acceptance criterion:

- recognition of `/bind x` yields `{ name: 'bind', args: { _: ['x'] } }`;
- `123`, `1e5`, `0x1f` survive as strings;
- `/bind` with no argument answers the usage line and does not call
  `bindChannel`;
- a Collaboration Space container refuses and does not call `bindChannel`;
- an ordinary chat calls `bindChannel` with the chat-level target and answers
  `silent`;
- typed inside a topic, the target passed to `bindChannel` is the chat;
- typed in a direct message, nothing is bound and no row is written;
- `/bind MyTeam` binds `MyTeam`, not `myteam`;
- a throwing `bindChannel` becomes `Command /bind failed: …`;
- `/help` names every table row;
- `/stop`, `/teams`, `/dissolve` keep their current answers with trailing words
  present.

Gates: `rush build`, `rush lint`, `rush test`, `rush typecheck:tests`. The
`update` step must run first, since two dependencies are added.

## 8. Knowledge closeout owners

| Owner | What changes |
| --- | --- |
| `.agents/product/README.md` | The slash-command entry says "no command takes an argument"; it gains `/bind` and `/help` and states that a command may now take one. |
| `.agents/domains/channel.md` | The Slash commands section: the same contract line, the new rows, the Collaboration Space refusal, and the parse seam. |
| `packages/channel/feishu-channel/CLAUDE.md` | The "depends on … **only**" sentence and the Boundaries allowed-upstream list both have to admit `yargs-parser`. |
| Rush change file | `@excitedjs/feishu-channel`, type `minor`, ordinary note. No persisted file shape changes, so no `BREAKING:` and no `Rebuild:`. |
| `dreamux-maintenance` | N/A — no config or persisted-state shape, validation, default, ownership, or meaning changes. |

## 9. The recommendation the operator overruled, kept for the record

The TeamLeader recommended adding no library: the command set has zero flags and
at most one positional, a team name cannot contain whitespace so the argument is
`rest.trim()`, and `feishu-channel` had no external runtime dependency. The
operator ruled `yargs-parser` in. The cost is one dependency edge; the gain is
that an option surface, if one is ever wanted, needs no parser written here.
