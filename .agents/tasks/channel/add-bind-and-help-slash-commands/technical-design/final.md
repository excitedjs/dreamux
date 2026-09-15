# Technical solution (final) — Feishu `/bind` and `/help`

Reviewed on [issue #426](https://github.com/excitedjs/dreamux/issues/426); the
adjudication of every finding is in the last section, which is also the record
of what the draft got wrong — the draft itself is not kept.

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
  readonly args: parser.Arguments;
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

Every name below is legal under `validateTeamId` — a leading letter or digit,
then ASCII alphanumerics, dots, underscores and dashes. The middle column is
what the default parser returns, and `String()` cannot undo it:

| name | default | `String(default)` | setting off |
| --- | --- | --- | --- |
| `123` | `123` | `'123'` | `'123'` |
| `1e5` | `100000` | `'100000'` | `'1e5'` |
| `0x1f` | `31` | `'31'` | `'0x1f'` |
| `2.50` | `2.5` | `'2.5'` | `'2.50'` |
| `10.00` | `10` | `'10'` | `'10.00'` |
| `1.` | `1` | `'1'` | `'1.'` |
| `12.` | `12` | `'12'` | `'12.'` |
| `0.0` | `0` | `'0'` | `'0.0'` |

Without the setting, `/bind 1e5` binds a Team called `100000` and `/bind 2.50`
binds `2.5`. An earlier draft claimed dotted names were safe either way; that was
wrong, and the review caught it — the two dotted names first tested (`team.v2`,
`9.9`) happen to round-trip, which is luck rather than a rule. With the setting
off every legal name above survives exactly.

The parser is also the one step that runs outside the dispatch `try`/`catch`.
Measured: `--foo`, `-abc`, `--`, `---`, `--a=b`, `-`, and a lone backslash all
parse without throwing. A test locks that down, because a throw there would
escape the command table's error handling entirely.

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

Only the positionals are read, and only they cross the seam. `Arguments`
carries an `[argName: string]: any` index signature, and the invocation is
handed through `FeishuInboundDelivery` — a pinned public export of this package
— so carrying `Arguments` would have put both that `any` and a devDependency's
type into the published `.d.ts`. `detectFeishuSlashCommand` converts once, and
`FeishuSlashCommandInvocation.args` is `readonly string[]`. The conversion is
free of information loss for the same reason the setting below exists: with
`parse-positional-numbers` off every positional is already a string. A row that
wants a named flag adds a typed field, and the compiler asks for it instead of
a comment asking the next author to remember.

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
  context: Omit<CommandContext, 'args'>,
): Promise<FeishuSlashCommandReply> {
  try {
    return await COMMANDS[invocation.name].execute({ ...context, args: invocation.args });
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
  `bindChannel`/`unbindChannel` accept a target instead of a selector, and
  `FeishuBindTargetSelector` is **deleted** rather than relocated: once the two
  binding methods speak in targets, its only remaining user would be
  `routing-tools.ts`'s own `selector()` helper, and keeping it there would mean
  converting wire shape → selector → target in two hops where one does. So
  `routing-tools.ts` converts its `TargetInput` straight to a `FeishuTarget`.
  `/bind` then hands down the target `projectInbound` produced, kind included,
  and `isBindableTarget` becomes reachable for the first time.

  Full blast radius: two internal call sites in `feishu-session-bindings.ts`,
  the seam interface in `tools/types.ts`, two tool call sites in
  `routing-tools.ts`, and three test files —
  `feishu-session-bindings.test.ts`, `feishu-routing-tools.test.ts`, and
  `feishu-space-tools.test.ts`. The header comment in
  `feishu-session-bindings.test.ts` that documents the guard as unreachable
  stops being true, and is replaced by an actual unit test of the guard rather
  than deleted.
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
    const [teamName] = context.args;
    if (teamName === undefined) {
      return { kind: 'text', text: `Usage: ${COMMANDS.bind.usage}` };
    }
    await context.bindChannel({
      target: containingChat(context.target),
      teamName,
      display: null,
      announceIn: context.target,
    });
    return { kind: 'silent' };
  },
}
```

What it deliberately does **not** do:

- It does not validate the team name. `bindChannel` asks Core for
  `team.status`, and Core's `validateTeamId` rejects a malformed name in its own
  words. A second grammar in the Channel would be a copy that can drift.
- It does not check whether the chat is already bound. The operator ruled
  rebinding is ordinary, and `bindChannel` already moves the route.
- It does not check for a Collaboration Space. An earlier revision of this
  document put that refusal here; §11 records why it moved into
  `FeishuRouting.bind`'s commit and what that closed. The row states intent and
  every refusal arrives as a thrown failure from the layer that owns the fact.

  `bindChannel` did not report the displaced Team anywhere a person could see
  it: it read `previousTeamName`, used it to release the old Team's COT route,
  and returned it to the caller, while `bindingBoundCard` had no parameter for
  it. `routing-tools.ts`'s header — "the previous owner is reported back" —
  is about the MCP tool's `previous_team_name` result field, and reading it as
  card rendering is the mistake that produced an unsatisfiable acceptance
  criterion here.

  Raised with the operator as the product decision it is, the answer was "加一行
  Previous Team". So `bindingBoundCard` gains an optional previous-Team input
  and renders a `Previous Team` line from it, and `bindChannel` supplies it
  under the condition it already computes for releasing the old route:
  `previousTeamName !== null && previousTeamName !== input.teamName`. Rebinding
  a chat to the Team that already holds it therefore renders no line, because
  nothing was displaced. This applies to every caller of `bindChannel`, so an
  MCP-initiated rebind shows the line too — the operator was told that before
  ruling.

### 4c. Where the binding card goes

The draft first assumed a `silent` answer, borrowing `/dissolve`'s reason:
`bindChannel` already sends `bindingBoundCard`, so a receipt would be the second
message about one event. Checking where that card lands showed the reason did
not transfer: `notificationTarget` returns `{ conversationId: chatId }` with no
`replyTo` for any non-topic target, and the knowledge base states the
consequence plainly — a fresh top-level card to a container chat "in a Feishu
topic group creates a new topic"
([`channel.md`](/.agents/domains/channel.md)). A `/bind` typed inside a topic
would announce itself in a new topic and leave the operator's own topic silent.

Offered three receipt shapes, the operator asked instead whether the card logic
could simply be made correct. It can, and the fix is smaller than any of them.

`bindChannel` learns where to announce, defaulting to today's behavior:

```ts
async bindChannel(input: {
  target: FeishuTarget;
  teamName: string;
  display: string | null;
  /** Announce here instead of into the bound target: the conversation that
      asked for the bind, when a conversation asked at all. */
  announceIn?: FeishuTarget;
  requireOwner?: string;
})
```

and the one line that sends becomes:

```ts
this.opts.notify(input.announceIn ?? target, card, input.teamName);
```

`/bind` passes `announceIn: context.target` — the topic or group it was typed
in. Everything else already works:

- `notificationTarget` already replies under the newest message seen in a topic,
  and `projectInbound` already recorded the command's own message as that
  newest message, so the card lands in the operator's topic with no change to
  the router;
- the COT fences (`onRouteReleased` / `onRouteClaimed`) keep using the **bound**
  target, because what was bound did not change;
- an MCP-initiated bind passes no `announceIn` and behaves exactly as today.
  There is nothing to fix there: a tool call has no conversation to reply into,
  and a topic-mode group has no non-topic area to post to.

### The anchor may not follow the card

The sent card is also bookkeeping: `onNotificationSent` records it as an address
for the announce target *and* sets it as the newly bound Team's fallback anchor.
Moving the card without thinking about the second half opens a real hole, found
in review.

A topic can carry a binding row of its own in an ordinary chat — the
Dispatcher's `bind_channel` takes a `thread_id`, and nothing requires the chat to
be a Collaboration Space. So: topic `T` in chat `G` is bound to Team A. Someone
types `/bind B` in `T`. By the operator's ruling `G` binds to B while `T` keeps
routing to A. If B's fallback anchor were set on the card sent into `T`, B's
first unprompted card would land inside A's conversation. `LeaderLifecycleFence.blocksAnchor`
does not stop it: it blocks a leader that closed, or a target fence raised for
**that same leader**, and a fence A raised says nothing about B.

The fix keeps the two halves separate:

```ts
const announce = input.announceIn ?? target;
this.opts.notify(announce, card, sameTarget(announce, target) ? input.teamName : null);
```

**A card sent somewhere other than the target it announces is a receipt, not an
anchor.** `notify`'s third argument already means "the Team whose next
presentation may fall back to this message", and `onNotificationSent` already
returns early on `null`, so no new mechanism appears — the existing one is told
the truth.

This is preferred over gating `announceIn` on whether the topic holds a binding
row, which the review proposed: that gate sends the card back to the chat, where
it opens a new topic and leaves the operator's own topic silent again — the
complaint the change exists to fix. Under the rule above the operator always
sees an answer where they typed, and no Team ever inherits an anchor in a
conversation it does not own.

The address half still moves, and should: `observe` records the newest message
seen in `T`, which is simply true.

**This removes the question.** Once the card reaches the conversation that asked,
`/dissolve`'s reason holds everywhere again, so a successful `/bind` answers
`silent` in every case and the conditional receipt is not needed.

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
| `bindChannel` | `this.bindings.bindChannel(...)`, already wired for the MCP tools; its signature changes under 4a |

No new plumbing, no new seam.

## 7. Verification plan

Unit tests in `packages/channel/feishu-channel/tests/feishu-slash-commands.test.ts`
(existing file) covering each acceptance criterion:

- recognition of `/bind x` yields `{ name: 'bind', args: ['x'] }`;
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
| `.agents/domains/channel.md` | Two places: the Slash commands section (contract line, new rows, Collaboration Space refusal, parse seam), and the "Where a card goes follows the target" invariant, which stops being the whole rule once a bind can announce into the conversation that asked. |
| `packages/channel/feishu-channel/CLAUDE.md` | The "depends on … **only**" sentence and the Boundaries allowed-upstream list both have to admit `yargs-parser`. |
| Rush change file | `@excitedjs/feishu-channel`, type `minor`, ordinary note. No persisted file shape changes, so no `BREAKING:` and no `Rebuild:`. |
| `dreamux-maintenance` | N/A — no config or persisted-state shape, validation, default, ownership, or meaning changes. |

## 9. The recommendation the operator overruled, kept for the record

The TeamLeader recommended adding no library: the command set has zero flags and
at most one positional, a team name cannot contain whitespace so the argument is
`rest.trim()`, and `feishu-channel` had no external runtime dependency. The
operator ruled `yargs-parser` in. The cost is one dependency edge; the gain is
that an option surface, if one is ever wanted, needs no parser written here.

## 10. Review adjudication (issue #426)

One external reviewer. Every finding was checked against code or a measurement
before being accepted; none was taken on the reviewer's word alone.

| # | Finding | Verdict | What changed |
| --- | --- | --- | --- |
| 1 | 4a understated the blast radius: three test files, and the "guard is unreachable" comment should become a real test | **Accepted, verified** — `grep` finds exactly `feishu-session-bindings.test.ts`, `feishu-routing-tools.test.ts`, `feishu-space-tools.test.ts` | Section 4a now lists the full radius and the replacement test |
| 2 | `FeishuBindTargetSelector` has no user left after the change; delete it instead of sinking it, and collapse the double conversion | **Accepted, verified** — its only remaining reference would be `routing-tools.ts`'s own `selector()` | 4a deletes the type; the tool converts wire shape straight to a target |
| 3 | `containingChat` is the right capability | Accepted; no change | — |
| 4 | "Dotted names survive both ways" is false: `2.50`, `10.00`, `1.`, `12.`, `0.0` are legal names that the default parser destroys | **Accepted — the draft was wrong** and this was measured again independently | Section 2 carries the measured table; the two names originally tested round-trip by luck |
| 5 | Recognition runs outside the dispatch `try`/`catch`; lock down that the parser does not throw | **Accepted, verified** by measurement | Section 2 names the test |
| 6 | `announceIn` opens a cross-team anchor hole when the command's topic is separately bound | **Accepted — a real defect** — confirmed by reading `LeaderLifecycleFence.blocksAnchor`, which only fences the same leader | Section 4c |
| 7 | Fix it by gating `announceIn` on the topic holding a binding row | **Adjudicated differently.** That gate sends the card back to the chat, opening a new topic and leaving the operator's topic silent — the very complaint this change exists to remove. The anchor, not the card, is what must not move: a card sent away from the target it announces passes `null` as the anchor Team | Section 4c |
| 8 | Section 8 missed `channel.md`'s "Where a card goes follows the target" invariant | Accepted, verified in the file | Section 8 |
| 9 | `usage`/`summary` plus removing `defineCommand` is a real entropy reduction | Accepted; no change | — |
| 10 | Section 6 said "three fields" while listing four; 4b still returned `BIND_RECEIPT` after 4c settled on `silent` | Accepted | Both corrected |


## 11. Implementation review (PR #428)

Approved. The reviewer re-checked the one adjudication that had overruled its
own earlier proposal and withdrew that proposal: splitting the card's
destination from the anchor is right, and the gate it had suggested would have
sent the card back to the chat in exactly the sub-case the change exists to fix.
It added a second reason for the split that this document had not made — a
finer gate also ages badly, because a topic later rebound to another Team would
strand the first Team's anchor in a topic that no longer routes to it, and
`blocksAnchor` would not reclaim that either. Passing no anchor Team avoids the
whole class. The cost is bounded and accepted: a newly bound Team's unprompted
card has no anchor until the next inbound message in the conversation
establishes one.

Two notes came back non-blocking, and both are settled here:

- Section 1 of this document named the parsed-argument type
  `yargsParser.Arguments` while the code imports it as `parser.Arguments`.
  Documentation only; corrected above.
- Every refusal `/bind` can produce is now owned one layer down and reaches the
  conversation through the same `Command /bind failed: …` wrapper: a direct
  message from `isBindableTarget`, a bad or closed Team from Core through
  `bindChannel`, a route another Team holds from `requireOwner`, and a
  Collaboration Space container from `FeishuRouting.bind`. The command
  re-derives none of them. The prefix is honest — the command did fail — and
  uniform, so no reader has to learn which refusal is the one-off.

  The Space rule reached that layer in a second pass. This document had placed
  it in the command on the ground that it had no other owner, which was wrong:
  `FeishuRouting.bind` already enforces a cross-row precondition (`requireOwner`)
  inside its `store.update` commit, and the routing document holds `bindings`
  and `spaces` together. Moving it there also closed a real hole — MCP
  `bind_channel` could bind a Space container and silently stop its topics from
  being provisioned, because a group row on the container answers `plan` for
  every topic under it before `provision` is reached. That was a user-visible
  MCP change, so it went to the operator as a question card on 2026-09-15; he
  answered **"现在堵，进 #428"**. The rule is narrow by construction: only a
  `group` target is refused, because a topic bind inside the Space is what
  provisioning itself installs.

  The reverse order was found while closing this one and went back as its own
  question card the same day: registering a Collaboration Space on a chat that
  already carried a group binding reproduced the identical shadowing from the
  other side — measured with a throwaway probe, not inferred. The operator
  answered **"堵，拒绝注册"**, so `bindSpace` now refuses a container chat that
  carries a `group` row and names the Team holding it. With both writes guarded
  the rule became one invariant rather than two agreeing checks, and it is
  stated once on `FeishuRoutingDocument` — the type that declares `bindings` and
  `spaces` together — rather than in either method. Topic rows never conflict,
  so a Space with live provisioned topics can still be renamed.
