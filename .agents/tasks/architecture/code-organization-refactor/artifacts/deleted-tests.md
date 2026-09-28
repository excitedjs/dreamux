# Deleted tests ledger

This is the ledger for the final test completion on PR #453. Every pull
request in the code-organization-refactor stack writes no new unit tests and
repairs none: a test case that no longer passes is deleted outright, never
re-pointed or edited to pass. Each entry below records the test file and case
name, the contract that test pinned, and the failure that made it fail after
this stage's change, so the final test completion on PR #453 can restore the
coverage under the new contract.


## Standing high-risk entry: the issue #63 live gate

`packages/dreamux/tests/codex-live.test.ts` is the issue #63
non-blocking-inbound live gate. A Dispatcher inbound must reach the runtime
immediately while a turn is running, with no application-level queue or
mutex (see `.agents/domains/non-blocking-dispatcher-inbound.md`). Under R43
it gets no exception: if it fails in any stage, it is deleted and logged here
like any other test. The operator marked it high-risk: "这条是高危单测，需要重点覆盖。"
The final test completion on PR #453 must restore it with focused coverage of
the immediate-submit path, whether or not it was deleted.

## PR-0

- **File / case:** `packages/dreamux/tests/plugin-loader.test.ts` —
  `readPluginConfigs > gives each plugin its own entry config and rejects
  config for a plugin without a reader`.
  **Contract pinned:** a `plugins[]` entry's `config` block for a plugin with
  no `config.read` throws a `PluginLoadError` naming the plugin and the
  `plugins[N].config` path (bundled in the same case with the still-valid
  coverage that each plugin's own `config.read` receives its own entry's
  block).
  **Failure:** R21 changes the policy this pinned — persisted and configured
  input tolerates unknown fields everywhere, so `readPluginConfigs` now
  ignores a `config` block for a plugin with no reader instead of rejecting
  it (`packages/dreamux/src/plugin/loader.ts`, `readPluginConfigs`). The
  `rejects.toThrow` assertion on the stray-config half of the case no longer
  holds.

- **File / case:** `packages/dreamux/tests/plugin-loader.test.ts` —
  `plugins[] through loadConfig > surfaces a readPluginConfigs failure
  through the full loadConfig pipeline, after providers and dispatchers
  validate`.
  **Contract pinned:** the full `loadConfig` pipeline propagates a
  `readPluginConfigs` rejection (a `config` block on a plugin with no reader)
  as a thrown error, after provider and dispatcher validation already ran.
  **Failure:** same R21 policy change — `readPluginConfigs` no longer throws
  for this input, so `loadConfig` no longer rejects and the case has nothing
  left to assert.
  **Contract survives; restore with a `config.read`-throws fixture.** Only
  the fixture trigger died, not the contract: a `config` block on a plugin
  *with no* `config.read` is now ignored under R21, but `readPluginConfigs`
  still throws a `PluginLoadError` when a plugin's own `config.read` throws
  on its entry's `config`, and that still propagates through the full
  `loadConfig` pipeline as a thrown error, after provider and dispatcher
  validation already ran. Restore this case with a plugin whose
  `config.read` throws, not a reader-less plugin.

- **File / case:** `packages/dreamux/tests/doctor-plugins.test.ts` —
  `runDreamuxDoctor plugin wiring > a load-phase PluginLoadError pushes two
  rows (config, then plugin <name>) and the run continues`.
  **Contract pinned:** a `PluginLoadError` thrown during `readPluginConfigs`
  (a `config` block on `builtin:bootstrap`, which has no `config.read`)
  produces two `dreamux doctor` rows — a failed `config` row and a failed
  `plugin bootstrap` row — and the rest of doctor's checks still run.
  **Failure:** same R21 policy change removes the `PluginLoadError` this
  case's fixture relied on to reach `runDreamuxDoctor`'s two-row error path,
  so the doctor run no longer produces those rows.
  **Contract survives; restore with a `config.read`-throws fixture.** Only
  the fixture trigger died, not the contract: `builtin:bootstrap` has no
  `config.read`, so a `config` block on it is now ignored under R21 instead
  of throwing, but a `PluginLoadError` thrown during `readPluginConfigs` (a
  plugin's own `config.read` throwing on its entry's `config`) still
  produces the same two `dreamux doctor` rows — a failed `config` row and a
  failed `plugin <name>` row — and the rest of doctor's checks still run.
  Restore this case with a plugin whose `config.read` throws.

- **File / case:** `packages/channel/feishu-channel/tests/feishu-extensions.test.ts` —
  `it.each(['approve_pairing', 'ask_user_pick'])('rejects card action key %s
  when it is built in', ...)`.
  **Contract pinned:** registering a card action key equal to a built-in
  action's key throws, naming the conflict.
  **Failure:** R35 changes `FeishuExtensionAction.handle`'s return type from
  `Promise<FeishuCardActionResponse | Record<string, never>>` to
  `Promise<FeishuExtensionActionResult>` (a `{ response, forward? }`
  envelope); the fixture's `handle: async () => ({})` no longer satisfies the
  type.

- **File / case:** `packages/channel/feishu-channel/tests/feishu-extensions.test.ts` —
  `it('rejects a card action key another extension claimed, naming both', ...)`.
  **Contract pinned:** a second extension registering a card action key
  another extension already claimed throws, naming both extensions.
  **Failure:** same R35 return-type change; the fixture's two
  `handle: async () => ({})` handlers no longer type-check.

- **File / case:** `packages/channel/feishu-channel/tests/feishu-extensions.test.ts` —
  `it('rejects an extension with an empty name', ...)`.
  **Contract pinned:** `register()` throws
  `'A Feishu extension name must not be empty'` for `name: ''`.
  **Failure:** C9 widens the check to blank (trimmed) names and reworded the
  message to `'A Feishu extension name must not be blank'`; the case's
  literal message assertion no longer matches.

- **File / case:** `packages/channel/feishu-channel/tests/feishu-extensions.test.ts` —
  `it('rejects a card action with an empty key', ...)`.
  **Contract pinned:** a card action with `key: ''` throws
  `'...has a card action with an empty key'`.
  **Failure:** C9 reworded the message to name the extension and the action's
  index instead of the (blank) key, plus the same R35 `handle` return-type
  change on the fixture — both a compile error and a message mismatch.

- **File / case:** `packages/channel/feishu-channel/tests/feishu-extensions.test.ts` —
  `it('rejects a second card action in the same extension repeating an
  earlier key', ...)`.
  **Contract pinned:** a duplicate card action key within one extension
  throws, naming "another card action of the same extension".
  **Failure:** same R35 return-type change; both `handle: async () => ({})`
  fixtures no longer type-check.

- **File / case:** `packages/channel/feishu-channel/tests/feishu-extensions.test.ts` —
  `it('dispatches a card action by its dreamux_action key to the instance
  state', ...)`.
  **Contract pinned:** a card click whose `dreamux_action` matches a
  registered key invokes that extension's handler with the initialized
  instance's state.
  **Failure:** same R35 return-type change; the fixture's `handle` returned a
  bare `{}` instead of a `{ response, forward? }` envelope.

- **File / case:** `packages/channel/feishu-channel/tests/feishu-extensions.test.ts` —
  `it('fences the instance api once the instance began closing', ...)`.
  **Contract pinned:** after an instance begins closing, its instance api's
  `editCard`/`readMessageRoute`/`bindTeam`/`sendCard`/`submitToTeam` all
  reject or return an aborted outcome.
  **Failure:** R35 removes `submitToTeam` from `FeishuInstanceApi` entirely
  (Feishu resolves and delivers the forward itself instead of an extension
  calling a submit capability), and R36 removes `sendCard`'s `mode` field;
  the case called both.

- **File / case:** `packages/channel/feishu-channel/tests/feishu-extensions.test.ts` —
  `it('sendCard delivers to the fake bot and returns a target from the
  read-back, not the input chat id', ...)`.
  **Contract pinned:** the instance api's `sendCard` delivers the card and
  returns the read-back target rather than the input `chatId`.
  **Failure:** R36 removes `sendCard`'s `mode` field; the case called
  `sendCard({ ..., mode: 'background' })`.

- **File / case:** `packages/channel/feishu-channel/tests/feishu-extensions.test.ts` —
  `it('submitToTeam answers a TEAM_NOT_FOUND rejection directly and never
  falls back to the Dispatcher', ...)`.
  **Contract pinned:** `submitToTeam`, on Core's `TEAM_NOT_FOUND`, returns
  `{ status: 'rejected', code: 'TEAM_NOT_FOUND', ... }` without falling back
  to the Dispatcher.
  **Failure:** R35 removes `submitToTeam` from `FeishuInstanceApi`
  entirely — a card action now states what to forward and Feishu delivers it
  through the existing ask-user settlement path, so there is no longer a
  submit capability on the instance api to test.
  **Superseded by R35; do not resurrect as written.** The pinned "never falls
  back to the Dispatcher" half is not a surviving contract — R35 deliberately
  reverses it: `deliverToCardOwner` (the mechanism that replaced
  `submitToTeam`) routes a forward to whichever Team *or Dispatcher* owns the
  conversation, Dispatcher fallback included. Only the `TEAM_NOT_FOUND` ->
  `rejected` mapping itself might still be worth covering under the new
  delivery path. The no-fallback assertion must not be restored.

- **File / case:** `packages/channel/feishu-channel/tests/feishu-extensions.test.ts` —
  `it('describes every registered extension with its tools, their caller
  kinds, and its card actions', ...)`.
  **Contract pinned:** the provider's diagnostic detail text lists every
  registered extension's tools with their caller kinds and its card action
  keys.
  **Failure:** same R35 return-type change; the fixture's card action
  `{ key: 'alpha_ack', handle: async () => ({}) }` no longer type-checks.

## PR-0 (review round)

- **HIGH-RISK, restore first.** **File / case:** `packages/dreamux/tests/package-boundary-guards.test.ts` —
  `it('feishu-channel index.ts exports exactly the pinned name set', ...)`.
  While the later Feishu directory restructure runs, this was the only guard
  on the package's export surface.
  **Contract pinned:** `packages/channel/feishu-channel/src/index.ts` exports
  exactly one fixed, alphabetically sorted set of named bindings and types —
  a regression catcher (epic #209) so an accidental new export (including a
  resurrected Core-owned binding) is visible in review rather than shipping
  silently.
  **Failure:** this review round exports `FeishuExtensionActionResult` and
  `FeishuExtensionForward` from `index.ts` (review item 4 of PR #454 —
  `packages/channel/feishu-channel/src/extension.ts`'s card-action-handler
  return contract, previously reachable only via
  `Awaited<ReturnType<...>>`), which is a deliberate, reviewer-directed
  surface expansion. The pinned array no longer matches the file's actual
  named exports, and the two added names belong in it (alphabetically,
  between `FeishuExtensionAction`/`FeishuExtensionContext` and
  `FeishuExtensionContext`/`FeishuExtensionTool` respectively). Restore this
  case with the two names added to the pinned array.

- **HIGH-RISK, restore first.** **File:** `packages/channel/feishu-channel/tests/feishu-settlement-envelope.test.ts`
  (whole file — every case shares the `handle()` constructor below, and a test
  file with zero suites fails vitest, so there is no partial deletion).
  This file's own header states it is the *only* test keeping the hand-built
  envelope in `feishu-session-ops.ts` in step with the inbound formatter's
  `<channel source="feishu" …>` shape — the model reads that shape to reply
  through the right MCP server, so this is sole coverage of a model-facing
  contract and should be the first thing the final test completion restores.
  **Failure (all 9 cases):** review item 6 of PR #454 makes `sessionHandle`'s
  `extensionAction` field required and drops the
  `?? (() => undefined)` fallback (`packages/channel/feishu-channel/src/feishu-session-ops.ts`).
  The file's shared `handle()` constructor (line 85) built a `SessionHandle`
  without that field. Restore this suite with `extensionAction: () => undefined`
  added to `handle()`.
  - `it('sends the explanation above the questions', ...)`.
    **Contract pinned:** an ask-user card's body places the model's explanation
    text above the question/option elements.
    **Failure:** `handle()` no longer type-checks (missing required
    `extensionAction`); this case never calls `handleCardAction`, so `rush test`
    still passed — only `rush typecheck:tests` catches it.
  - `it('replies to the message the model named, seen before or not', ...)`.
    **Contract pinned:** `askUserQuestion` sends its card as a reply to an
    explicit `messageId`, even one the session never observed.
    **Failure:** same as above — typecheck-only.
  - `it('creates a new message when the model named none', ...)`.
    **Contract pinned:** `askUserQuestion` with no `messageId` opens a new
    message in a topic group, rather than replying to anything.
    **Failure:** same as above — typecheck-only.
  - `it('carries source="feishu" and the card the answer came from', ...)`.
    **Contract pinned:** an answer's delivered submission targets the topic
    Feishu reports the card sitting in, carries `attrs` with `source: 'feishu'`,
    `chat_id`, `thread_id`, `message_id`, `sender_id`, and
    `ask_user_request_id`, an `anchor` matching that target, and the standing
    `CHANNEL_REMINDER` text.
    **Failure:** this case's `clickThrough` reaches `handleCardAction`, which
    calls `h.extensionAction(key)` unconditionally (line 556) — with the field
    missing, this throws `TypeError: h.extensionAction is not a function` at
    runtime, so `rush test` itself fails, not just typecheck.
  - `it('routes a dismissal from its card too', ...)`.
    **Contract pinned:** a card dismissal delivers a submission to the same
    topic and anchor as an answer, with text containing "dismissed".
    **Failure:** same runtime `TypeError` via `clickThrough` →
    `handleCardAction` — fails `rush test`, not just typecheck.
  - `it('keeps a follow-up question in the topic its answer came from', ...)`.
    **Contract pinned:** across two rounds, each new question replies to the
    message id the prior round's answer carried, and each answer lands in the
    same topic the first card did.
    **Failure:** same runtime `TypeError` via `clickThrough` (called twice) —
    fails `rush test`, not just typecheck.
  - `it('delivers an ordinary group card to the group, and repaints it', ...)`.
    **Contract pinned:** an expiry settlement for a group (non-topic) card
    delivers to the chat with no `containerChatId`, carries `chat_id`/
    `message_id` and no `thread_id`, and repaints the card via `editCard`.
    **Failure:** this case calls `expireAskUserQuestion`, not
    `handleCardAction`, so it never reaches `extensionAction` at runtime —
    typecheck-only failure, same as the first three cases.
  - `it.each([...])('delivers nowhere at all when %s', ...)` (2 cases: lookup
    fails; lookup reports no items).
    **Contract pinned:** an expiry settlement whose card lookup fails or comes
    back empty delivers no submission anywhere (never guessed, never routed to
    the Dispatcher Agent), while the card repaint still happens independently.
    **Failure:** same as the group-card case — `expireAskUserQuestion` only,
    typecheck-only failure.

  **PR #455 review round correction — the restoration coordinates above are
  stale.** `feishu-session-ops.ts` no longer exists: Stage 8b ("Plan Stage 8b
  Feishu: session/inbound/outbound split, R37/R38/R41") folded it into
  `session/session.ts` and split card-click answering into a new
  `session/card-actions.ts` collaborator. The free-function `SessionHandle`
  bag this suite's `handle()` built, and its `extensionAction` field, have no
  successor at all — `handleCardAction` is now `FeishuCardActions.handle()`
  (constructed from `FeishuCardActionsOptions`, `session/card-actions.ts`),
  and `expireAskUserQuestion` is a private `session/session.ts` method that
  delegates to the same class's `deliverAskUserSettlement`, so both the
  click-answer and expiry cases resolve to one envelope builder there (attrs
  `sender_id`/`ask_user_request_id`, `CHANNEL_REMINDER` from
  `feishu-submit.ts`). The card's own construction — the "explanation above
  questions" and reply-vs-new-message cases — is
  `tools/ask-user-question.ts`'s `askUserQuestionDef.handle`, not this file's
  `handle()` at all. `tools/messaging-tools.ts` is not the envelope's home
  either — its `<channel source="feishu">` text is unrelated documentation on
  the `reply`/`react`/`list_chat_bots` tool inputs. Restoring this suite means
  constructing `FeishuCardActions` (for card-click cases) and exercising
  `askUserQuestionDef.handle` (for card-creation cases), not adding a field to
  a `handle()`/`SessionHandle` helper that no longer exists.

## Stage 1

- **File / case:** `packages/dreamux/tests/no-sync-io-gate.test.ts` —
  `it('flags source files over 700 physical lines', ...)`.
  **Contract pinned:** the shared `max-lines` rule fires as a hard error on a
  `src/**` file over 700 physical lines.
  **Failure:** R1 (code-only line counting) flips `max-lines`'s options to
  `{ skipBlankLines: true, skipComments: true }`
  (`packages/eslint-config/index.js`). The fixture is 701 lines built entirely
  of `// line N` comments, so it now lints to zero counted code lines and
  `max-lines` never fires; the `toContain('max-lines')` assertion fails.
  **Contract survives; restore with a fixture built from 701 non-comment,
  non-blank lines** (e.g. `` `export const line${i} = ${i};` `` repeated 701
  times). Split the pinned fact in two: the *counting mode* the case's name
  and fixture assumed ("physical" lines) was changed knowingly by R1 and does
  not come back; the *"fires as a hard error above the cap"* half of the
  contract holds unchanged — only this fixture's shape (all-comment lines)
  stopped exercising it, so replacing the fixture with 701 code lines is
  sufficient, no other change is owed.

- **File:** `packages/dreamux-types/tests/no-host-types.test.ts` (whole file).
  **Contract pinned:** no `dreamux-types/src/*.ts` file references the
  `@types/node` ambient globals `NodeJS`/`Buffer` as whole tokens.
  **Failure:** H11 sets `"types": []` in
  `packages/dreamux-types/tsconfig.json`'s `compilerOptions`, which removes
  every `@types/node` ambient global (not just `NodeJS`/`Buffer`) from the
  package's compilation. The fact this file scanned for is now a compiler
  error instead of a regex match — `NodeJS`/`Buffer` are no longer resolvable
  identifiers in `src/` at all.
  **Superseded by compiler (H11); do not restore as written.** The contract
  is enforced permanently by `"types": []`, not by a gap this refactor is
  deferring.

- **File:** `packages/dreamux-types/tests/root-export-surface.test.ts` (whole
  file, three describe blocks).
  **Contract pinned:** (1) the root export list is non-trivially populated
  (parse-regression sanity guard); (2) every `export interface`/`export type`
  declared across `src/*.ts` is reachable from `index.ts`'s root barrel; (3)
  the deleted inbound-turn shapes (`InboundAttachment`, `InboundTurnInput`,
  `turn.ts`) stay gone from both source and the root barrel.
  **Failure:** H11 rewrites `src/index.ts` from per-name
  `export type { A, B, C } from './module.js'` blocks to one
  `export type * from './module.js'` line per module, so this file's own
  `rootReExportedNames()` helper (which parses `export type { ... } from`
  brace blocks) finds zero names and every assertion in (1) and (2) fails
  immediately.
  **Contracts (1) and (2) superseded by compiler (H11); do not restore as
  written.** `export type * from './module.js'` makes "every declared type is
  reachable from the root" true by TypeScript construction (verified this
  stage with the TS checker's `getExportsOfModule` against `index.ts`: the
  resolved 123-name export set is byte-identical before and after the
  rewrite), not by a hand-written regex walk — there is no gap to fill later.
  **Contract (3) does not have a compiler-shaped replacement (it is a
  never-comes-back absence check, not a reachability fact) and survives —
  restoration owed at the final test completion on #453, not before.**
  `deleted-surfaces-absence.test.ts` already does this exact job (a src-wide
  token-absence scan) for other retired names, so the restoration recipe is:
  add `InboundAttachment` and `InboundTurnInput` to that file's existing
  `BANNED_TOKENS` list. Both tokens have zero hits in current `src/` (verified
  this stage — the same two lines were added and passed before being reverted
  under R43, which permits no assertion edit in this refactor, restoration
  included).

- **File / case:** `packages/dreamux/tests/package-boundary-guards.test.ts` —
  `` it("dreamux-types index.ts exports exactly the pinned name set (the
  neutral contract's full public surface)") ``.
  **Contract pinned:** `packages/dreamux-types/src/index.ts` exports exactly
  one fixed, alphabetically sorted set of 123 named types — a regression
  catcher so an accidental new or dropped root export is visible in review.
  **Failure:** not itself named by H11, but breaks as a direct consequence of
  the `index.ts` rewrite above: this case's `namedExports()` helper
  regex-matches `export\s+(?:type\s+)?\{...\}` brace blocks, and a bare
  `export type * from` line has no braces, so the function returns `[]` for
  `dreamux-types/src/index.ts` and the exact-set comparison fails
  unconditionally.
  **Superseded by compiler (H11); do not restore as written.** The fact this
  case pinned (today's exact 123-name set, unchanged) is now enforced by the
  type system itself via `export type *`'s reachability guarantee, verified
  this stage with the TS checker as noted above — the sibling
  `dreamux-utils`/`agent-runtime-codex`/`agent-runtime-claude-code`/
  `feishu-transport` cases in the same describe block are untouched, since
  only `dreamux-types`'s barrel shape changed.

## Stage 2a — Item 1

`dreamux-types` shared context required-ness + R30 (`injectEnv`/`HOST_INJECT_ENV`
deletion). Two independent drivers produced test collateral this item;
a third candidate driver (`DreamuxLogger.child` made required) is
**deliberately not acted on** — see the note at the end of this section.

### Driver A — R30: `injectEnv` deleted from `AgentActivityReadContext`

`packages/dreamux-types/src/agent-runtime.ts`'s `AgentActivityReadContext.injectEnv?`
is deleted outright (not required, gone), and `effectiveEnvironment()` in both
provider packages' `activity/reader.ts` no longer merges it. Production is
unaffected (Core always injected `{}`), but both providers' activity-read test
suites used `injectEnv` as their ONLY channel for pointing the reader at a
fixture's temp `CODEX_HOME`/`CLAUDE_CONFIG_DIR` instead of the real one — a
real, working test-only use of the neutral seam that R31 replaces with a
different mechanism (`config.extra_env`), not the deleted seam.

- **File:** `packages/agent-runtime/codex/tests/codex-activity-read.test.ts`
  (whole file, 15 cases) + `packages/agent-runtime/codex/tests/helpers/codex-activity-fixtures.ts`
  (orphaned helper, deleted alongside — zero other importers).
  **Contract pinned:** `readRecentActivity` behavioral coverage — actively-growing
  session reads, chronological ordering, stable cursor pagination without
  skip/duplicate, `includeTools` default + group-only hiding, and the neutral
  error taxonomy (`session_unavailable`/`activity_corrupt`/`provider_failure`/
  `cursor_invalid`), all against REAL rollout files under a temp `CODEX_HOME`.
  **Failure:** the shared `readContext()` helper (used by every case) returns
  an object literal with `injectEnv: session.env` against the
  `AgentActivityReadContext` return type — an excess-property compile error
  (`tsc -p tsconfig.tests.json`). Empirically confirmed at runtime too: with
  `injectEnv` merging removed from `effectiveEnvironment()`, 14 of 15 cases
  fail (the reader resolves the real ambient `CODEX_HOME`, not the fixture's);
  the 15th passes only vacuously (asserts `session_unavailable` for a
  never-existed session id, true under any `CODEX_HOME`).
  **Contract still holds; restore in the final PR.** Nothing about
  `readRecentActivity`'s behavior changed — only the fixture's env-injection
  channel. Restoration recipe: rebuild `readContext()` to set
  `config.extra_env` (`{ CODEX_HOME: session.env['CODEX_HOME'], HOME: session.env['HOME'] }`)
  instead of `injectEnv`, matching R31's "the native home is resolved per
  Agent from its effective spawn env (`process.env` plus that agent's
  `extra_env`)".

- **File:** `packages/agent-runtime/claude-code/tests/activity-reader.test.ts`
  (whole file, 11 cases).
  **Contract pinned:** `readClaudeRecentActivity` behavioral coverage — an
  actively growing session paginates with a stable cursor; a closed session
  (writer gone) reads identically; tools hidden as a GROUP by `includeTools`;
  neutral typed errors with no native path/session-layout leakage; no tool
  argument/result content or native filesystem path crosses into a returned
  `AgentActivityRecord`.
  **Failure:** same shape — the shared `makeFixture()` helper's `context`
  literal sets `injectEnv: { CLAUDE_CONFIG_DIR: configDir }` against
  `AgentActivityReadContext`, an excess-property compile error. Empirically 7
  of 11 cases fail at runtime once the merge is removed (the other 4 pass
  vacuously — limit validation and not-found cases that never depend on
  `CLAUDE_CONFIG_DIR` resolving to the fixture).
  **Contract still holds; restore in the final PR.** Restoration recipe:
  rebuild `makeFixture()`'s `context` to set
  `config.extra_env: { CLAUDE_CONFIG_DIR: configDir }` instead of `injectEnv`
  (claude-code's own env-merge in `runtime-session.ts`/`activity/reader.ts`
  already reduces to `{ ...process.env, ...extraEnv }`, so `extra_env` is the
  live channel post-R30, same as codex).

### Driver B — `AgentRuntimeCreateContext`/`ChannelSessionCreateContext` required-ness (`activity`, `logger`, `state_root`, `cache_root`)

Foreseen by this item's own plan ("grep test fixtures... for object literals
that omit `activity`/`logger`/`state_root`/`cache_root`"). Every case below
builds one of these context types by hand with a field that is now required
and was simply never supplied — production behavior does not change (Core
already always supplied these), so the contract survives unconditionally and
restoration is "add the omitted field(s) back" in every case, not a design
question.

- **File / case:** `packages/agent-runtime/codex/tests/codex-runtime.test.ts` —
  `describe('MCP server list passthrough encoding') > it('renders exactly the
  Core-supplied MCP server list, unmutated, into the launched extra args')`
  (whole `describe`, one case).
  **Contract pinned:** the Codex provider renders Core's MCP server list into
  `--mcp-config`/extra args byte-for-byte via the pure encoder, never
  discovering, appending, or mutating servers.
  **Failure:** the case's inline `context` literal omits `activity`/`logger`.
  **Restore in the final PR** with `activity: () => undefined` and a
  no-op/capturing `logger` added to the literal; the now-unused
  `codexRuntimeArgsForMcpServers`/`AgentRuntimeMcpServer` imports this item
  removed from the file go back with it.

- **File / case:** `packages/agent-runtime/claude-code/tests/session.test.ts` —
  `` it.each(['exit', 'stop'])('preserves %s intent while recovery admission
  awaits durable identity publication') `` (2 sub-cases).
  **Contract pinned:** an exit/stop racing a recovery admission that is
  waiting on durable identity publication resolves the admission correctly
  (failed/stopped) and reports the right `nativeEnds` sequence, without losing
  the in-flight publish.
  **Failure:** this case's inline `provider.createRuntime({...})` context
  omits `logger` (the file's other 5 cases construct a lower-level
  `ClaudeCodeSession` directly and never reach `AgentRuntimeCreateContext`, so
  they are unaffected — this is per-case, not whole-file, collateral).
  **Restore in the final PR** by adding a `logger` field to the literal.

- **File:** `packages/agent-runtime/claude-code/tests/runtime.test.ts` (whole
  file, 34 tests).
  **Contract pinned:** `ClaudeCodeRuntime` lifecycle against a fake
  resident-session factory — system-prompt append-only mapping (fresh/resumed/
  resume-fallback), `start()` continuity reporting and the
  durable-publish-before-resolve fence, the state sink's call-receipt
  ordering and lease-revocation error shape, `stop()` fencing and converging a
  racing start, submit/settlement across every outcome, `outputSchema` bound
  once at create time, and the exact Core-supplied MCP server list reaching
  `--mcp-config` unmutated.
  **Failure:** every case constructs its runtime through the file's shared
  `Harness.createRuntime()`, which calls `this.context()` — that method's own
  return statement (typed `AgentRuntimeCreateContext<...>`) omits `logger`, a
  compile error at the helper's definition. All 34 cases route through it (no
  case survives independently).
  **Restore in the final PR** by adding a `logger` field (a capturing/no-op
  `DreamuxLogger`) to `Harness.context()`'s returned object.

- **File:** `packages/agent-runtime/claude-code/tests/runtime-background.test.ts`
  (whole file, 27 tests).
  **Contract pinned:** resident background-turn and submitted-command
  behavior replayed through the real RPC/provider (no live Claude child) —
  background text/tool/compaction/end activity publication, admission ordering
  against a background child exit, and reap-on-timeout behavior.
  **Failure:** every case calls the file's shared `harness()` helper, whose
  inline `provider.createRuntime({...})` call omits `logger` — a compile
  error inside the shared helper itself, reached by all 27 tests.
  **Restore in the final PR** by adding a `logger` field to `harness()`'s
  context object.

- **File / case:** `packages/dreamux/tests/codex-live.test.ts` —
  `` describe('codex live integration') > it(`spawns codex ${version},
  completes init handshake, starts a thread`) `` (the file's one behavioral
  case; ~660 lines).
  **THIS IS THE STANDING HIGH-RISK ENTRY (issue #63 non-blocking-inbound live
  gate) — see the top of this file. No exception was taken; it is deleted and
  logged like any other case.**
  **Contract pinned (read from the deleted body before removal):** a real
  `codex` app-server spawn completes the init handshake without a business RPC
  racing it; reasoning-effort settings reach native turn contexts; `thread/start`
  persists a resumable rollout; a resident session's activity read reflects a
  rollout file mid-write; the display line reports live turn status; a second
  `submit()` accepted while a turn is running FOLDS into that same running
  turn rather than queuing or blocking (the core issue #63 non-blocking-inbound
  proof); the real Feishu MCP surface (reply/react/list_chat_bots) is reachable
  from a live turn; and no automatic reaction is added on inbound, submission,
  or settlement (the issue #63 tri-state reaction surface stays a deleted
  surface, asserted as an explicit negative).
  **Failure:** the hand-built `AgentRuntimeCreateContext`/`AgentActivityReadContext`
  fixtures (6 construction sites across the case) predate `activity`/`logger`
  becoming required and omit them; the file's own docstring already frames
  itself as "a from-scratch rebuild, not a port" against the current
  provider-seam contracts, so this is the same class of collateral as every
  other case in this section, just concentrated in one very large case.
  **Contract still holds; restore in the final PR — this is the priority
  restoration in this stage.** The surrounding shell (version detection,
  `classifyDetection`/`versionAtLeast` unit coverage, the fail-loud "codex on
  PATH" guard, the `DREAMUX_SKIP_LIVE_CODEX`/`DREAMUX_RUN_LIVE_MODEL_GATE`
  escape hatches) is kept in the trimmed file; only the behavioral body and
  its now-dead supporting helpers (`RecordingCodexWsClient`, `fakeInbound`,
  `liveConfig`, `createIsolatedCodexHome`, `waitFor`, and others) were removed,
  along with two now-orphaned test helpers with zero other importers:
  `packages/dreamux/tests/helpers/live-catalogs.ts` and
  `packages/dreamux/tests/helpers/fake-feishu-bot.ts`.

- **File / case:** `packages/dreamux-types/tests/channel-provider-contract.test.ts` —
  `describe('ChannelProvider composes optional capabilities rather than fake
  methods') > it('a bare provider that implements only createSession is a
  valid ChannelProvider')`.
  **Contract pinned:** a `ChannelProvider` implementing only `createSession`
  is valid; `config`/`mcp` read `undefined`.
  **Failure:** the inline `createSession({...})` call argument omits
  `logger`/`state_root`/`cache_root` (`ChannelSessionCreateContext` required-ness,
  this item). The sibling case in the same `describe` (type-level `keyof`
  assertion, no `createSession` call) is unaffected.
  **Restore in the final PR** by adding the three fields to the call argument.

### Driver C — NOT executed: `DreamuxLogger.child` required-ness

This item's own text made `DreamuxLogger.child?` required on the stated
premise "every constructed logger already provides `.child`". That premise is
false: 2 of the 3 production `DreamuxLogger` literals this item's own source
changes touched (`agent-runtime/claude-code/src/logger.ts`'s
`consoleFallbackLogger`, and the now-deleted
`feishu-channel/src/provider.ts` fallback) did not provide `.child` before
this change; a `child()` had to be added to the claude-code one to keep
`agent-runtime-claude-code` building (see that file — noted there as a
knowing, temporary addition tied to item 7's later removal of the fallback
itself, not a gap). Every test-only `DreamuxLogger` stub found this session
also omits `.child` — none of these ~290 cases fail at runtime (nothing on
their paths ever calls `.child`); the failure is compile-only
(`typecheck:tests`).

Per root `CLAUDE.md` ("Change anything — knowingly... name what you are
changing, why its original rationale no longer holds"), deleting this much
collateral on a disproven premise without confirmation is the "unknowing
change" the rule prohibits. **No file below was deleted or edited for this
driver.** Left exactly as before this item, still failing
`typecheck:tests` only:

- `packages/dreamux/tests/channel-service.test.ts` — `describe('ChannelService')`
  (4 of 12 cases route through the module-level `silentLogger()` helper, which
  fails at its own definition).
- `packages/dreamux/tests/commands.test.ts` — 2 of 6 cases (`createChannelListServer()`
  fixture).
- `packages/dreamux/tests/helpers/event-harness.ts` — `createCapturingLogger()`
  fails at its own definition; imported by
  `packages/dreamux/tests/cot-projection-privacy.test.ts` (all 26 cases route
  through the file's `harness()`) and `packages/dreamux/tests/core-event-catalog.test.ts`
  (19 of 35 cases, across the `DispatcherCoreEventBus` best-effort-delivery and
  subscription-lifecycle `describe` blocks, one `teammate.state` case, and the
  whole `display fact correlation` `describe` block).
- `packages/dreamux/tests/input-source-lifecycle.test.ts` — all 7 cases (shared
  `buildHarness()`).
- `packages/dreamux/tests/removed-surfaces.test.ts` — 1 of the file's cases
  (`AgentIdentityStore.read() fails loud with LegacyStateError on a persisted
  "session_ref" field`; describe-scoped `noopLog`).
- `packages/dreamux/tests/teammate-completion-lifecycle.test.ts` — all 8 cases
  (module-level `silentLogger`, `as DreamuxLogger` cast, reached via
  `LifecycleHost`/`createHost()`).
- `packages/channel/feishu-channel/tests/feishu-channel-session.test.ts`,
  `feishu-cot-delivery.test.ts`, `feishu-cot.test.ts`,
  `feishu-document-comments.test.ts`, `feishu-document-tools.test.ts`,
  `feishu-extensions.test.ts` (2 sites), `feishu-provisioning.test.ts`,
  `feishu-reply-tool.test.ts`, `feishu-routing-tools.test.ts`,
  `feishu-slash-commands.test.ts`, `feishu-space-policy.test.ts`,
  `feishu-space-tools.test.ts`, `feishu-target-router.test.ts` — each has its
  own module- or file-scoped stub `DreamuxLogger`/session-builder missing
  `.child`; blast radius not individually mapped case-by-case pending the
  decision below.

**Decision needed before the next item touches any of these files:** either
(i) confirm deleting this collateral per R43 (the mechanical outcome, ~290
cases across ~20 files), or (ii) revert `DreamuxLogger.child` to optional
(`child?(bindings): DreamuxLogger`) — the three production `.child(...)` call
sites this item simplified (`teammate-service/runtime-owner.ts`,
`plugin/host.ts`, `feishu-channel/src/feishu-extensions.ts`) go back to
`log.child?.(...) ?? log`, and the `child()` added to claude-code's
`consoleFallbackLogger` comes back out — zero test collateral either way.

**Correction (Stage 2a Item 2, found while isolating unrelated collateral):**
the claim above that "none of these ~290 cases fail at runtime... the failure
is compile-only" is false for at least one file. `runtime-owner.ts:360`
(`TeammateRuntimeOwner.resolveLaunch`) calls
`this.deps.log.child({...})` unconditionally to build the context logger every
Agent Runtime `createRuntime()` call receives — this executes on every real
runtime start, not just under `typecheck:tests`. Empirically verified by
toggling only that one call site: with `packages/dreamux/tests/teammate-completion-lifecycle.test.ts`'s
module-level `silentLogger` (no `.child`) and `.child` required with no
fallback, all 8 cases fail at runtime — `TypeError` inside `resolveLaunch`,
thrown before `provider.createRuntime()` is ever reached, surfacing to the
test only as its `runtimeAt()` helper's `vi.waitFor` timing out
(`provider.runtimes.length` never grows). Restoring the local
`log.child?.({...}) ?? this.deps.log` fallback at that one call site alone
(nothing else changed) made all 8 cases pass again. This does not change
decision (i)/(ii) above, but it means option (i) is not "delete ~290
compile-only cases" — some real number of those 290 are live runtime crash
sites for any caller whose logger lacks `.child` (test stub or otherwise),
so the two production fallback loggers this item already found missing
`.child` (claude-code's `consoleFallbackLogger`, feishu-channel's now-deleted
provider fallback) were not a coincidence; a full inventory of which of the
three simplified production call sites (`runtime-owner.ts`, `plugin/host.ts`,
`feishu-channel/src/feishu-extensions.ts`) are reachable with a
non-`.child`-bearing logger is still owed before (i) can be taken safely.

**Correction (found during Item 12's verification pass — `packages/dreamux/tests/codex-live.test.ts`
is currently red, not this item's doing, not fixed here):** this item's trim
of the file (see the entry above under "Restore in the final PR") kept a
`describe('codex live integration')` block whose only two branches register a
test conditionally: `it.skip(...)` when `DREAMUX_SKIP_LIVE_CODEX=1`, or
`it('requires codex on PATH', ...)` when `codex` is not detected. Neither
branch fires when `codex` **is** on `PATH` and the skip env var is unset — the
normal case on a workstation with Codex installed — so the `describe` block
registers zero tests. Reproduced here: `codex-cli 0.156.1` on `PATH`,
`DREAMUX_SKIP_LIVE_CODEX` unset, `vitest run` reports `Error: No test found in
suite codex live integration` and fails the file. The sibling `describe('codex
detection logic')` block (3 cases: `classifyDetection`/`versionAtLeast` unit
coverage) is unaffected and still passes on its own. This is a structural gap
in this item's trim, not a contract this item's own source change invalidated
— left as this item's open item rather than folded into Item 12 (a different
item, R47, touches unrelated files) or silently patched, per the ledger's
per-item attribution. The file is the standing high-risk entry at the top of
this ledger; R43 gives it no exception once it is observed failing. Two
R43-compliant fixes, either of which restores a green suite: delete only the
empty `describe('codex live integration')` block (the 3 detection-logic cases
survive); or delete the whole file. This correction does not choose between
them — that call, and the fix, belongs to whoever next touches this item or
the final test completion on PR #453, consistent with "The final test
completion on PR #453 must restore it with focused coverage of the
immediate-submit path, whether or not it was deleted" at the top of this
file.

## Stage 2a — Item 2

`service/team-collection`, `service/team-service`, `service/teammate-collection`,
`service/teammate-service`, `service/dispatcher-core-events` required-ness:
`TeamCollectionOptions.admitOperation/coreEvents/workflowLog`,
`TeammateCollectionOptions.conversationProjection`,
`TeamServiceDeps.conversationProjection/coreEvents`,
`TeammateServiceDeps.conversationProjection`,
`DispatcherCoreEventPublisher.hasSources`. All fixture/cast collateral below
was found first by `tsc -p tsconfig.tests.json` (a plain object literal
missing a newly-required field), and second — for casts (`as unknown as
TeamServiceDeps`/`TeammateCollectionOptions`) that bypass that check — by
running the real suite (`vitest run`) and tracing each runtime failure back to
its omitted field. See the note below for how that second pass was isolated
from Item 1's own, unrelated `DreamuxLogger.child` collateral sitting in the
same working tree.

**Contract pinned everywhere in this section is the same one:** each flipped
field was already supplied at every real production construction site (traced
per field before flipping); no field's required-ness changed a production
default. Every case below fails only because a **test fixture** stopped
supplying a value production always supplied for real. **Contract still
holds; restore in the final PR** by adding the now-required field(s) back to
the fixture/cast, unless a case's own note below says otherwise.

- **File:** `packages/dreamux/tests/admission-ledger.test.ts` (15 of 25 cases;
  546 lines deleted). **Contract pinned:** `TeammateService.submitInput` /
  `submitAdmitted` / `prepareCompletion` admission-ledger interaction, driven
  through a hand-built `TeammateCollection`. **Failure:** the file's
  `buildTeammateHarness()` constructs `new TeammateCollection({...})` without
  `conversationProjection`, a plain-literal excess-property/missing-property
  compile error. **Kept:** the 10 pure `AdmissionLedger` unit cases, which
  build no `TeammateCollection` at all.

- **File:** `packages/dreamux/tests/completion-delivery.test.ts` (3 cases; the
  `'the real conversation projection presents a dispatcher completion delivery
  (failure-ledger #13)'` describe, plus its now-orphaned `RecordingPublisher`
  class, `realProjection()`, and `fakeIdentity()` helpers). **Contract
  pinned:** a real `createConversationProjection` output, driven by a real
  `DispatcherCoreEventBus`-shaped publisher, presents a dispatcher's own
  completion the same way a Team's does. **Failure:** `RecordingPublisher`
  implements `DispatcherCoreEventPublisher` by hand and never defined
  `hasSources`, now a compile error at the class declaration.

- **File:** `packages/dreamux/tests/failure-classification.test.ts` (3 cases;
  the `'closing an already-closed TeamMate is the operation succeeding'`
  describe). **Contract pinned:** closing an already-closed TeamMate is a
  no-op success, not an error. **Failure:** the describe's local `collection()`
  helper builds `new TeammateCollection({...})` without `conversationProjection`.

- **File:** `packages/dreamux/tests/helpers/team-harness.ts` (helper file, not
  a test file — R43's "a shared helper stops compiling, delete the helper and
  every case that reaches it"). Deleted `buildTeamCollectionHarness()`,
  `buildRestartedTeamCollection()`, `TeamCollectionHarness` interface,
  `harnessLog()`, `mockLeaderSubmission()`, `mockLeaderSubmissionRejected()`,
  `LeaderSubmissionGate`. **Failure:** `buildTeamCollectionHarness()`
  constructs `new TeamCollection({...})` without `conversationProjection`/
  `coreEvents`. **Contract pinned (the helper's own, restated once since every
  case below shares it):** one isolated, file-backed `TeamCollection` wired
  the same way `DispatcherService` wires its own, so Team-lifecycle contracts
  (idempotency, record validity, single-flight construction, closed-team
  record-only reads) run against real cooperation between `TeamCollection`/
  `TeamStore`/`TeamService` rather than a mock stack agreeing with itself; the
  one faked seam is the Agent Runtime itself (`mockLeaderSubmission`, since
  starting a real Codex/Claude process is out of a unit suite's scope).
  **Kept:** `minimalTeamRecordInput()` (still used by `team-summary.test.ts`,
  untouched) and the pre-existing, already-unused-before-this-item
  `rmDispatcherState()` (unrelated dead code, out of this item's scope, left
  as found).
  - Every case below that names this helper died at the helper's own
    definition, not at its own call site.

- **File:** `packages/dreamux/tests/team-read-legacy-state.test.ts` (1 of 5
  cases: `'raises a legacy leader record through list, history, and status'`).
  **Reaches:** `buildTeamCollectionHarness`. The other 4 cases use an
  independent `plantLeader()` fake with no `TeamCollection` and survive
  untouched. **Note:** this file is separately, independently named for whole-
  file deletion later in Item 12 (when `service/legacy-state.ts` itself is
  deleted) — restoring this one case only matters if Item 12 has not already
  removed the file by the final PR.

- **File:** `packages/dreamux/tests/team-create-idempotency.test.ts` (whole
  file, 8 cases). **Reaches:** `buildTeamCollectionHarness` /
  `buildRestartedTeamCollection`. **Contract pinned:** Team creation's
  idempotency — same `requestId`+`payloadHash` replays the same record instead
  of creating twice, a name collision advances to the next candidate
  deterministically, and a restarted `TeamCollection` recovers the same
  guarantees from disk.

- **File:** `packages/dreamux/tests/team-leader-identity-persistence.test.ts`
  (whole file, 1 case). **Reaches:** `buildTeamCollectionHarness`. **Contract
  pinned:** a TeamLeader's identity file persists across a `TeamCollection`
  restart with its durable fields intact.

- **File:** `packages/dreamux/tests/teammate-system-prompt.test.ts` (whole
  file, 6 cases). **Reaches:** a shared `harness()` that builds `new
  TeammateCollection({...})` without `conversationProjection`. **Contract
  pinned:** system-prompt composition (base instructions, skill sources,
  plugin-appended draft) for a dispatcher-scoped TeamMate.

- **File:** `packages/dreamux/tests/team-leader-prompt.test.ts` (whole file, 11
  cases). **Reaches:** `launchedLeaderAppend()`, which calls
  `restoreTeamLeaderAgentForTeam({...})` without `conversationProjection` — a
  `TeamServiceDeps`-shaped construction found only by actually running
  `tsc -p tsconfig.tests.json` (not by the initial manual grep pass).
  **Contract pinned:** the TeamLeader's own prompt composition and its
  plugin-instruction append ordering.

- **File:** `packages/dreamux/tests/team-collection-read-path.test.ts` (4
  describes / 8 cases: `'TeamCollection: missing/malformed records'`,
  `'TeamCollection: closed Teams are record-only reads'`,
  `'TeamCollection: canonical live/store projection'`,
  `'TeamCollection: shared create/open construction'`). **Reaches:**
  `buildTeamCollectionHarness`. **Contract pinned:** a Team's read path is
  correct whether the Team is materialized, closed, or only ever seen through
  its record. **Kept:** `'Team-scoped TeamMate workspace borrowing'` (2 cases),
  which calls `resolveSpawnWorkspace` directly with no `TeamCollection`/harness
  dependency at all.

- **File:** `packages/dreamux/tests/team-plugin-hooks.test.ts`. Originally two
  describes: `'beforeTeamLeaderLaunch: lazy TeamLeader materialization after a
  failed dissolve commit'` (1 case, via `bootDissolveTeam()` — a cast, not a
  plain literal) and `'beforeTeamLeaderLaunch: creation-failure cleanup
  adopting a durable leader'` (1 case, via the file's own local
  `buildAbandonCreationHarness()` — also a cast). Four other describes/10
  cases that used `buildTeamCollectionHarness` were removed as this item's
  compile-time collateral (same reach/contract as the
  `team-collection-read-path.test.ts` entry above, just concentrated in this
  file: Team plugin-hook firing on create/dissolve/restart, skill-source
  composition, and idempotent no-refire-on-restart). Of the two cast-based
  describes, `'lazy TeamLeader materialization...'` compiled clean and passed
  at runtime (`bootDissolveTeam`'s cast happens to already supply both
  `conversationProjection` and `coreEvents` — see the `dissolve-harness.ts`
  note below). `'creation-failure cleanup adopting a durable leader'` compiled
  clean but failed at runtime: `buildAbandonCreationHarness()`'s
  `TeamServiceDeps` cast supplies neither `conversationProjection` nor
  `coreEvents`, so `TeamRosterProjection.publish()`'s
  `this.deps.coreEvents.publish(...)` throws `TypeError` reading `publish` of
  `undefined` during `TeamService.createNew`, which the test's own scenario
  (an injected `leaderMcp` failure) sends into `TeamClosing.abandonCreation`'s
  cleanup path — that cleanup's own `leader.close()` throws the same way,
  producing an `AggregateError` instead of the single, specific error the
  case asserts on (`'leaderMcp unavailable on the first call'`). Deleted that
  describe, `buildAbandonCreationHarness`, `abandonCreationInput`, and the
  imports/consts/`roots`+`afterEach` cleanup infra that were reachable only
  from it. File now holds only the one surviving describe.

- **File:** `packages/dreamux/tests/teammate-dissolve-members.test.ts` (1 of 5
  cases: `'a dispatcher-scoped TeammateCollection (teamScope: null) refuses the
  bulk close/stop capability outright'`). **Reaches:** an inline `new
  TeammateCollection({...})` whose other now-required fields are covered by
  per-field `as never` casts that do not cover a wholly-absent
  `conversationProjection` property. **Contract pinned:** a dispatcher-scoped
  (non-Team) `TeammateCollection` refuses the Team-only bulk dissolve
  capability outright, by name. The other 4 cases (`closeMembersForDissolve`
  behavior; the `TeammateOps` surface's own declared shape) build no
  `TeammateCollection` and survive.

- **File:** `packages/dreamux/tests/team-leader-lazy-start.test.ts` (whole
  file, 3 cases). **Reaches:** the file's own `harness()`, whose
  `TeamServiceDeps` cast supplies `conversationProjection` but omits
  `coreEvents` entirely. **Contract pinned:** Team creation starts no runtime;
  a prompt-less creation starts nothing, a creation with a prompt starts the
  leader inside that same first submission (through the ordinary
  `submitToLeader` admitted-input span), and a start failure abandons the
  creation cleanly (closes the record) instead of leaving it `starting`
  forever. **Failure mode:** the two non-error-path cases fail because
  `TeamRosterProjection.publish()`'s `this.deps.coreEvents.publish(...)`
  dereferences `undefined` the first time the newly-created leader's roster
  state is published, producing `AggregateError: Team "alpha" creation failed
  and cleanup did not converge` instead of a clean result; the third
  (start-failure) case fails the same way inside `abandonCreation`'s own
  cleanup, so the test observes the wrong error message (the aggregate,
  not the plain `startError`).

- **File:** `packages/dreamux/tests/team-dissolve-contract.test.ts`. **Reaches:**
  `bootDissolveTeam()` from `tests/helpers/dissolve-harness.ts`. Deleted 3 of 4
  cases in `'IMMEDIATE RECEIPT: one TeamService submission capability for both
  callers'` (`'both a dispatcher and a self-dissolving TeamLeader get the
  identical receipt shape'`, `'a self-dissolve returns its receipt before Core
  stops the calling TeamLeader runtime'`, `'a forced dispatcher dissolve
  returns before the worktree is ever assessed'` — kept the `it.each`
  blocked-dissolve case, which rejects before ever reaching a roster publish)
  and the whole `'OPERATION AS FENCE'` describe (3 of 3 cases: `'two
  concurrent non-forced submissions assess freely but dismantle the Team
  once'`, `'a repeated non-forced submission joins before assessing the
  worktree again'`, `'a repeated submission never re-triggers the underlying
  close'`). **Contract pinned:** the immediate-receipt shape is identical for
  a dispatcher- and a TeamLeader-triggered dissolve; a self-dissolve's receipt
  precedes Core stopping the caller's own runtime; a forced dissolve returns
  before the worktree is ever assessed; and a dissolve submission is a fence —
  concurrent and repeated submissions join the one underlying close rather
  than repeating it. **Failure:** `bootDissolveTeam()`'s own `TeamServiceDeps`
  cast (see next note) omits `coreEvents`; every deleted case here runs a real
  dissolve/close to completion (unlike the DURABLE-FACT RECOVERY and the kept
  `it.each` cases, whose scenarios never reach a roster publish before
  resolving), so each one hits the same undefined-`coreEvents.publish`
  `TypeError` the two files above hit, either directly or wrapped in an
  `AggregateError`. Also removed the now-unused `TeamClosing` type import.

**`dissolve-harness.ts`'s `bootDissolveTeam()` cast is NOT fixed or touched —
R43 forbids it ("一个都不修").** Its `TeamServiceDeps` cast happens to already
supply `conversationProjection`, and — unlike `team-leader-lazy-start.test.ts`'s
and `buildAbandonCreationHarness`'s casts — also already supplies `coreEvents`,
so it still compiles under `tsc -p tsconfig.tests.json` *and* still passes at
runtime for the 19 cases across `team-dissolve-contract.test.ts` (the 12
surviving cases in this file alone), `team-plugin-hooks.test.ts` (1 case), and
`team-dissolve-recovery.test.ts` (not touched this item) that reach it. That
is a fragile survivor, not a verified-correct fixture: nothing pins that its
`coreEvents`/`conversationProjection` values are shaped the way a real
`DispatcherService`-built one is beyond "has a `.publish`/`.hasSources` and a
`.projectInput`/`.projectActivity`" — the cast bypasses the same structural
check that caught every other fixture in this section. Left exactly as found,
flagged here for whoever next touches this helper.

**Isolating this item's collateral from Item 1's, in the same working tree:**
Item 1 and Item 2 both landed in this worktree uncommitted, and one file this
item also edits (`teammate-service/runtime-owner.ts`) carries an unrelated
Item 1 change (`DreamuxLogger.child` made required, no fallback) on the same
class this item's own `conversationProjection` edit lives in. A first,
whole-file stash-based isolation attempt wrongly attributed
`teammate-completion-lifecycle.test.ts`'s 8 runtime failures to this item,
because reverting the whole file also reverted Item 1's `.child` change.
Toggling only the `.child` call site (`runtime-owner.ts`'s
`resolveLaunch()`) confirmed those 8 failures are entirely Item 1's Driver C
(see the correction note above) and unrelated to this item; this item touched
nothing in that file besides the one `conversationProjection?.` →
`conversationProjection.` line already logged in the source-change summary.

## Stage 2a — Item 3

R23: `CronJobStore.create()`'s `maxJobs` parameter and the per-owner cap it
enforced are deleted (`packages/dreamux/src/service/scheduler/store.ts`),
along with the `MAX_JOBS_PER_OWNER = 128` constant and its call-site argument
(`packages/dreamux/src/service/scheduler/service.ts`). `store.create()` is a
surviving export whose shape changed (arity 2 → 1), so this is per-case
deletion, not a whole-file loss (PR-0 precedent).

- **File / describe block:** `packages/dreamux/tests/state-schemas.test.ts` —
  the entire `cron job store: round-trip through the current schema` describe
  block (two cases: `creates, lists, updates, marks fired, and deletes a
  prompt-agent job`, and `enforces the per-owner max job count`).
  **Contract pinned:** the first case is a CRUD round-trip through
  `CronJobStore` (create/list/update/setFired/delete) unrelated to the cap;
  the second asserts `create()` rejects a job past the configured `maxJobs`
  with `/already has the maximum N cron jobs/`.
  **Still holds?** The CRUD round-trip contract still holds and is not
  covered elsewhere in this file — restore it verbatim (with the now
  single-argument `create()` call) in the final PR. The cap-rejection
  contract does not hold — R23 deletes the cap outright, so that case has no
  replacement.
  **Failure:** all three `store.create(input, N)` call sites (two in the
  first case's single call, one each in the second case's two calls) fail
  `tsc -p tsconfig.tests.json` with `TS2554: Expected 1 arguments, but got 2`
  now that `create()` takes one argument. The now-unused `CronJobStore`
  import in this file (no other describe block in it references the class)
  was removed as ordinary dead-import cleanup after the block was deleted,
  not as an edit to keep any case passing.
  **Also checked, no collateral found:** `packages/dreamux/tests/scheduler-cron.test.ts`
  only calls `SchedulerService.create()` (single-argument, unaffected) and
  never calls `CronJobStore.create()` directly;
  `packages/dreamux/tests/legacy-state-fail-loud.test.ts`'s
  `CronJobStore rejects the removed cron deliver/spawn-teammate shapes` block
  seeds fixtures via direct file writes and never calls `.create()`;
  `packages/dreamux/tests/helpers/workflow-harness.ts`'s hand-built
  `fakeCronStore()` double defines `create()` with zero parameters (it only
  throws — not implemented for that harness) and is cast `as unknown as
  CronJobStore`, so the real interface's arity change does not touch it.

## Stage 2a — Item 5

R11: the `dispatcher.start` Command, its `commands.ts` list entry, its
`server-ctl.ts` CLI verb, and the reopen-after-stop machinery in
`input-source-lifecycle.ts` (the `agent_.isRetired()` "cannot replace its
Agent" guard, the `started`/`cleanupPending` fields, and their reset paths)
are deleted. `DispatcherService.start()` itself is not deleted — `server.ts`
still calls it once per enabled dispatcher at boot — but the operation is now
one-shot: `prepareChannels()`/`start()` retain their `preparing`/`starting`
promise forever instead of resetting it to `null` once settled, so a second
caller joins the same settled promise rather than re-running prepare/start.

- **File / case:** `packages/dreamux/tests/core-command-registry.test.ts` —
  `describe('createCoreCommandRegistry — the catalog') > it('registers
  exactly the frozen namespace table, no more and no less')` (one case, plus
  its now-solely-used `FROZEN_NAMESPACE_TABLE` fixture array, deleted
  alongside it — R43's "shared helper stops compiling" reasoning applied to a
  fixture that has no other reader once the case using it is gone).
  **Contract pinned:** the registry answers to exactly this frozen set of
  Command names, sorted, no more and no less — the one place a newly added or
  renamed Command must also be reflected (the fixture's own docstring).
  **Failure:** `dispatcher.start` is removed from the live registry by this
  item's `commands.ts` change, so `[...harness.registry.names()].sort()` no
  longer equals `FROZEN_NAMESPACE_TABLE`, which still lists it — a runtime
  assertion failure (`toEqual`), not a compile error.
  **Does not hold verbatim; changed by a named ruling (R11).** The frozen-set
  contract itself survives, but its content must drop `'dispatcher.start'`.
  Restoration recipe for the final PR: rebuild `FROZEN_NAMESPACE_TABLE`
  without `'dispatcher.start'` and restore the case unchanged. This file's
  sibling case, `'never answers to a deleted Command name'`, already passes
  unedited (its `DELETED_NAMES` fixture never listed `dispatcher.start`, and
  removing a name that was never claimed live does not fail an
  already-passing assertion) — whether to also add `'dispatcher.start'` to
  `DELETED_NAMES` for explicit coverage is new-test territory left for the
  final PR, not done here.
  **Also checked, no collateral found:** `packages/dreamux/tests/commands.test.ts`
  calls `dispatcher.start()` as the `DispatcherService` TypeScript method
  (`await dispatcher.start();`, exercising the real start path via
  `channel.list`), never the `'dispatcher.start'` Command string — unaffected.
  `packages/dreamux/tests/input-source-lifecycle.test.ts` has no case
  asserting `cleanupPending`, `isRetired()`, or the "cannot replace its Agent"
  error text; its one case naming `markStopped()` (`'markStopped() drops the
  held Channel-port fences so a later start initializes a fresh set'`) only
  asserts the call does not throw, which still holds against the trimmed
  method (it now clears `channelPorts` without touching a deleted `started`
  field) — kept unedited. (Superseded by Item 6 below, which deletes this
  file entirely for an unrelated reason.)

## Stage 2a — Item 6

`DispatcherConfig.runtime` deletion (config/config.ts's new on-demand
`dispatcherAgent()` accessor replacing the precomputed field) + `DispatcherStore`
dead-method deletion. Every case below fails because its fixture built a
`DispatcherConfig`/`DreamuxConfig` object literal (directly or through a
shared helper) that still set the now-deleted `.runtime` field, or read
`dispatcher.runtime.*` back off one — found by `tsc -p tsconfig.tests.json`
for every literal typed directly against `DispatcherConfig` (excess-property
compile error) plus one manual read of `state-schemas.test.ts`/`onboard.test.ts`
for a `toMatchObject`/direct-property assertion on `.runtime`, which `tsc`
cannot catch since the field's absence just makes the assertion false, not a
type error.

**Contract pinned everywhere in this section is the same one:** the deleted
field was always a pure clone of `agents[dispatcher.agentRuntime]`, so
nothing about runtime behavior changed — every case below either asserted the
now-gone field's identity/value directly (contract superseded by this item's
own design, not restorable as written) or carried it as inert fixture
boilerplate the case under test never read (contract still holds; restore by
building the fixture through `dispatcherAgent(config, id)` instead of
`.runtime`, or by dropping the dead field from the literal).

- **File / case:** `packages/dreamux/tests/state-schemas.test.ts` — `config
  parser accepts the current shape and rejects a dangling agent ref > accepts
  top-level agents[] + dispatchers[].agentRuntime + channels[]`.
  **Contract pinned:** bundled two things — the config parser accepts the
  current top-level `agents[]`/`dispatchers[].agentRuntime`/`channels[]`
  shape, and (the failing half) the resolved `DispatcherConfig` carries a
  `.runtime` field deep-equal to its agent's provider.
  **Failure:** runtime-only (`toMatchObject({..., runtime: {provider:
  BUILTIN_CODEX_PROVIDER_REF}})` against a dispatcher with no `.runtime`
  field) — `tsc` does not catch this since `toMatchObject` accepts a loose
  object.
  **Superseded by this item's own design for the `.runtime` half; the
  shape-acceptance half still holds and is restoration-worthy** with the
  `.runtime` assertion replaced by `dispatcherAgent(config, 'flow')` deep-equal
  to `{provider: BUILTIN_CODEX_PROVIDER_REF, config: ...}`, or simply dropped
  (the shape-acceptance contract does not need a `.runtime`-shaped assertion
  to hold).
  **Not touched (confirmed unrelated):** the same describe's `'rejects a
  dispatcher-level `runtime` block (moved to agents[])'` case pins the raw
  top-level `dispatchers[].runtime` key rejection at `config.ts`'s
  `readDispatchers` (`'runtime' in raw`) — a pre-existing, separate rejection
  of a *persisted config key*, unrelated to and untouched by this item's
  deletion of the *in-memory resolved* `DispatcherConfig.runtime` field. Left
  exactly as is.

- **File / case:** `packages/dreamux/tests/onboard.test.ts` — `dreamux
  onboard writes dispatcher state, records subprocess files, and passes the
  serve doctor > onboard output round-trips through loadConfig (#148)`.
  **Contract pinned:** bundled two things — `loadConfig` resolves onboard's
  written config into an `agents` map populated with the expected provider +
  config (the `Object.keys(config.agents)`/`config.agents['flow']` assertions,
  still holding), and (the failing half) `config.dispatchers[0].runtime`
  deep-equals `config.agents['flow']`.
  **Failure:** same shape — `config.dispatchers[0]` has no `.runtime` field;
  `toMatchObject`/direct-property read against it is a runtime-only failure.
  **Superseded by this item's own design.** Restoration recipe:
  `dispatcherAgent(config, 'flow')` deep-equals `config.agents['flow']`, and
  `dispatcherAgent(config, 'flow')` deep-equals
  `{provider: 'builtin:codex', config: expect.objectContaining({approval_policy:
  'never'})}`, in place of the two `.runtime`-shaped assertions. The
  agents-map-population half of the contract is unaffected and does not need
  restoring — it already holds.

- **File / case:** `packages/dreamux/tests/team-collection-read-path.test.ts`
  — `'Team-scoped TeamMate workspace borrowing' > 'lets a dispatcher-scoped
  TeamMate (no sharedWorkspace) take its own managed, delete-on-close
  worktree'`.
  **Contract pinned:** `resolveSpawnWorkspace` resolves a dispatcher-scoped
  (no `sharedWorkspace`) spawn to a managed, delete-on-close worktree via
  `WorktreeManager.prepare`, using the dispatcher's real `cwd`.
  **Failure:** the case's inline `DispatcherConfig` literal set `runtime:
  {provider: 'unused', config: {}}` — an excess-property compile error;
  `resolveSpawnWorkspace` never reads `.runtime`/`dispatcherAgent()` at all
  (the field was pure fixture boilerplate the old required type forced).
  **Contract still holds; restore by dropping the `runtime:` line from the
  literal** (the sibling surviving case in this file already omits it, proving
  the type does not need it).

- **File:** `packages/dreamux/tests/dispatcher-plugin-hooks.test.ts` —
  `describe('host.hooks.dispatcher')` (1 case: `'fires once per Dispatcher
  object, with the cached service and its configured cwd'`) and
  `describe('the whole hook tree through a real Server/DispatcherService')`
  (3 cases, plus their shared `buildRealServer()` fixture: the hook-tree
  ordering/frozen-tables/launched-runtime case (R2-adjacent), `'does not
  block Team creation when one dispatcher.hooks.team tap throws...'`, and
  `'awaits an in-flight created hook run before closing channels, on
  dispatcher shutdown'` — the last one is the R2 ruling #5 shutdown-drain
  coverage). **Kept:** `describe('dispatcher.hooks.beforeLaunch')` (1 case),
  which builds its `config: {agents: {...}, dispatchers: []}` inline with no
  `.runtime` field at all.
  **Contract pinned:** `host.hooks.dispatcher` fires once per constructed
  `DispatcherService` with a frozen hook table; the whole hook tree
  (`host.hooks.dispatcher` -> `dispatcher.hooks.beforeLaunch` / `.team` ->
  `team.hooks.beforeTeamLeaderLaunch` / `.created`) wires correctly through a
  real `Server`/`DispatcherService`, survives one tap throwing, and the
  `created` hook's shutdown drain awaits an in-flight run before closing
  channels (R2 ruling #5).
  **Failure:** both fixtures built a `DispatcherConfig` literal with
  `runtime: {provider: ..., config: {}}` set alongside an `agents: {[id]:
  runtime}` entry carrying the identical value — inert boilerplate (neither
  `Server` construction path these tests exercise calls
  `assertRuntimeImplementationsLoaded`, since both always inject
  `agentRuntimeProviderCatalog`, which short-circuits it) — excess-property
  compile error.
  **Contract still holds; restore by dropping the `runtime,` line from both
  fixtures.** No behavior under test reads the field.
  **Stage 6b Item 2 addendum:** the `'awaits an in-flight created hook run
  before closing channels, on dispatcher shutdown'` case's own contract (the
  `created` hook's shutdown drain) is superseded by R48 — `team.hooks.created`,
  its scheduling, and the shutdown drain that awaited it are deleted
  end-to-end, so this half of the above "contract still holds" note no longer
  applies and must **not** be restored on the final test pass. The other two
  cases named above (`host.hooks.dispatcher` firing once per Dispatcher, and
  the hook-tree/tap-throws coverage for `beforeLaunch`/`team`/
  `beforeTeamLeaderLaunch`) are untouched by R48 and still restoration-worthy
  exactly as this entry already says.

- **File:** `packages/dreamux/tests/channel-service.test.ts` —
  `describe('ChannelService')` (4 cases: `'build() hands each provider the
  exact Core-owned create context'`, `'closes already-built sessions and
  never publishes a partial "built" map on failure'`, `'sessionMcp() reads
  the built map, independent of adoption/liveness'`, `'closeAll() detaches
  its maps before awaiting shutdown, and logs per-channel failures'`), plus
  the file-local `dreamuxConfigWith()` and `silentLogger()` helpers they alone
  used. **Kept:** `'external channel provider loader...'` (3 cases) and
  `'channelMcpDelegates...'` (5 cases), which build no `DreamuxConfig` at all.
  **Contract pinned:** `ChannelService.build()` hands each provider the exact
  Core-owned create context and unwinds already-built sessions on partial
  failure without publishing a torn-down map as "built"; `sessionMcp()`
  answers from composition, not connectivity; `closeAll()` detaches its maps
  before awaiting provider shutdown and logs per-channel close failures.
  **Failure:** `dreamuxConfigWith()`'s return literal set `runtime:
  {provider: 'builtin:codex', config: {}}` against a `DreamuxConfig` with
  `agents: {}` (empty) — an already-impossible-in-production state
  (`dispatcherAgent()` would resolve to `undefined` for this fixture), but
  none of the four cases' code paths (`ChannelService` methods) ever read
  `.runtime`/`dispatcherAgent()` — excess-property compile error at the
  helper's own return statement, which fails the whole describe block
  (R43's shared-helper-stops-compiling rule).
  **Contract still holds; restore by dropping the `runtime:` line from
  `dreamuxConfigWith()`.** No behavior under test reads the field; the
  `agents: {}` / no-`agentRuntime`-resolution mismatch this fixture already
  has today is pre-existing and unrelated to this item.
  **Also affected, same fixtures, independent driver — Item 1 Driver C
  (`.child` required-ness) parked list:** `silentLogger()` (line 57 before
  this item's edits) is also this describe's four cases' logger source, and
  was already on Item 1 Driver C's "no file deleted or edited, decision
  needed" list before this item touched anything. Deleting these four cases
  for this item's own, independent reason (R43 is a knowing, ruled deletion
  here — `DispatcherConfig.runtime` is a plan-named removal, unlike Driver
  C's disproven premise) removes `channel-service.test.ts` from Driver C's
  remaining scope as a side effect. `rush test` (vitest, esbuild-transpiled)
  confirmed all 12 of the file's original cases passed at runtime before this
  item's edit — none of this was dead coverage.

- **File:** `packages/dreamux/tests/commands.test.ts` — `describe('channel.list')`'s
  `'reads a stopped Dispatcher through the real Server host without starting
  sessions'` and `'reports live Channels built and adopted by the real
  Dispatcher start path'` (2 of 6 cases in the file), plus the file-local
  `createChannelListServer()` helper they alone used. **Kept:** the other 3
  `channel.list` cases (harness-based, no real `Server`) and the whole
  `describe('ExecaCommandRunner')`.
  **Contract pinned:** `channel.list` reads a stopped Dispatcher's configured
  Channels (none live) through a real `Server` without starting sessions, and
  reports live/adopted Channels correctly across a real dispatcher
  start/stop.
  **Failure:** `createChannelListServer()`'s `config` literal set `runtime:
  {provider: 'npm:@example/runtime', config: {}}` — the identical value
  already sits at `agents: {example: runtime}` — excess-property compile
  error at the helper's own definition, failing both cases that call it
  (R43's shared-helper-stops-compiling rule).
  **Contract still holds; restore by dropping the `runtime,` line from the
  fixture** (the `Server` construction here also always injects
  `agentRuntimeProviderCatalog`, so `assertRuntimeImplementationsLoaded`
  never runs and never reads the field).
  **Also affected, same fixture, independent driver — Item 1 Driver C parked
  list:** `createChannelListServer()`'s inline logger literal (line 205
  before this item's edits) was already on Driver C's "2 of 6 cases" parked
  entry. Same independent-basis reasoning as `channel-service.test.ts` above;
  `rush test` confirmed both cases passed at runtime before this item's edit.

- **File:** `packages/dreamux/tests/input-source-lifecycle.test.ts` (whole
  file, 7 cases — deleted outright, not just the shared helper, since a test
  file with zero suites fails vitest). **Contract pinned:** "Coverage cell F"
  — `DispatcherInputSourceLifecycle`'s startup/shutdown ordering: Channel
  init/subscribe before Core operations recover, Channel start before
  ordinary admission opens; all four catalog event kinds delivered to a
  subscribed Channel (none if it needs none); `closeChannelPortAdmission()`'s
  synchronous fence; `closePreparedChannels()`'s built-but-unstarted-session
  close without materializing a dormant entity or persisting a close; a
  failed start's reverse-acquisition rollback that keeps Channel
  subscriptions live through runtime stop and never rematerializes/closes
  durable entities; `markStopped()`'s fence-drop. Per the file's own header,
  this is also the sole exerciser of four "failure ledger item 14" absence
  checks (a dormant-entity materialization, a persisted `closed`, a
  retirement fact, or worktree cleanup reaching a fake method that does not
  implement it).
  **Failure:** the shared `buildHarness()`'s `config: DreamuxConfig` literal
  set `runtime: {provider: 'builtin:codex', config: {}}` — excess-property
  compile error at the helper's own definition, reached by all 7 cases.
  **Contract still holds; restore by dropping the `runtime,` line from
  `buildHarness()`'s config literal** — none of this file's assertions read
  `.runtime`/`dispatcherAgent()`.
  **Also affected, same fixture, independent driver — Item 1 Driver C parked
  list:** this file was already on Driver C's "all 7 cases (shared
  `buildHarness()`)" parked entry (module-level logger stub missing
  `.child`). Same independent-basis reasoning as above; `rush test` confirmed
  all 7 cases passed at runtime before this item's edit — this was fully live
  coverage, not dead weight, and its restoration (both the `.child` fixture
  fix Driver C owes and this item's one-line `runtime,` drop) should happen
  together.

- **File:** `packages/dreamux/tests/teammate-completion-lifecycle.test.ts`
  (whole file, 8 cases — deleted outright, same reasoning as
  `input-source-lifecycle.test.ts`). **Contract pinned:** TeamMate completion
  delivery across deliberate lifecycle teardown — model/admin close results
  while suppressing owner input, Team dissolve without member-to-leader/
  leader-to-Dispatcher cleanup input, Workflow-active dissolve without
  submitting a stopped terminal fact, late admission settlement after a
  failed host stop, restart delivering a new Turn while suppressing shutdown
  cleanup, completions settling behind the dispatcher fence during Workflow
  teardown, the dispatcher fence staying closed across a released
  TeamLeader's restart, and a Dispatcher Workflow stop during host shutdown
  without submitting its terminal fact.
  **Failure:** the shared `createHost()`'s `config: DreamuxConfig` literal set
  `runtime: {provider: PROVIDER_REF, config: {}}` (identical value already at
  `agents: {[AGENT_RUNTIME_ID]: runtime}`) — excess-property compile error at
  the helper's own definition, reached by all 8 cases.
  **Zero currently-passing coverage lost by this item.** Unlike every other
  entry above, `rush test` confirmed this file's 8 cases were already
  entirely red at runtime *before* this item touched anything — Item 1
  Driver C's documented correction (`teammate-service/runtime-owner.ts`'s
  `resolveLaunch()` calls `this.deps.log.child(...)` unconditionally; this
  file's module-level `silentLogger`/`as DreamuxLogger` cast has no `.child`,
  so every case throws a `TypeError` before reaching the runtime it starts).
  This item's own `.runtime` deletion is layered on an already-fully-broken
  fixture. **Restoration needs both fixes together:** `.child` added to the
  module-level logger (Driver C's own owed fix) AND the `runtime,` line
  dropped from `createHost()`'s config literal (this item's).

- **File:** `packages/dreamux/tests/helpers/config.ts` — `testDispatcherConfig()`
  and `testDreamuxConfig()` (an in-memory `DispatcherConfig`/`DreamuxConfig`
  builder pair) and their `TestDispatcherOptions` interface. **Not a test
  file** (no suites of its own) and **not test-coverage collateral**:
  confirmed zero callers anywhere in the repo before this item touched them
  (`grep -rln "testDispatcherConfig\|testDreamuxConfig"` across the whole
  tree returns only this file's own definitions) — pre-existing dead helper
  code, unrelated to any passing or failing test. Deleted because
  `testDispatcherConfig()` built the now-deleted `.runtime` field (excess
  property) and `testDreamuxConfig()` read `dispatcher.runtime.provider`/
  `.config` back off it (property does not exist) — both fail
  `typecheck:tests` at their own definitions regardless of caller count.
  **Kept:** `testConfigFileObject()`/`testSingleDispatcherFileObject()` (the
  on-disk config.json shape builders `uninstall.test.ts`/`daemon.test.ts`/
  `onboard.test.ts` use), unaffected — they never touched `.runtime`.

**Driver C (Item 1's parked `.child` required-ness decision) status after
this item:** four of the files on Driver C's original parked list
(`channel-service.test.ts`, `commands.test.ts`,
`input-source-lifecycle.test.ts`, `teammate-completion-lifecycle.test.ts`)
had their affected cases deleted by this item for an independent, ruled
reason (`DispatcherConfig.runtime`'s deletion, not `.child`'s). This is not a
reversal of Item 1's "no file deleted or edited for this driver" note — that
note's own justification (deleting collateral to accommodate a source change
resting on a disproven premise is an unknowing change) does not transfer to
this item's collateral, since `DispatcherConfig.runtime` is a plan-named,
knowing removal with nothing in doubt. Driver C's remaining, still-parked
scope: `tests/helpers/event-harness.ts` (→ all of `cot-projection-privacy.test.ts`,
19 of 35 `core-event-catalog.test.ts` cases), `removed-surfaces.test.ts` (1
case), and the twelve-plus `feishu-channel` test files listed in Item 1's own
section.

**DispatcherStore dead-method deletion (`.create()`/`.upsert()`/`.remove()`,
`DispatcherCreateInput`):** no test collateral. Confirmed zero callers
(`grep -rn "DispatcherStore"` across `packages/dreamux/tests` returns only
`input-source-lifecycle.test.ts`'s `.get()`/`.list()`-adjacent construction
`new DispatcherStore(config)`, and that file is deleted above for an
unrelated reason) before this item touched them.

## Stage 2a — Item 7

`@excitedjs/agent-runtime-claude-code`, R29: `ClaudeCodeStreamRpc`'s
`lifecycleSupported: boolean | null` tri-state, `decideLifecycleSupport()`,
`rejectWaitingRequests()`, and `lifecycleUnsupportedError()` are deleted from
`rpc.ts` — `command_lifecycle` admission is now assumed always supported, so
every `submit()` writes to stdin immediately instead of waiting in
`this.requests` for a capability decision. A direct consequence traced
during implementation (not named line-by-line in the stage plan, which left
the exact shape to the implementer): since nothing ever leaves a request
sitting unwritten anymore, `PendingRequest.write` can never be observed
non-null by any other handler, so it is deleted too, and `close()`,
the `command_lifecycle` handler, and the `result` handler's `write ===
null`/`write !== null` branches collapse to their single surviving arm.
`close()` no longer produces `{status:'stopped'}`/`{status:'failed'}`
admissions for a request that was registered but never written — that
outcome is now structurally unreachable, so every admission `close()`
produces is `{status:'ambiguous'}`. Also R30: `ClaudeProtocolEvent`'s
`'result'` variant drops `commandUuids` (confirmed test-only — production's
`handleProtocolEvent` never read it) and `TurnSubmitOptions.isSynthetic` is
deleted (confirmed dead — no production caller ever set it `true`); `ParsedLine`'s
`'init'` variant drops `capabilities` as a direct consequence of deleting its
only reader (the `msg_lifecycle_v1` capability check this item removes).

- **File / cases (compile — `.commandUuids` no longer exists on the type once
  `h.results()`'s `.filter((event) => event.kind === 'result')` narrows the
  array element and the field itself is gone):**
  `packages/agent-runtime/claude-code/tests/rpc.test.ts` —
  `it.each(['before', 'after'])('shares one completion for folded inputs with
  completed %s result', ...)` (both entries), `it.each(['before', 'after'] as
  const)('settles a consumed failure with cancelled %s result and preserves
  the queued request', ...)` (both entries), `it.each([...four failure
  shapes...])('never retains a consumed request past an error boundary %j',
  ...)` (all four entries), and `it('resets idle time on every native line
  and clears it as soon as requests are answered', ...)`.
  **Contract pinned:** each of these tests pins a *different* completion/error
  contract (folding two commands into one completion, preserving a queued
  request across a cancelled-and-failed sibling, never retaining a consumed
  request past an error boundary, resetting the idle timer per native line) —
  the shared collateral is only their trailing `h.results()...commandUuids`
  assertion, not the behavior under test.
  **Still holds?** Yes, verbatim except for the dead assertion line — none of
  these tests exercised the deleted lifecycle tri-state. Restore in the final
  PR by dropping the `commandUuids` expectation only.

- **File / cases (runtime — `toMatchObject({ commandUuids: [] })` no longer
  matches once the emitted event has no such key at all):**
  `packages/agent-runtime/claude-code/tests/rpc.test.ts` —
  `it('reports an unbound internal failure and clears its text before later
  input', ...)` and `it('reports setup failure without guessing a queued
  owner, then fails the named cancelled request', ...)`.
  **Contract pinned:** an unbound/internal native failure is reported once
  with the right `outcome`, and a later request is unaffected by it; a
  `turn_setup_failed` result is reported without guessing a queued owner, and
  the named cancelled request still fails cleanly while its sibling completes
  normally.
  **Still holds?** Yes, verbatim except for the `commandUuids: []` half of
  each `toMatchObject` matcher — restore by dropping that key.

- **File / cases (behavior — the deferred-write/queued-admission path R29
  deletes no longer exists, so the scenario these tests set up cannot occur):**
  `packages/agent-runtime/claude-code/tests/rpc.test.ts` —
  `it('preserves input order while capability is unknown and flushes on
  started before init', ...)`, `it('does not flush remaining unwritten
  requests when a write callback stops the session', ...)`, `it('preserves
  write order when an early callback submits input during capability
  release', ...)`, `it('rejects unwritten concurrent input when capability is
  absent, then supports subsequent single input', ...)`, `it('releases
  unwritten input when the first matching result arrives before capability is
  decided', ...)`, and `it.each(['stop', 'fail'] as const)('classifies
  unconfirmed native writes as ambiguous on %s', ...)` (both entries).
  **Contract pinned:** input ordering/flushing while `command_lifecycle`
  support was still undecided; rejecting a second concurrent input when the
  CLI reports no `msg_lifecycle_v1` capability; releasing an unwritten
  request when a result arrives before the decision; classifying a *never
  written* request as cleanly `stopped`/`failed` (as opposed to `ambiguous`)
  on session close.
  **Does not hold; changed by R29.** R29 is exactly "只保留 command_lifecycle
  这一套" — there is no unsupported/undecided state left to hold a request in,
  so none of these scenarios can occur. Not restorable as written; the
  `'classifies unconfirmed native writes as ambiguous'` test's surviving
  half (a write that *was* sent but never acknowledged closes as `ambiguous`)
  is still covered structurally by `close()`'s single remaining branch, just
  not by a dedicated case.

- **File / case (one parametrized entry, not the whole block):**
  `packages/agent-runtime/claude-code/tests/rpc.test.ts` —
  `it.each([true, false])('never uses a foreign UUID as sole-request fallback
  with lifecycle=%s', ...)`, `false` entry only (kept as `it.each([true])`,
  per R43's "delete a specific case" applied to one generated instance of a
  data-driven test, not the block).
  **Contract pinned (dying half):** with lifecycle not yet confirmed and no
  `user_message_uuid` on the terminal result, the *sole* outstanding request
  was still matched by exclusion (the deleted fallback).
  **Does not hold; changed by R29.** The `true` entry's contract (never
  matching a foreign/internal uuid; matching only on the request's own uuid)
  is unrelated to the tri-state and still holds — kept.

- **File / case (excess-property compile error):**
  `packages/agent-runtime/claude-code/tests/stream.test.ts` —
  `it('buildUserMessage sets isSynthetic as a sibling of message', ...)`.
  **Contract pinned:** `buildUserMessage` puts `isSynthetic: true` as a
  sibling of `message` on the stdin envelope when asked.
  **Does not hold; changed by R30.** `isSynthetic` is deleted outright (no
  production caller ever requested it) — there is no replacement behavior.
  The sibling case, `'buildUserMessage omits isSynthetic by default'`, still
  compiles and passes (trivially — the key can no longer exist), and is kept
  unedited, matching this file's own standing convention of keeping a
  deleted-feature's absence as a regression guard (see the adjacent `'sends
  no delivery priority at all'` case).

- **File / helper + cases (compile — the shared `resultEvent` helper's own
  return-type-annotated literal fails `tsc` once `commandUuids` leaves
  `ClaudeProtocolEvent`'s `'result'` variant, so every case reaching it dies
  with it, per R43's "shared helper stops compiling" rule; cases that build a
  `'result'`/`'interrupted'` event without going through the helper are
  unaffected and were left unedited):**
  `packages/agent-runtime/claude-code/tests/runtime-activity.test.ts` — the
  `resultEvent()` helper itself, and: `'emits the cumulative usage snapshot
  immediately before native end'`, `'reports background result usage without
  any submitted command and a null context'`, `'emits a fresh snapshot on
  each result, carrying native cumulative counters'`, `'emits no usage event
  when the native result has no metrics'`, `'emits exactly one ended fact for
  a turn that folded three commands into one result'`, `'reports failed when
  the native result carries isError'`, `'emits one end per result boundary
  when a steered command runs after the first one was answered'`, `'reports
  the second boundary honestly when the steered turn fails after a completed
  one'`, `'reports every terminal result, including a background result'`.
  Also removed as direct cleanup: the now-unused `endNativeTurn` import (its
  only caller was the first case above).
  **Contract pinned:** each case pins a `handleProtocolEvent` → `RuntimeActivity`
  projection fact (cumulative token usage before `turn.ended`, a background
  result's usage/end with a null context, one `turn.ended` per result
  boundary including folded/steered/background cases). None of them assert
  on `commandUuids` — it was only ever a constructor parameter of the shared
  fixture helper, never read by `handleProtocolEvent`.
  **Still holds?** Yes, verbatim — restore by rebuilding `resultEvent()`
  without the `commandUuids` parameter (drop it; it was already unread by
  production) and restoring each case unchanged.
  **Not touched (confirmed unaffected):** `it.each(['result', 'interrupted']
  as const)('still ends a %s with no envelope uuid', ...)` builds its event
  as an un-annotated `const`, not a literal at the call site, so the extra
  `commandUuids: []` field it still carries does not trigger an excess-property
  check and the case keeps passing as-is; left unedited per R43 (a still-passing
  case is not a deletion candidate).

**Also checked, no collateral found:** `packages/agent-runtime/claude-code/tests/session.test.ts`
calls `session.submit(prompt, {}, commandUuid)` against the kept 3-argument
`submit()` signature — unaffected, since `TurnSubmitOptions` itself is kept
(now empty) rather than removed; `packages/dreamux/tests/package-boundary-guards.test.ts`'s
pinned `agent-runtime-claude-code index.ts exports exactly the pinned name
set` case is unaffected for the same reason (the barrel's export *names* are
unchanged — only field-level shape inside `TurnSubmitOptions`/`ParsedLine`/
`ClaudeProtocolEvent` changed, confirmed green by running that file's test
suite directly). `packages/agent-runtime/claude-code/tests/rpc.test.ts`'s
`init()` harness helper still emits a raw `capabilities: ['msg_lifecycle_v1']`
key on the wire for the one surviving caller that passes `supported: false`
(`'reads the artifact as the answer even when no control response arrives'`)
— harmless, since the wire payload is untyped JSON and the key is simply no
longer read.

**Not deleted, left in place (confirmed live, contrary to the stage plan's
"check before deleting" note):** `activity/native-hash.ts`'s
`claudeNativePathHash`/`wyhash` — confirmed live, used by `activity/path.ts`'s
`sanitizePath` for every long-cwd project-directory name. `activity/path.ts`'s
`discoverWorktreePaths` and the worktree-list fallback in
`discoveryCandidates` — traced structurally rather than left as "unconfirmed":
the exhaustive full-project-directory fallback tier is bounded by
`ClaudeScanBudget` (`maxEntries`/`maxElapsedMs`, `activity/budget.ts`), so the
worktree-derived candidates are not a pure reorder-for-speed optimization —
on a host with enough accumulated Claude Code project directories, they can be
the difference between finding a session and the exhaustive fallback hitting
its bound first. No test exercises this distinction either way; the
conclusion is from reading `discoveryCandidates`'s three discovery tiers, not
from a test result.

## Stage 2a — Item 8

`@excitedjs/agent-runtime-codex`, R24/R25: `turn_timeout_ms` and
`approval_policy` are deleted from `DispatcherCodexConfig`,
`defaultDispatcherCodexConfig()`, and `readDispatcherCodexConfig()`'s
read/validate/return logic (both key names stay in the reader's
`rejectUnknownKeys` allow-list so an existing `config.json` that sets either
still loads — they are just no longer mapped into the returned config).
`args.ts`'s `parseCodexArgs`/`codexArgsFromConfig` stop reading
`obj['approvalPolicy']`/`config.approval_policy` and hard-code
`approvalPolicy: 'never'`; `TRUSTED_LOCAL_APPROVAL_POLICIES` and its
now-tautological fail-fast check are deleted.

- **File / case (compile-adjacent — a snapshot assertion, not an import
  break: `namedExports()` regex-scans `index.ts`'s literal export list, so
  the pinned array no longer matches once three names it names are gone):**
  `packages/dreamux/tests/package-boundary-guards.test.ts` — `it('agent-runtime-codex
  index.ts exports exactly the pinned name set', ...)`.
  **Contract pinned:** the exact set of names `@excitedjs/agent-runtime-codex`'s
  barrel re-exports, so an accidental new/removed export is caught in review.
  **Still holds?** The contract mechanism (barrel surface is intentional and
  pinned) still holds; the specific array is stale — `ALLOWED_APPROVAL_POLICIES`,
  `DEFAULT_APPROVAL_POLICY`, and `DEFAULT_CODEX_TURN_TIMEOUT_MS` are gone from
  `config.ts` (this item) and so from the barrel. Restore in the final PR by
  regenerating the pinned array from the barrel's current export list (drop
  the three names above; no other name in this array is affected by this
  item).
- **File / case (runtime — the doc-comment text this test's prose-search
  regex requires no longer exists, since the field it documents is deleted):**
  `packages/dreamux/tests/feishu-allow-chats-release-contract.test.ts` —
  `it('declares the Codex comment correction as type none while pending', ...)`.
  **Contract pinned:** an unrelated earlier PR (the trusted `allow_chats`
  release) left a stray-comment correction to `config.ts`'s `turn_timeout_ms`
  doc paragraph; this case locked that correction's release-note bookkeeping
  (pending change file, or the corrected doc text landed) so it would not be
  silently dropped before its own change file was retired.
  **Still holds?** No — changed by this item's own named ruling (R24): the
  `turn_timeout_ms` field and its whole doc paragraph (the text the case's
  regex searched for) are deleted outright, not merely corrected. The
  contract this case pinned no longer has a subject. Not a restoration
  candidate.

**Not deleted, left in place (contrary to the stage plan's "delete if their
only purpose was feeding args.ts" note):** `types.ts`'s
`ThreadStartParams.approvalPolicy?`/`ThreadResumeParams.approvalPolicy?` —
confirmed these carry the Codex `thread/start`/`thread/resume` JSON-RPC
protocol shape, not the config→CLI-arg plumbing `args.ts` owns; `runtime.ts`'s
`resolveThread()` never sets either field when constructing the params
objects it sends (only `threadInstructions`, and for resume, `threadId`), so
they are pre-existing unused protocol surface unrelated to R24/R25 — left
untouched rather than folded into this item's scope.

## Stage 2a — Item 9

`@excitedjs/agent-runtime-codex`: `events.ts`'s one-shot `runTurn()`,
`TurnCollector.awaitTurn()`, the `awaiting` map / `resolveAwaiting()`, and
`firstCompleted`/`firstFailure`/`firstFailureTurnId`/`completedByTurn`/
`failuresByTurn` are deleted, along with `TurnSubscriptionOptions`'
`acceptAnyThread`/`onTrace`/`TurnTraceEvent`/`retainAfterTerminal`/
`onProtocolViolation` (confirmed: `turn-manager.ts` is the only production
caller of `subscribeTurnCollection`, always passed `retainAfterTerminal:
true`, and never set `acceptAnyThread` or `onTrace`).
`terminalFingerprint()`'s sha256 comparison and the `'conflict'` terminal
state (R28/P3: a defensive content-hash comparison with no named failure
scenario) are replaced with a plain `Set<string>` of turn ids (membership
only, per target-org §6.4); no test pinned `onProtocolViolation`, so this
line is prose-only, not a ledger case. `turn-manager.ts`'s `ensureCollector`
no longer
re-subscribes on a thread-id change (collapsed to construct-once — confirmed
`this.threadId` is written only in `CodexRuntime`'s constructor and inside
`resolveThread()`, and `resolveThread()` always finishes — so stops
reassigning `this.threadId` — before that generation's `TurnManager` is
constructed, so one live instance's `getThreadId()` never returns a second
value). `activity/reader.ts`'s `readCodexRecentActivity` drops its
`testHooks` third parameter (zero callers) and the `maxReadChunkBytes`
plumbing that existed only to serve it.

`TurnCollector.releaseTurn()` (the item's named design decision, not a
mechanical strip) survives with a narrowed body — `itemsByTurn.delete(turnId)`
only, since `completedByTurn`/`failuresByTurn`/`firstCompleted`/
`firstFailureTurnId` are deleted along with `awaitTurn`. It has a real job:
`itemsByTurn` has no size bound of its own (unlike the terminal-id set, which
keeps `TERMINAL_TURN_ID_LIMIT`'s eviction), every `item/completed`
notification appends to it, and nothing else ever deletes an entry — without
`releaseTurn`, a long-lived resident collector leaks one buffered-items array
per native turn it has ever observed. `TurnManager`'s four call sites keep
calling it once each is done with a turn (an unbound orphan in
`drainTerminalOrder`/`releaseOrphanTurnsIfIdle`, a protocol failure in
`failRecord`, and a delivered completion in `releaseRecordIfReady`). One of
those four, `failRecord`'s, now always fires on a collector that is already
closing: `failRecord` runs only from `failProtocol`, whose only caller is the
collector's own `onUnscopedFailure`, and the collector calls its own
`closeCollector()` (which clears `itemsByTurn` outright) immediately after
that callback returns — so this `releaseTurn` call is a harmless no-op, not a
bug.

- **File (compile break — imports `runTurn` and `TurnTraceEvent`, both
  deleted):** `packages/agent-runtime/codex/tests/codex-events.test.ts` —
  whole file deleted.
  **Contract pinned:** `subscribeTurnCollection`'s one-shot query surface —
  `onTrace` traces every notification before filtering; `acceptAnyThread`
  resolves `turn/completed`/`item/completed` even on a mismatched
  `threadId`; `awaitTurn()` resolves/rejects/dedupes per turn id and caches
  a post-terminal result; `dispose()` unsubscribes idempotently; `runTurn()`
  unsubscribes when `turn/start` itself is rejected.
  **Still holds?** No — the audit's confirmed-zero-caller finding: no
  production code calls `runTurn`/`awaitTurn`/`acceptAnyThread`/`onTrace`
  (only `turn-manager.ts` calls `subscribeTurnCollection`, and it never sets
  any of them), so the one-shot query mode this file tested is gone, not
  moved. Not a restoration candidate.

- **File / case (behavioral — the file still compiles; the case hangs to
  its 5s vitest timeout once `ensureCollector`'s thread-change branch is
  collapsed, verified by running it before deleting):**
  `packages/agent-runtime/codex/tests/codex-runtime.test.ts` — `it('clears
  the latest snapshot when the collector changes threads', ...)`.
  **Contract pinned:** a single `TurnManager` instance, given a
  `getThreadId()` that returns a different thread id on a later call, tears
  down its collector and resubscribes to the new thread instead of silently
  discarding notifications scoped to it.
  **Still holds?** No — changed by this item's own instruction, which
  required confirming thread-id invariance first: `CodexRuntime` resolves
  the native thread (`resolveThread()`) and only then constructs that
  generation's `TurnManager`; nothing reassigns `this.threadId` again while
  that instance is live, so no production `TurnManager` ever observes
  `getThreadId()` return a second value. The test's mid-life `threadId`
  mutation on one long-lived `TurnManager` is a scenario production cannot
  reach (the audit's own watch-list flag, `codex-runtime.test.ts:686-707`).
  Not a restoration candidate. Deleting it left the `TurnManager` and
  `CodexReasoningEffort` imports in this test file unused (this was their
  only caller in the file); both import lines are removed as a direct,
  mechanical consequence, not an edit to any surviving test's assertions.

## Stage 2a — Item 10

R39 ("把这个日志删掉") resolved by elimination, not by an operator re-ruling:
`item 10`'s own "locate, don't guess" step ran the branch check (`origin/feat/
plugin-system-mvp`'s `diagnostics.ts` is byte-identical to this worktree's —
no other candidate landed there) and found `SECRET_KEY`/`sanitizeSdkArgs`/
`redactForLog` is the only "secret list" mechanism anywhere in
`@excitedjs/feishu-transport/src`. The plan's own STOP condition was "the
branch check *and* the leading candidate both come back negative"; only the
branch check came back negative, so the leading candidate stands confirmed by
elimination, executed as item 10 described: `sdkLogger`,
`sanitizeSdkArgs`/`redactForLog`/`formatSdkArgs`, `SECRET_KEY`,
`AXIOS_PAYLOAD_FIELD`, `MAX_REDACT_DEPTH`, `SDK_SOURCE` deleted from
`diagnostics.ts`; `TransportDiagnostics` no longer carries an `sdkLogger`
field. The three `logger: diag.sdkLogger` call sites in `feishu.ts` are
replaced with a shared `NOOP_SDK_LOGGER` constant — passing `undefined`
instead would not delete the log, it would hand the Lark SDK's own
`defaultLogger`, which writes unredacted args (including the
`{app_id, app_secret}` token-fetch body) straight to `console.log`/
`console.warn`, both reopening the #229 credential leak and (`console.log`/
`console.info`/`console.debug`) breaking the stdio-reserved-for-JSON-RPC rule.
This reading is an **inference** from the ruling's wording, flagged for the
operator to veto: the visibility actually lost is SDK-originated
auth/HTTP-failure detail (e.g. a token refresh failing); the WebSocket
connection-lifecycle log (`diag.connection`) and best-effort failure log
(`diag.diagnostic`) are untouched and still reach a host's channel log.

- **File / cases (surviving file, per-case — `TransportDiagnostics` no
  longer has an `sdkLogger` field, so each case fails to compile on the
  property access, not on an import line):**
  `packages/channel/feishu-transport/tests/diagnostics.test.ts` —
  `test('sdkLogger prefixes [feishu-sdk] on every level and writes only to
  stderr', ...)`, `test('sdkLogger routes each level to the matching logger
  method with a source field', ...)`, `test('safety: a sentinel secret / body
  never reaches the injected logger', ...)` (drove `diag.sdkLogger.info(...)`
  as one of four sinks it exercised), and the whole
  `describe('createTransportDiagnostics — sdkLogger secret redaction', ...)`
  block (5 cases: `'injected path: blanks the request body so app_secret
  never reaches the logger'`, `'default (no logger) path: app_secret never
  reaches stderr either'`, `'scrubs a raw AxiosError instance reached via the
  non-axios fallback'`, `'redacts a credential-named key wherever it
  appears'`, `'passes a plain Error through unchanged so its stack still
  renders'`).
  **Contract pinned:** the `sdkLogger` sink existed at all, reproduced the
  historical `[feishu-sdk]` stderr prefix / routed-with-source-field
  behavior, and scrubbed `app_secret`/`access_token`/other credential-named
  keys and axios `config.data`/`headers`/`auth` before any SDK arg reached
  either sink.
  **Changed by this item (R39), does not hold.** The `sdkLogger` sink is
  deleted outright, not narrowed — there is no redacted-forwarding behavior
  left to pin. The `'safety: ...'` case's other three sinks
  (`diag.connection` ×2, `diag.diagnostic` ×1) still hold and are unaffected;
  only its `diag.sdkLogger.info(...)` line is gone, but per R43 a case whose
  fixture/assertion no longer fits is deleted whole, not edited down to its
  surviving lines. Not a restoration candidate unless R39 is reversed — if
  the operator vetoes this reading, the fix is a different one (redact but
  keep the log), which needs its own test, not a resurrection of these.

**Corrects a forward reference in item 11's own log entry** (this file,
below, `'createFeishuTransport — injected logger safety boundary (#74)'`):
that entry said item 10's STOP on R39 was "the pending decision" and that
`diagnostics.test.ts`'s `'safety: ...'` case plus the `sdkLogger` redaction
suite covered the contract "in the interim" — both are now stale, since this
item resolves the STOP and deletes both. See the corrected paragraph there.

## Stage 2a — Item 11

`@excitedjs/feishu-transport`, dead API removal: `FeishuTransport.createGroup`/
`.inviteMembers` and their `FeishuCreateGroupInput`/`FeishuCreateGroupResult`/
`FeishuInviteMembersInput`/`FeishuInviteMembersResult` types, the
`FEISHU_TRANSPORT_PACKAGE` marker constant, and the `webSocketRegistration`
option (`FeishuTransportOptions.webSocketRegistration`,
`FeishuWebSocketRegistration`) are deleted — confirmed zero production
callers in `@excitedjs/feishu-channel` (the one consumer package) and zero
callers anywhere else in the repo outside `@excitedjs/feishu-transport`'s own
tests. Direct cleanup that followed from the deletions: `feishuChatClient()`'s
structural return type is trimmed to `chat.get` only (`chat.create`/
`chat.members.create` were used only by the two deleted methods);
`FeishuSelfIdentityCache.accept()` and its implementation are deleted from
`transport/identity.ts` (its only call site was the deleted
`webSocketRegistration` branch of `openInbound()`).

`webSocketRegistration` differs from the other three symbols: it was not
zero-caller in the item-7 sense (`skill-materializer.ts`'s `testHooks`
precedent) — it is a deliberate test/embedding seam, and two of
`feishu-transport`'s own tests used it. The audit's/plan's "zero callers"
classification rested on cross-package (production) callers only. If a
reviewer prefers item 7's standard for test-only seams (keep it, since it has
an in-package test caller), this is the one symbol in this item to revert;
doing so also restores `identity.ts`'s `accept()` and its one dying test case
below.

- **File (whole, obsolete):** `packages/channel/feishu-transport/tests/smoke.test.ts`.
  **Contract pinned:** the PR0-scaffold marker `FEISHU_TRANSPORT_PACKAGE`
  equals `'@excitedjs/feishu-transport'` — its own header says "Real behavior
  tests land with the ported logic in PR1," i.e. it was never meant to
  outlive the scaffold.
  **Still holds?** No — the marker is deleted outright. No such test exists in
  `feishu-channel` today (grep across its `tests/`); the constant's own doc
  comment claims one depends on it, but the only reader found in this repo's
  current tree was this package's own `smoke.test.ts` — grep confirms today's
  tree, not history, so this is stated as a present-tense correction, not a
  claim the doc comment was always wrong. The file's one assertion has no
  subject left; a test file with zero surviving cases fails vitest, so the
  whole file is removed, not just the assertion.

- **HIGH-RISK, restore first.** **File / case (compile — import-line failure,
  not a fixture edit):** `packages/channel/feishu-channel/tests/feishu-bot.test.ts`
  (whole file, all 8 cases — corrected from an earlier miscount of 9; the base
  file (`origin/feat/plugin-system-mvp`) has exactly 8 `it()` cases).
  **Contract pinned:** `createFeishuBot`'s inbound routing and dispatch —
  per-message creation observer forwarding, `im.message.receive_v1`-only
  registration and raw-event normalization, sender-name fallback,
  unroutable-event dropping, the bot-member-added route gated on a handler
  being supplied (issue #62), `card.action.trigger` registration and response
  passthrough, malformed card-action-response normalization, and raw
  card-callback key stripping.
  **Failure:** its `import type {...} from '@excitedjs/feishu-transport'`
  line imports `FeishuCreateGroupInput`, `FeishuCreateGroupResult`,
  `FeishuInviteMembersInput`, `FeishuInviteMembersResult` among 14 other,
  still-valid names — 4 of the 18 no longer exist, so the import line itself
  fails to resolve and the whole file fails to load (R43's first bullet: a
  deleted export a test file imports, not a shape change). `class
  FakeTransport implements FeishuTransport` with its two now-extra
  `createGroup`/`inviteMembers` methods would still compile on its own
  (TypeScript allows a class to implement more than an interface requires) —
  it is only the four now-nonexistent type names in the import list that
  break the file.
  **Still holds? 7 of 8, not all — corrected.** `'forwards the per-message
  creation observer to the transport'` exercises `FeishuSendOptions`'s
  `onMessageCreated` option, which R41's outbound redesign deletes outright
  (a caller now reads the landing off `FeishuSendResult.messages` instead of
  a read-after-send observer); it is **not** restorable as written. The other
  7 cases assert nothing about `createGroup`/`inviteMembers` or
  `onMessageCreated` — those two `FakeTransport` methods exist only to
  satisfy the (then-required) `FeishuTransport` shape. Restore by dropping
  the two methods from `FakeTransport`, the four dead type names from the
  import list, and the observer-forwarding case, then restoring the
  remaining 7 cases unchanged.

- **File / case (dies on merit):** `packages/channel/feishu-transport/tests/self-identity.test.ts`
  — `test('a registration that reports no open_id leaves identity
  recoverable', ...)`.
  **Contract pinned:** the `webSocketRegistration.open()` branch of
  `openInbound()` accepts a WS-registration-reported identity through
  `FeishuSelfIdentityCache.accept()`; an app-name-only report (no `open_id`)
  is not accepted as resolved, and the next inbound message on that branch
  still retries the ordinary bot-info lookup.
  **Does not hold; changed by this item.** The branch it tests (and
  `accept()`, the method it exercises) is deleted with `webSocketRegistration`
  — there is no replacement path. The file's other 5 cases are unaffected:
  they all go through the primary route (mocked `@larksuiteoapi/node-sdk` +
  `openInbound`'s real path, per the file's own header), which this item does
  not touch, and already cover the same "no open_id is not an identity, the
  next message retries" contract on that path (`'a response without an
  open_id is not an identity and is not cached'`, `'a failed startup lookup
  is retried by the next message...'`). Not a restoration candidate.

- **File / cases (dies on merit — test exercises exactly the deleted
  methods):** `packages/channel/feishu-transport/tests/transport.test.ts` —
  `test('creates a group chat and returns chat_id', ...)`, `test('fails loud
  when chat create API is unavailable', ...)`, `test('invites members by
  open_id and returns requested ids', ...)`.
  **Contract pinned:** `createGroup`/`inviteMembers` call the Lark
  chat-create/member-invite APIs with the right shape and fail loud when the
  SDK/client lacks them.
  **Does not hold; changed by this item.** The methods themselves are deleted
  (dead API, confirmed zero production callers) — there is no replacement
  behavior. Direct cleanup: `stubClient()`'s now-unused `chatCreate`/
  `memberCreate` mocks and their `chat.create`/`chat.members.create` wiring
  are removed (only these 3 cases read them); the sibling case `'fails loud
  when the chat information API is unavailable'` (tests the kept
  `getChatMode`, via `chat.get`) is unaffected and left unedited.

- **HIGH-RISK.** **File / case (compile — excess-property check on an object
  literal, not an import break):** `packages/channel/feishu-transport/tests/transport.test.ts`
  — the whole `describe('createFeishuTransport — injected logger safety
  boundary (#74)', ...)` block (one case: `'a sentinel appSecret and message
  body never reach the injected logger'`).
  **Contract pinned:** a real `send()` + `close()` round-trip through
  `createFeishuTransport` never lets the injected `appSecret` or an outbound
  message body reach the diagnostic logger, including on a `close()` failure
  path (this test forced that path by injecting a `webSocketRegistration.close()`
  that throws, so `diag.diagnostic()`'s catch branch actually ran).
  **Still holds, but not restorable verbatim.** `FeishuTransportOptions` no
  longer has a `webSocketRegistration` field to pass a throwing `close()`
  through, so this test's specific trigger for the `close()` failure path is
  gone along with it — `wsClient` is `undefined` in this test (`start()` is
  never called), so `wsClient?.close()` is a silent no-op and the catch
  branch no longer runs. Restoring this case needs a different trigger (e.g.
  a mocked `lark.WSClient` whose `.close()` throws, reached through a real
  `start()` call) — R43 forbids writing that replacement now; log it for the
  restoration pass instead. **Update (item 10 resolved R39):** the safety
  property this case pinned is narrower than it looks with `sdkLogger` gone —
  `createFeishuTransport` no longer has any path that could hand `appSecret`
  or a message body to the injected logger through the SDK at all (the three
  SDK clients get a shared no-op logger, never `options.logger`), so the
  `close()`-failure trigger this case was built around is no longer the risk
  surface. `diagnostics.test.ts`'s remaining `connection`/`diagnostic` cases
  cover what `createFeishuTransport` does still forward to the injected
  logger (WebSocket lifecycle wording and best-effort-failure ids/errors);
  the `sdkLogger` redaction suite this paragraph used to point to is deleted
  along with the sink it tested (item 10, above), not kept "in the interim."

- **File / case (compile-adjacent — a snapshot assertion, `namedExports()`
  regex-scans `index.ts`'s literal export list, so the pinned array no longer
  matches once six names it names are gone):**
  `packages/dreamux/tests/package-boundary-guards.test.ts` — `it('feishu-transport
  index.ts exports exactly the pinned name set', ...)`.
  **Contract pinned:** the exact set of names `@excitedjs/feishu-transport`'s
  barrel re-exports, so an accidental new/removed export is caught in review.
  **Still holds?** The contract mechanism (barrel surface is intentional and
  pinned) still holds; the specific array is stale — `FEISHU_TRANSPORT_PACKAGE`,
  `FeishuCreateGroupInput`, `FeishuCreateGroupResult`, `FeishuInviteMembersInput`,
  `FeishuInviteMembersResult`, and `FeishuWebSocketRegistration` are gone from
  `index.ts` (this item). Restore in the final PR by regenerating the pinned
  array from the barrel's current export list (drop those six names; no other
  name in this array is affected by this item).

**Not part of this item's scope, checked and confirmed unaffected:**
`packages/channel/feishu-channel/tests/*` beyond `feishu-bot.test.ts` — none
references `createGroup`/`inviteMembers`/`FEISHU_TRANSPORT_PACKAGE`/
`webSocketRegistration`. `rush test`/`typecheck:tests` for
`@excitedjs/feishu-channel` and `@excitedjs/dreamux` show unrelated
pre-existing failures (the `DreamuxLogger.child` required-ness blocker from
Item 1, "Decision needed before the next item touches any of these files," a
few dozen cases across ~20 files) — none of those files were touched by this
item, and none of the failures reference any symbol this item deletes.

## Stage 2a — Item 12

R47: `service/legacy-state.ts` is deleted outright (the whole
removed-path/removed-field detection half: `LegacyStateFinding`,
`removedStatePaths()`, `detectLegacyDispatcherState()`,
`legacyDispatcherStateMessage()`, `assertNoRemovedRecordFields()`,
`pathExists()`); `LegacyStateError` relocates to `platform/errors.ts` (still
thrown by `platform/json-document-store.ts`, `scheduler/store.ts`'s
`parseCronJobFile`, and `identity-store.ts`'s surviving pre-#148
`provider_ref` check). `identity-store.ts` drops its
`assertNoRemovedRecordFields(...)` call for `checkpoint`/`checkpoint_kind`/
`session_ref`/`display_name`/`close_status`. `server.ts` drops
`assertNoLegacyDispatcherState()` (boot pre-flight + its call) and
`detectLegacyCronStores()`. `cli/doctor.ts` drops the `dispatcher ${id} legacy
state` row. Four whole test files die, all on the same mechanism: each
imports `LegacyStateError` (or a deleted export) from
`../src/service/legacy-state.js`, a path that no longer resolves — per R43's
first bullet, the whole file dies even where most of its own cases test
unrelated, still-valid behavior.

- **File:** `packages/dreamux/tests/legacy-state-fail-loud.test.ts` (whole
  file, 22 cases across 5 `describe` blocks — the file's own import at line 13
  pulls `assertNoRemovedRecordFields`, `detectLegacyDispatcherState`,
  `legacyDispatcherStateMessage`, and `LegacyStateError`, three of which have
  no replacement at any path).
  - **Dies on merit (9 cases) — contract no longer holds:**
    - `describe('legacy dispatcher-root state detection (fail-loud, never
      migrated)')` — all 4 cases (`reports no findings for a fresh dispatcher
      directory`; `detects the removed Core channel-binding store`; `detects
      the removed Core Collaboration Space state file`; `detects every
      pre-#233 flat TeamMate/Team leaf...`; `propagates a real access error
      (ENOTDIR)...`). Each calls `detectLegacyDispatcherState()` directly —
      the function is deleted, and R47 is exactly the ruling that Dreamux no
      longer probes for these leaves. **Not restorable**: the behavior these
      cases pinned is gone by design.
    - `describe('assertNoRemovedRecordFields (shared chokepoint)')` — all 3
      cases. `assertNoRemovedRecordFields()` itself is deleted; there is no
      chokepoint left to test. **Not restorable.**
    - `describe('AgentIdentityStore.read() rejects a persisted identity
      carrying a removed field')` — 1 of 8 cases: `fails loud on other
      removed fields: checkpoint, session_ref, display_name, close_status`.
      This drove `identity.json` through `AgentIdentityStore.read()` for each
      of the five fields the deleted `assertNoRemovedRecordFields` call used
      to reject; `readIdentity()` no longer rejects any of them (an unknown
      key is now silently ignored the same as any other field this schema
      never reads). **Not restorable under the current design** — restoring
      it would mean re-adding the removed-field chokepoint R47 deleted.
    - `describe('no migration path exists for any removed state shape
      (source-shape guard)')` — 1 of 3 cases: `no src file reads
      channel-bindings.json or collaboration-spaces.json for anything but
      fail-loud detection`. This absence-as-contract grep asserted every
      `src/` hit for those two literal filenames is `service/legacy-state.ts`
      (`hits.every(p => p.endsWith('src/service/legacy-state.ts'))`) **and**
      that at least one hit exists (`hits.length > 0`) — i.e. it required a
      fail-loud detector to still be naming these strings. With
      `legacy-state.ts` deleted, no `src/` file names either string any more,
      so `hits.length > 0` now fails on its own premise. **Not restorable as
      written** — the fact it asserted (a detector exists) is no longer true;
      a restoration would need to invert the assertion to "no `src/` file
      names either string at all," which is a different claim from what this
      case pinned.
  - **Still holds — restore verbatim in the final PR (13 cases), unaffected
    by this item's source change, orphaned only by the shared import break:**
    - `describe('AgentIdentityStore.read() rejects a persisted identity
      carrying a removed field')` — the other 7 cases: `accepts the current
      shape as a control`; `reads a leftover nested session object as no
      prior session, not a failure`; `treats a present-but-unusable
      session_id as an unreadable record, never as "no session"`; `tolerates
      a leftover role field`; `tolerates a leftover transcript_locator
      field`; and — still fully live, since R47 does not touch the pre-#148
      `provider_ref` check — `fails loud on a legacy provider_ref identity
      (pre-#148, before agent_runtime existed)`.
    - `describe('CronJobStore rejects the removed cron deliver/spawn-teammate
      shapes')` — all 4 cases (`accepts a current prompt-agent job as a
      control`; `fails loud on a job carrying the removed deliver field`;
      `fails loud on the removed spawn-teammate action kind`;
      `assertCurrent() surfaces the same fail-loud verdict used by the
      startup doctor path`). `scheduler/store.ts`'s own `deliver`/
      `spawn-teammate` rejection and `detectLegacyCronJobStore` are untouched
      by this item — only their `LegacyStateError` import path moved.
    - `describe('no migration path exists for any removed state shape
      (source-shape guard)')` — the other 2 cases: `no src file spells the
      retired team_member role vocabulary`; `no src file re-derives Core
      binding/target_key/binding_fallbacks state`. Neither names
      `legacy-state.ts` or either deleted export.
  - Restoring the "still holds" half needs each case moved to a file that
    imports `LegacyStateError` from `../src/platform/errors.js` (the cron
    describe can move into `scheduler-cron.test.ts`'s restoration below,
    since it already exercises `CronJobStore`; the identity describe's
    surviving 7 cases can move into a plain `identity-store.test.ts` file
    alongside whatever already covers that store, since there is no
    remaining reason for it to live in a file named `*-legacy-state-*`).

- **File:** `packages/dreamux/tests/team-read-legacy-state.test.ts` (whole
  file — the remaining 4 of the file's original 5 cases; Item 2 already
  removed the 5th, `raises a legacy leader record through list, history, and
  status`, as `buildTeamCollectionHarness` collateral, and forward-referenced
  this item as the point the rest of the file would go — see that item's
  entry above). The file's line-8 import (`LegacyStateError` from
  `../src/service/legacy-state.js`) is the whole-file failure point.
  - **Dies on merit (1 case):** `raises a leader record carrying a removed
    field the same way` — plants a leader identity with `session_ref` and
    asserts `TeamCollectionReadModel.summary()` rejects with
    `LegacyStateError`, driven entirely by the now-deleted
    `assertNoRemovedRecordFields` call in `identity-store.ts`. **Not
    restorable under the current design**, same reasoning as
    `legacy-state-fail-loud.test.ts`'s equivalent case above.
  - **Still holds — restore verbatim (3 cases):** `projects a leader carrying
    a leftover role field normally`; `still reports an ordinary unreadable
    leader as no leader state`; `keeps the response shape of a valid leader
    record`. None of these three plants a removed field; they exercise
    `TeamCollectionReadModel` through the same local `plantLeader()` fixture,
    independent of `buildTeamCollectionHarness` and of the deleted chokepoint.

- **File:** `packages/dreamux/tests/scheduler-cron.test.ts` (whole file, 20
  cases — the file's line-19 import of `LegacyStateError` from
  `../src/service/legacy-state.js` is the sole failure point; every case's
  own contract is untouched by this item).
  - **Still holds — restore verbatim (all 20 cases)** with the import path
    updated to `../src/platform/errors.js`: `cron job store` schema
    fail-loud (2 of these call `LegacyStateError` directly — `rejects a
    persisted job carrying the removed spawn-teammate action kind`, `rejects
    a persisted job carrying the removed top-level deliver field` — and both
    still hold, since `scheduler/store.ts`'s own rejection logic is
    unchanged by this item), `SchedulerService.create` payload validation,
    timer-generation (stopped-timer, durable revalidation, no missed-fire
    replay), immediate fire/fold and no-serialization, pre-admission
    failure/ambiguous-admission semantics, and store-deletion ordering
    (Team-dissolve side of the scheduler).

- **File:** `packages/dreamux/tests/removed-surfaces.test.ts` (whole file —
  the file's line-31 import of `LegacyStateError` from
  `../src/service/legacy-state.js` is the failure point).
  - **Dies on merit (2 cases; the plan that scoped this item named only the
    second of these — the first is an additional finding from reading the
    file in full for this entry):**
    - `the identity-store removed-field rejection list still names every
      shape whose loss would be silent` — a source-text pin that reads
      `identity-store.ts` and asserts it still contains the string literals
      `'checkpoint'`, `'checkpoint_kind'`, `'session_ref'`, `'display_name'`,
      `'close_status'`. Those literals are gone from the file along with the
      `assertNoRemovedRecordFields(...)` call this item deletes. **Not
      restorable under the current design** — the list it pinned no longer
      exists.
    - `AgentIdentityStore.read() fails loud with LegacyStateError on a
      persisted "session_ref" field (behavioral, not just a shape pin)` —
      the companion behavioral case; same reasoning. **Not restorable under
      the current design.** This case was already separately flagged under
      Item 1's Driver C list (`typecheck:tests`-only, `noopLog` missing
      `.child`) as one of the ~290 cases left pending a decision; whole-file
      deletion here closes that line item out for this file specifically —
      it is no longer part of Driver C's outstanding inventory, for an
      unrelated reason (the file itself no longer exists).
  - **Still holds — restore verbatim (the rest of the file, ~20 cases):**
    `deleted files stay deleted` (5 paths); `deleted identifiers stay absent
    from every package src` (16 banned-token/pattern cases, comment-stripped,
    covering `waitIdle`/`channelInput`/`getCheckpoint`/... through the
    Feishu saga/phase/outbox/recovery-cursor scan); `the Core Collaboration
    Space domain is fully absent` (3 cases); `deleted Team MCP tool names
    stay absent` (5 cases); and `neutral contract shapes stay minimal` (4
    structural cases on `AgentRuntime`/`ChannelSession`). None of these
    names `legacy-state.ts`, `LegacyStateError`, or any export this item
    touches.

**Verification:** `node common/scripts/install-run-rush.js build --to
@excitedjs/dreamux` passes. `npx vitest run` inside `packages/dreamux`
(not the full `rush test`) passes 971 of 971 registered tests across the
other 67 test files; the one failing file,
`packages/dreamux/tests/codex-live.test.ts`, is pre-existing Item 1
collateral unrelated to this item — see the correction note appended to
Item 1's section above. `.agents/scripts/check.sh` passes.

**Docs rewritten in this item, and one scope note:**
`packages/dreamux/src/service/CLAUDE.md` (root-helpers list, the "old state
fails loud" and "reject a removed field" invariants merged into one revised
paragraph), `packages/dreamux/CLAUDE.md` (the `service/agent-entity/` row —
the plan's own text guessed this needed no edit; it did, at line 39),
`.agents/domains/state-config-and-files.md` (the "Removed Local Layouts"
paragraph, both "Source:" lists, and the "removed-field rule under
*Invariants*" cross-reference in the 0.x Upgrade Policy section — that
sentence pointed at the very paragraph this item rewrote, so it needed its
own rewrite even though the plan only named the "Source:" lists).
`packages/dreamux/skills/dispatcher/dreamux-maintenance/references/
service-lifecycle.md` was checked for `checkpoint`/`session_ref`/
`checkpoint_kind`/`collaboration-spaces.json`/`channel-bindings.json`/
`removed field`/`legacy` and confirmed to contain none of this item's
deleted mechanism (its one `legacy` hit, on `turn.jsonl`, is a different,
untouched inert-residue policy) — no edit, and none added, since this
reference is current-state-only and a historical leaf-name list would
violate that. `.agents/domains/channel.md` was edited beyond the plan's
named scope (two "Source:" lists and one paragraph of prose, `~880-887` and
`~1104`) — its prose asserted "Core's own removed routing state is
detected, not read: `channel-bindings.json`/`collaboration-spaces.json` ...
fail loud as old state," which this item makes false; left unedited it would
have been a KB claim about a deleted mechanism, not just a stale citation.
`service-topology.md:27` and `scheduled-work.md:41` were checked and left
alone — both describe mechanisms this item does not touch (the surviving
`provider_ref` check; `detectLegacyCronJobStore`, kept as-is). Root
`CLAUDE.md`'s "Changelog Responsibility" section was checked and does not
depend on this mechanism specifically — left untouched.

## Stage 2a — Item 14

`platform/paths.ts`'s module-level `currentConfig` global and
`setRuntimeConfig()`/`resetRuntimeConfig()`/`getRuntimeConfig()` are deleted
outright (`getRuntimeConfig()` had zero production callers anywhere in
`src/`; `currentConfig` was read only by `getRuntimeConfig()`). The 5
production `setRuntimeConfig(...)` call sites — `server.ts` (constructor),
`cli/doctor.ts` (`runDreamuxDoctor`), `onboard/run.ts` (×2), `daemon/install.ts`
(`daemonInstall`) — wrote a value nothing in production ever read; each call
site and its now-unused import of `setRuntimeConfig` is deleted along with
the module. No new owner: this was a fully inert mechanism end to end, not a
relocation.

**Re-verification against the plan's snapshot (per this item's own
instruction to re-grep `packages/dreamux/tests/` immediately before
executing, not from the plan's snapshot):** the plan named 9 collateral test
files. Re-running `grep -rln RuntimeConfig packages/dreamux/tests/`
immediately before this item's edits found only 6 — 3 of the plan's 9 had
already stopped referencing the trio, for reasons independent of this item:

- `commands.test.ts` and `dispatcher-plugin-hooks.test.ts`: their only usage
  was a `previousConfig = getRuntimeConfig(); ...; setRuntimeConfig(previousConfig);`
  save/restore pair inside a shared fixture (`createChannelListServer()` /
  `buildRealServer()` respectively). Stage 2a Item 14's plan predicted exactly
  this shape (confirmed in full for `commands.test.ts`'s usage: the global was
  saved and restored around a `Server` built directly from a passed `config`
  object, never actually consulted by the code under test) — but by the time
  this item runs, Item 14's plan is moot for these two files: Stage 2a Item 6
  had already deleted both fixtures wholesale, along with the cases that used
  them, for an unrelated reason (the fixtures built a `DispatcherConfig`
  carrying the now-deleted `.runtime` field — see Item 6's section above). The
  RuntimeConfig save/restore boilerplate went with its fixture as a side
  effect of that unrelated deletion; both files still exist, still compile,
  and still pass, each carrying a comment pointing at Item 6's ledger entry.
- `teammate-completion-lifecycle.test.ts`: deleted outright by Item 6, same
  section, same reason (its shared `createHost()` fixture also carried the
  save/restore pair alongside the now-deleted `.runtime` field).

None of these three needs any action here — deleting the trio from
`platform/paths.ts` does not touch them, since none of them imports it any
more. This narrows this item's own whole-file deletions from the plan's 9 to
the 6 below. A repo-wide `grep -rln "setRuntimeConfig\|resetRuntimeConfig\|getRuntimeConfig"`
(all `.ts`, all packages, immediately after this item's source edits) returns
nothing — no file anywhere still imports any of the three.

**The 6 confirmed files, all whole-file (R43's first bullet — the import of a
deleted export fails module resolution, not a scoped fixture mismatch):**
every occurrence of `resetRuntimeConfig`/`setRuntimeConfig` in each file below
sits inside a `beforeEach`/`afterEach` hook line, never inside an assertion or
the code path under test — confirmed by reading every match's line number and
surrounding context before deleting. None of the 6 was touched by any earlier
item in this stage (confirmed: none appears anywhere else in this ledger's
Stage 2a sections, except `onboard.test.ts`, noted below), so each file's
content is exactly its state on the harness-preparation commit this stage's
work is stacked on, with that one exception.

- **File:** `packages/dreamux/tests/daemon.test.ts` (whole file, 29 cases
  across `describe('daemon service control')`, `'daemon uninstall
  (service-only)'`, `'managed service working directory ownership'`, `'daemon
  install (stable service Node, issue #83)'`, `'buildServicePath ordering and
  deduplication'`, `'userLocalBinDirs and systemExecDirs'`,
  `'withUserLocalBinPath'`, `'withServicePath does not mutate process.env or
  the input env'`, `'provider binary resolution from captured session PATH'`,
  `'captured session PATH appears in systemd and launchd service config'`,
  `'re-running daemon install refreshes the persisted service PATH'`, `'normal
  CLI invocation captures ambient process.env PATH'`, `'daemon install
  resolves bare provider bins and includes them in the service PATH'`).
  **Contract pinned:** the `dreamux daemon install`/`uninstall` pipeline —
  service-unit generation, working-directory ownership, and provider-bin PATH
  capture/resolution/persistence across install/reinstall, including the
  systemd/launchd unit content those PATHs land in.
  **Contract survives unchanged; restore verbatim in the final PR** — only
  this file's incidental `resetRuntimeConfig()` `afterEach` boilerplate (6
  call sites, none read by any assertion) died with the module it imported
  from.

- **File:** `packages/dreamux/tests/onboard.test.ts` (whole file, 18 cases
  under `describe('dreamux onboard')`; one of them, `'onboard output
  round-trips through loadConfig (#148)'`, already had its two
  `.runtime`-shaped assertions removed by Stage 2a Item 6 — logged above; that
  edit is independent of and unaffected by this item).
  **Contract pinned:** the `dreamux onboard` flow — collects answers, writes
  config/state/service files (dry-run and real), round-trips the written
  config through `loadConfig`, and reports provider-bin/service diagnostics.
  **Contract survives unchanged; restore verbatim in the final PR** (i.e., in
  the state Item 6 already left it in) — only this file's incidental
  `resetRuntimeConfig()` call (1 site) died with the module it imported from.
  **PR #455 review round correction: "verbatim" needs two more import
  fixes.** This file also imports `type { ServiceNodeProbe } from
  '../src/onboard/service.js'` and `CommandRunner` (alongside the
  still-valid `OnboardAnswers`/`OnboardChannelConfig`) from
  `'../src/onboard/types.js'`. Stage 5 ("Plan Stage 5 leaf layering: platform,
  command, config, utils") later deleted `onboard/service.ts` outright,
  moving `ServiceNodeProbe` to `daemon/environment.ts` (confirmed at head,
  `daemon/environment.ts:85`), and moved `CommandRunner`/`ExecaCommandRunner`
  out of `onboard/` into `platform/command-runner.ts` (confirmed at head,
  `platform/command-runner.ts:9`/`:45`) — `onboard/types.ts` no longer
  declares `CommandRunner` at all. Restoring this file needs both imports
  moved, not just the `resetRuntimeConfig()` removal.

- **File:** `packages/dreamux/tests/uninstall.test.ts` (whole file, 4 cases
  under `describe('dreamux uninstall')`).
  **Contract pinned:** the top-level `dreamux uninstall` guard — what it
  removes (service unit) versus refuses to touch (config/state/logs), and its
  confirmation/dry-run behavior.
  **Contract survives unchanged; restore verbatim in the final PR** — only
  this file's incidental `resetRuntimeConfig()` `afterEach` (1 call site)
  died with the module it imported from.
  **PR #455 review round correction: "verbatim" needs one more import fix.**
  This file also imports `type { CommandRunner } from '../src/onboard/types.js'`;
  Stage 5 later moved `CommandRunner`/`ExecaCommandRunner` out of `onboard/`
  into `platform/command-runner.ts` (confirmed at head,
  `platform/command-runner.ts:9`/`:45`). Restoring this file needs that
  import moved too.

- **File:** `packages/dreamux/tests/doctor-plugins.test.ts` (whole file, 5
  cases under `describe('pluginDoctorChecks')` and `'runDreamuxDoctor plugin
  wiring'` — one originally-present case in the latter describe was already
  deleted in an earlier, pre-Stage-2a PR-0 pass, logged near the top of this
  ledger; that removal already predates this stage's harness-preparation
  commit, so this item's 5-case count is current, not stale).
  **Contract pinned:** `pluginDoctorChecks`'s per-plugin `dreamux doctor` row
  shape, and `runDreamuxDoctor`'s plugin-wiring rows (load success/failure
  reporting, the run continuing after a load failure).
  **Contract survives unchanged; restore verbatim in the final PR** — only
  this file's incidental `resetRuntimeConfig()` call (1 site) died with the
  module it imported from.
  **PR #455 review round correction: "verbatim" needs one more import fix,
  same as `uninstall.test.ts` above.** This file also imports
  `type { CommandRunner } from '../src/onboard/types.js'`, which Stage 5
  moved to `platform/command-runner.ts`; restoring needs that import moved
  too.

- **File:** `packages/dreamux/tests/runtime-sockets.test.ts` (whole file, 8
  cases under `describe('runtime socket allocation')`).
  **Contract pinned:** volatile runtime rendezvous socket path allocation —
  the `platform/runtime-sockets.ts` contract root `CLAUDE.md`'s path-contracts
  rule names.
  **Contract survives unchanged; restore verbatim in the final PR** — only
  this file's incidental `resetRuntimeConfig()` `afterEach` (3 call sites)
  died with the module it imported from.

- **File:** `packages/dreamux/tests/dispatcher-codex-home.test.ts` (whole
  file, 12 cases under `describe('global Codex home doctor')`).
  **Contract pinned:** `dreamux doctor`'s Codex-home resolution/diagnostic
  rows.
  **Contract survives unchanged; restore verbatim in the final PR** — only
  this file's incidental `setRuntimeConfig(BUILT_IN_DEFAULTS)`/
  `resetRuntimeConfig()` `beforeEach`/`afterEach` pair (2 call sites) died
  with the module it imported from.

**Not touched, confirmed:** `packages/dreamux/tests/codex-live.test.ts` (the
standing issue #63 live gate) does not reference the trio and is unaffected
by this item.

**Verification:** `node common/scripts/install-run-rush.js build --to
@excitedjs/dreamux` passes. `npx tsc -p tsconfig.tests.json` (scoped
`typecheck:tests`) inside `packages/dreamux` reports exactly one error,
`tests/helpers/event-harness.ts(48,9)`, `.child` missing on a stub logger —
this is Item 1's pre-existing, still-parked Driver C item (see Item 6's
"Driver C ... status after this item" note above), unrelated to this item's
change and not newly introduced by it. A repo-wide grep for the three deleted
export names, after this item's edits, returns nothing.

**Docs:** none — the item's own plan named no doc surface, and none was
found referencing `setRuntimeConfig`/`getRuntimeConfig`/`resetRuntimeConfig`
by name outside `packages/dreamux/src/` and `packages/dreamux/tests/` (the
mechanism's only outside mentions are in
`.agents/tasks/architecture/add-runtime-config-commands/technical-design/`,
which is a historical design-proposal record for a separate, not-yet-built
task, not a current-state doc this item owns).

## Stage 2a — gate round 1 (Driver C resolution)

Gate round 1 (build/lint/typecheck:tests/test/check.sh) for Stage 2a. One
blocker carried in from Item 1: **Driver C — `DreamuxLogger.child`
required-ness** — parked at the end of Item 1's own section above as "no file
deleted or edited for this driver... decision needed before the next item
touches any of these files." That decision is made here, since this round
cannot reach a green `typecheck:tests` otherwise.

**Decision: option (i), delete the collateral per R43.** Option (ii) (revert
`DreamuxLogger.child` to optional, restore the three `log.child?.(...) ??
log` production fallbacks) was rejected: those fallbacks would exist to serve
a test stub, never a real caller — every real `DreamuxLogger` is Core's pino
instance (or a child of it), which always has `.child`. Confirmed this
session: `grep -rn "as DreamuxLogger\|: DreamuxLogger = \|silentLogger\|consoleFallbackLogger\|noopLog\b" packages/*/src packages/*/*/src`
returns exactly one hit, `platform/logger.ts`'s own
`const _pinoSatisfiesContract: DreamuxLogger = pino();` compile-time contract
check — no production literal anywhere lacks `.child`. Adding a production
fallback for a scenario that cannot occur in production is exactly the
"defense with no named failure scenario" root `CLAUDE.md` bans, so (ii) is
out; (i) is the only remaining option, and matches how this ledger already
treated every other required-ness collateral in this stage.

Applying (i) mechanically required, per file, checking which cases actually
route (directly or through a shared fixture/harness function) to a
`.child`-missing stub logger, since several of the parked files mix tainted
and untainted cases in the same `describe`. A case that never constructs a
`DreamuxLogger` through the tainted stub is untouched.

### feishu-channel (Item 1's own parked list, "twelve-plus" files)

Six files were 100% tainted (every case routes through a module-level stub
logger or the one session/tool-session factory the whole file is built
around) and are deleted whole, per R43's first bullet extended to a shared
helper with zero surviving reachers:

- `tests/feishu-channel-session.test.ts` (15 cases, `newSession()`/
  `provisioningSession()` → module-level `silentLog`).
- `tests/feishu-cot-delivery.test.ts` (12 cases, `harness()`/`newSession()` →
  `silentLog`).
- `tests/feishu-cot.test.ts` (28 cases across 7 `describe`s, `harness()` and
  `seamHarness()` (the latter not on Item 1's original file-name list — found
  this session; same `silentLog` root) → `silentLog`).
- `tests/feishu-document-comments.test.ts` (38 cases, `harness()` →
  `recordingLogger()`, itself building a `DreamuxLogger`-typed object missing
  `.child`).
- `tests/feishu-provisioning.test.ts` (15 cases, `harness()` → `silentLog`).
- `tests/feishu-target-router.test.ts` (3 cases, `router()` → module-level
  `silent`).

**Contract pinned by each, and whether it still holds:** every one of these
six files pins real, still-true production behavior (session/COT/routing/
document-comment/provisioning/target-routing contracts — see each file's own
top-of-file doc comment, left in git history) — none of it changed. The
`.child` requirement never reaches these paths at runtime (nothing under
test ever calls `.child`); the failure is `typecheck:tests`-only.
**Restore in the final PR** by giving each stub logger (`silentLog`/`silent`/
`recordingLogger()`'s returned object) a `child: () => <self>` member and
otherwise restoring the file verbatim — not a behavioral fix, a fixture fix.

Seven files had a real mix of tainted and untainted cases; only the tainted
cases (and, where a case's fixture/helper had no other reacher, the helper
itself) were deleted, each file's surviving cases and imports otherwise
unchanged:

- `tests/feishu-document-tools.test.ts`: 6 of 8 cases deleted (three
  `describe`s built on `fakeSession()`, all reached only by "subscribe/
  unsubscribe/list_subscriptions derives its recipient" cases); the 2
  surviving cases (`describe('the document tools are one definition for both
  callers')`) never touch a session at all. `fakeSession()`, `ctx()`, the
  `dispatcher`/`teamLeader` consts, and their now-unused imports
  (`ChannelMcpCaller`, `FeishuDocumentSubscriptionView`, `FeishuToolContext`/
  `FeishuToolSession`) went with the deleted cases.
- `tests/feishu-space-tools.test.ts`: 7 of 8 cases deleted (every case except
  `'none of the four tools are ever offered to a TeamLeader'`, which reads
  only `def.callers` off the static tool definitions). Same collateral
  cleanup: `fakeSession()`, `space()`, `ctx()`, the caller consts, and their
  now-unused imports (`ChannelMcpCaller`, `FeishuSpaceRecord`,
  `FeishuToolContext`/`FeishuToolSession`).
- `tests/feishu-routing-tools.test.ts`: 16 of 22 cases deleted. Two describes
  (`bind_channel`, `unbind_channel`) kept only their schema/`callers`-shape
  cases (3 of 7) and lost every case that calls `fakeSession()`/`ctx()`
  directly; the `list_bindings` describe kept only its two pure-schema cases
  (`rejects a target_kind...`, `advertises the four filters as optional`) and
  lost every case reached through the `matched()` helper (which wraps
  `fakeSession()` — a one-hop indirection this session's first taint-scan
  pass missed and had to redo with `matched` added to the traced-identifier
  set); the whole trailing `describe.each([dispatcher, teamLeader])('$kind
  binding receipts', ...)` block (4 cases × 2 caller kinds) died, since every
  case in it calls `mcpFor(fakeSession())`. `fakeSession()`, `ctx()`,
  `mcpFor()`, `matched()`, the `rows`/`row()` list-bindings fixture, both
  caller consts, and their now-dead imports (`ChannelMcpCaller`,
  `FeishuChannelSession`, `createFeishuSessionMcp`, `FeishuBindingView`,
  `FeishuTarget`, `FeishuToolContext`/`FeishuToolSession`) went with them.
- `tests/feishu-reply-tool.test.ts`: 3 of 5 cases deleted (`describe('replying
  through the MCP capability')` (2 cases) and `describe('the pairing resend
  reminder')` (1 case), all built on `session()`/`recordingLog()`); the 2
  surviving cases (`describe('the reply tool contract')`) only read
  `findFeishuTool(...)`'s static schema. All of `recordingLog()`, `session()`,
  `refusingBot()`, `inertPort()`, the `AUDIT_REFUSAL` fixture, `caller`, temp-dir
  `beforeEach`/`afterEach`, and their now-dead imports went with them.
- `tests/feishu-slash-commands.test.ts`: 12 of 32 cases deleted — the whole
  `describe('Feishu slash command routing side effects')` (2 cases, an
  `it.each` this session's first pass also missed: its array argument spans
  multiple source lines, which the first regex-based case-block scanner
  (matching `.each\(...\)` only on one line) silently skipped, redone with a
  brace-matching scanner) and `describe('Feishu slash command inbound
  placement')` (2 cases, one of them also a multi-line `it.each` the first
  pass missed) — both built on inline `new FeishuChannelSession({..., log:
  silentLog, ...})`; and the whole `describe('/bind through ordinary Feishu
  inbound')` (8 cases, `bindHarness()` → `silentLog`). The 20 surviving cases
  (`describe('Feishu slash command recognition')`, all pure `detect()`
  parsing, and `describe('Feishu slash command dispatch')`, all pure
  `dispatch()` calls with no session/logger) are untouched. `silentLog`, the
  `tempDirs`/`afterEach` cleanup it existed to serve, `bindHarness()`, and
  their now-dead imports (`mkdtempSync`/`rmSync`/`tmpdir`/`join`,
  `ChannelCorePort`/`ChannelCoreEvent`/`ChannelEventSubscription`/
  `DreamuxLogger`, `FeishuChannelSession`, `trustIntroducedBots`,
  `defaultDispatcherAccessState`/`saveDispatcherAccess`, `topicTarget`/
  `FeishuTarget`, `bindChannelDef`, `createFakeFeishuBot`,
  `createFakeCotClient`, `teamSummary`) went with them. The
  `NUMERIC_LOOKING_TEAM_NAMES` fixture survives (still read by the
  recognition describe's `it.each`); its doc comment's claim that "the
  end-to-end bind test" also reads it no longer holds (that test is deleted)
  and was corrected.
- `tests/feishu-space-policy.test.ts`: 3 of 5 cases deleted
  (`describe('Provisioning snapshot immutability')`, 2 cases, and
  `describe('unbindSpace — stops future provisioning only')`, 1 case, all
  constructing `new FeishuProvisioning({ ..., log: silentLog, ... })`). The 2
  surviving cases (`describe('bindSpace — generation advances only on
  creation-fact changes')`) only call `routing.bindSpace()`, never
  `silentLog`. `silentLog`, `submission()`, `FeishuProvisioning`, and their
  now-dead imports (`DreamuxLogger`, `JsonValue`, `FeishuSubmitOutcome`,
  `topicTarget`) went with them.
- `tests/feishu-extensions.test.ts`: 27 of 28 cases deleted — every case
  except `'is a zero-argument default factory named feishu whose api is typed
  for other plugins'`, which calls only `feishuPluginFactory()` and a
  type-level `expectTypeOf` assertion, touching no session, no `loadFeishu()`
  (→ `silentLog`), and no `recordingLog()`. `loadFeishu()`, `recordingLog()`,
  `createSession()`, `silentLog`, every other helper/fixture the deleted
  cases used, and their now-dead imports went with them.

**Contract pinned by each partially-deleted file, and whether it still
holds:** every deleted case's contract is unchanged in source (document-tool/
space-tool/routing-tool authorization and derivation, the reply tool's
send/refusal/pairing-reminder behavior, slash-command routing side effects
and inbound placement, Collaboration Space provisioning-snapshot immutability,
and the Feishu extension registry/lifecycle/tool-catalog/card-action
contracts) — **restore in the final PR** the same way as the six whole-file
deletions: give the file's stub logger(s) a `child: () => <self>` member and
restore the deleted cases/helpers/imports verbatim.

**One real regression found and fixed in source, not test collateral:**
`feishu-channel/src/provider.ts`'s `state_root` guard. Item 1 narrowed
`if (typeof stateDir !== 'string' || stateDir === '')` to `if (stateDir ===
'')` on the stated premise that the `typeof` half was now a type-level
tautology (`state_root` is required). That premise holds for a well-typed
caller, but `tests/feishu-provider-state-root.test.ts`'s first case
(`'refuses to create a session when the host supplied no state_root'`) builds
its context via `as ChannelSessionCreateContext<...>`, deliberately bypassing
the type system to prove the *runtime* guard a host that forgets the field
still gets a named error rather than a raw `path.join` `TypeError` — exactly
the scenario the file's own doc comment names ("There is deliberately no
default... a missing or empty `state_root` is refused at construction,
loudly, rather than absorbed"). This is a real, named-scenario guard (a host
implementation that does not itself type-check, e.g. a JS-authored
`ChannelProvider`), not the P3 pattern R28 targets. Fixed by merging both
conditions into one falsy check (`if (!stateDir)`) — the existing error
message already covers both regex assertions the file's two cases check, so
one check now serves both, which is a simplification, not new defense.
Verified: both cases in `feishu-provider-state-root.test.ts` pass.

### dreamux (Item 1's own parked list, remainder)

- `tests/cot-projection-privacy.test.ts` (whole file, 26 `it`/`it.each`
  blocks, all routing through the file's own `harness()` → shared
  `createCapturingLogger()`): deleted whole. **Contract pinned:** the COT
  card's redaction/truncation half of the conversation projection (this
  file's own docstring; `tests/core-event-catalog.test.ts` owns "everything
  else about the catalog," per that file's own docstring, and is unaffected).
  **Contract survives unchanged; restore in the final PR** — give
  `createCapturingLogger()` a `.child` (already done here, see below) and
  restore the file verbatim.
- `tests/core-event-catalog.test.ts`: 20 of 35 cases deleted.
  `describe('DispatcherCoreEventBus: live, best-effort delivery')` (9 cases,
  a per-describe `makeBus()` → `createCapturingLogger()`) and
  `describe('DispatcherCoreEventBus: subscription lifecycle')` (8 cases, a
  second, same-named `makeBus()` in its own describe scope, same root) are
  fully deleted; `describe('display fact correlation')` (4 cases, each
  building `createConversationProjection({ ..., log:
  createCapturingLogger().logger, ... })` inline) is fully deleted; one case
  each in `describe('teammate.state covers every Agent entity kind...')`
  (`'a standalone (dispatcher-scoped) TeamMate uses the exact same
  durable-then-publish hook...'`) and `describe('team.state is the redundant
  Team aggregate')` (`'is republished by TeamRosterProjection when a
  contained TeamMate is created or changes state...'`) are deleted, each the
  only case in its describe reaching `createCapturingLogger()` directly (the
  former) or `makeIdentity()` (the latter, itself only used by that one
  deleted case — deleted with it, see below). The 15 surviving cases (the
  whole `describe('the published Core event catalog is exactly four kinds')`,
  4 of 6 `describe('teammate.state...')` cases, 3 of 4
  `describe('team.state...')` cases, and the whole `describe('activity from a
  revoked runtime generation...')`) never construct a `DreamuxLogger` through
  the tainted stub. `DispatcherCoreEventBus`, `createConversationProjection`/
  `ProjectedAgent`, `TeamRosterProjection`, `AgentEntityCollectionStore`, and
  their imports are now unused by this file and were removed; `sealChannelCoreEvent`,
  `TeamStore`, `AgentRuntimeStateStore`, `createCapturingPublisher`,
  `makeIdentityCreateInput`, `makeIdentityStore`, `makeTempDir`,
  `removeTempDir` are all still used by surviving cases and were kept. The
  file's own top-of-file doc comment, which claimed ownership of the bus's
  delivery/subscription-lifecycle guarantees and turn-event correlation, was
  corrected to say what the file currently covers and points at this ledger
  entry for the rest. **Contract pinned by every deleted case: unchanged in
  source** (best-effort live delivery ordering/fault-isolation, subscription
  revoke/unsubscribe semantics, the `hasSources`/no-replay-surface
  guarantees, the standalone-TeamMate publish wiring, and
  `TeamRosterProjection`'s teammate.state-before-team.state republish
  ordering) — **restore in the final PR** the same way as feishu-channel's
  collateral above.
- `tests/helpers/event-harness.ts`: **not deleted, fixed** — unlike every
  other Driver C site, `createCapturingLogger()` is load-bearing for cases
  that have nothing to do with `.child`: `makeIdentityStore()` (line ~139)
  defaults its `log` parameter to `createCapturingLogger().logger`, and
  `makeIdentityStore()` is the real `AgentIdentityStore` fixture builder
  every surviving `describe('teammate.state...')` case in
  `core-event-catalog.test.ts` calls. Deleting `createCapturingLogger()` (the
  mechanical R43 outcome for a stub with zero remaining direct callers) would
  have cascade-deleted five clean, unrelated, currently-passing cases that
  assert nothing about logging at all — collateral far outside Driver C's
  actual scope, and no plan or ruling asks for that capability to be removed.
  This is not "editing a test to make it pass": `event-harness.ts` is a
  shared fixture helper with zero assertions of its own, not a test file
  pinning behavior, and the fix is exactly the same one already applied to
  claude-code's `consoleFallbackLogger` in this same item (add a `.child`
  that returns itself; bindings are dropped, since nothing here asserts on a
  child logger's own scoped fields, only on which bucket a call landed in).
  `makeIdentity()` (the in-memory `AgentEntityIdentity` builder, a separate
  export with no `.child` involvement of its own) lost every one of its
  callers when this item's other deletions landed (all were inside the
  deleted `core-event-catalog.test.ts` cases and the deleted
  `cot-projection-privacy.test.ts`) and was deleted as ordinary dead code,
  not Driver C collateral — it has zero remaining reachers anywhere in the
  package.

### The issue #63 live gate — additional fix, HIGH-RISK

`tests/codex-live.test.ts` is the standing high-risk entry (see the top of
this file). Item 1 had already trimmed its behavioral case to the skip/
fail-loud shell (logged above, under Item 1). Verifying this round's
`rush test` surfaced a second, independent defect in what Item 1 left behind:
with `codex` on `PATH` and `DREAMUX_SKIP_LIVE_CODEX` unset — the normal case
on any workstation or CI runner with Codex installed, reproduced this session
(`codex-cli 0.156.1` on `PATH`) — the `describe('codex live integration',
...)` shell's two branches (`it.skip` under the skip env var, `it('requires
codex on PATH', ...)` under detection-missing) both require a condition that
does not hold, so the `describe` registers zero `it`s. Vitest reports that as
`Error: No test found in suite codex live integration` and fails the file.
This is a structural defect in Item 1's trim, not a new contract this round
changed, but R43 gives the file no exception once observed failing: **deleted
the empty `describe('codex live integration', ...)` shell** (the skip/
fail-loud gate logic, `detectCodex()`, and the `execSync` import it alone
used), **kept** the whole `describe('codex detection logic')` (3 cases,
`classifyDetection`/`versionAtLeast` — pure unit coverage with no live-codex
dependency, unaffected by either defect). `SKIP_ENV`/`MODEL_GATE_ENV` (only
ever referenced within the deleted shell) were removed as dead exports.
**Contract pinned: unchanged, still owed.** The file's own banner already
named the priority restoration (issue #63 non-blocking-inbound, folding a
second submit into a running turn, live init handshake, live Feishu MCP
surface) as owed from Item 1; this round's deletion removes only the
already-emptied wrapper shell around that owed restoration, not the
restoration itself. The final test completion on PR #453 must rebuild the
skip/fail-loud gate around the restored behavioral case with a shape that
cannot register zero tests (e.g. an explicit `it('codex is available',
...)` case on the detected-and-not-skipped path, rather than an `if` with no
`else`), not reintroduce this round's zero-registration shape verbatim.

**Verification this round:** `node common/scripts/install-run-rush.js build`,
`lint`, `typecheck:tests`, and `test` all report `SUCCESS`/`SUCCESS WITH
WARNINGS` (the warnings are expected stderr capture from tests that assert on
logged output, not failures) across all 9 operations, with `codex` present on
`PATH` and no live-codex env var set. `.agents/scripts/check.sh` is clean
after also fixing two pre-existing KB issues this round's check run
surfaced, unrelated to Driver C: a stale `packages/dreamux/tests/helpers/fake-feishu-bot.ts`
path citation in `domains/repository-operations-and-release.md` (the double
moved to `packages/channel/feishu-channel/tests/helpers/` when Item 1 deleted
dreamux's own copy; corrected to the current path) and two bare commit-hash
citations in this ledger's own Item-14 section (rephrased to describe the
harness-preparation commit without naming its hash, per the KB's no-commit-hash
rule for `.agents/tasks/`).

## Stage 3 — Item 2 (formatter reformat)

R2: `prettier --write` applied per package (root `.prettierrc.json`, one key:
`singleQuote: true`, everything else default — see rulings.md's R2 entry). No
logic changed; two source-text pattern-match cases broke because the
declarations they regex-match wrapped across multiple lines under the
80-column default `printWidth`.

- **File / cases:** `packages/dreamux/tests/collection-ownership.test.ts`,
  describe block `Collections own the store, the factory, and the
  materialization cache; Services do not duplicate it` —
  `it('TeamCollection (runtime-registry.ts) is the sole holder of the live
  TeamService cache and its construction dedupe')` and
  `it('TeammateCollection (index.ts) is the sole holder of the live
  TeammateService cache and its materialization dedupe')` (2 cases; each
  case's other assertions in the same block still passed, but a `toMatch`
  failure fails the whole `it`, so the whole case is what R43 calls a
  "failing test case").
  **Contract pinned:** TeamCollection's `runtime-registry.ts` declares
  `private readonly cache = new Map<string, TeamService>` and
  `private readonly constructing = new Map<string, Promise<TeamService |
  null>>` (the live-instance cache and the construction-dedupe map);
  TeammateCollection's `index.ts` declares `private readonly entities = new
  Map<string, TeammateService>`, the `type ResolvedTeamMate = TeammateService
  | AgentEntityIdentity` union, and `private readonly materializations = new
  Map<string, Promise<ResolvedTeamMate>>` (the live-instance cache and the
  materialization-dedupe map) — proof that a Collection, not its Service,
  owns both caches.
  **Still holds — restore at final #453 test pass.** Both declarations are
  still present and unchanged in meaning; only their line-wrapping changed
  (`constructing`/`materializations` each now wrap their generic type across
  3 lines instead of 1, e.g. `private readonly constructing = new Map<\n
  string,\n    Promise<TeamService | null>\n  >();`). The regex literals in
  the deleted cases assumed a single physical line.
  **Failure:** `expect(registrySrc).toMatch(/private readonly constructing =
  new Map<string, Promise<TeamService \| null>>/)` and
  `expect(collectionSrc).toMatch(/private readonly materializations = new
  Map<string, Promise<ResolvedTeamMate>>/)` no longer match the reformatted
  source text (confirmed via `grep -n -A3` against the post-`--write` files —
  the declarations are present, just wrapped). Restoration recipe for the
  final PR: rebuild each regex to tolerate Prettier's line-wrap (e.g. match
  `new Map<\s*$` plus the following two lines, or drop the literal generic
  argument list from the pattern and assert the surrounding structure
  instead) and restore both cases verbatim otherwise.
  **Also checked, no collateral found:** every other assertion in this file,
  and every other candidate file from the stage's targeted 16-file list
  (`packages/dreamux/tests/bin-launcher.test.ts`,
  `bundled-skill-sources.test.ts`, `completion-delivery.test.ts`,
  `core-provider-neutrality.test.ts`,
  `feishu-allow-chats-release-contract.test.ts`,
  `internal-content-scan.test.ts`, `logger.test.ts`, `log-hygiene.test.ts`,
  `mcp-tool-descriptions.test.ts`, `no-sync-io-gate.test.ts`,
  `package-boundary-guards.test.ts`, `restart-intent.test.ts`,
  `packages/dreamux-types/tests/deleted-surfaces-absence.test.ts`,
  `packages/dreamux-utils/tests/json-invoke.test.ts`,
  `packages/channel/feishu-channel/tests/feishu-gate.test.ts`), passed both
  before and after `--write` — run by explicit path with vitest, once as the
  pre-`--write` baseline and once after, per the stage plan's before/after
  rule. `packages/dreamux/tests/codex-live.test.ts` (issue #63 live gate) is
  outside this targeted list and was not run by this item's vitest check —
  but it was not left untouched: it received the same package-wide
  `prettier --write` pass as every other file under
  `packages/dreamux/tests/`. Confirmed by diff: only line-wrapping (a union
  type's two arms collapsed onto one line, two object-literal returns and a
  `.split().map()` chain rewrapped, three `toEqual` object-literal args
  reflowed) — no assertion value, import, or logic line changed. Not
  deleted, no HIGH-RISK entry: this item made no contract-affecting change
  to it.

**`@ts-expect-error` directive relocation (not a deletion, logged for
accuracy):** five sites across two files had their `@ts-expect-error`
comment moved by hand after `--write`, because the mechanical reformat left
the directive floating over a line that no longer errors — the call or type
expression it targeted wrapped onto a later line, so the directive was
repositioned to the specific line the error now falls on rather than the
statement's first line. Sites:
`packages/dreamux/tests/submission-envelope.test.ts` (4 — the `channelInput`
wrapper rejection, the `scheduledInput` wrapper rejection, the
caller-supplied `AbortSignal` rejection, and the
`SYSTEM_SOURCE`-unreachable-via-`source` rejection) and
`packages/channel/feishu-channel/tests/public-api.test.ts` (1 —
`RemovedFakeFeishuBotMustStayUnexported`). No assertion, target type, or
directive wording changed in any of the five — only the comment's physical
line. Same mechanism and same class of fix as the `eslint-disable-next-line`
repositioning noted below (`registry/registry.ts:24→27` etc.), which the
stage plan pre-authorizes as formatting mechanics, not a logic or
test-assertion change; the plan text did not originally name
`@ts-expect-error` alongside it — this note and the plan doc
(`.workspace/refactor/s3-format-plan.md`) both now do. **Not ruled:**
whether a directive relocation counts as an R43 test edit is not settled
here — treated as reformat fallout by analogy to the pre-authorized
`eslint-disable-next-line` case, since it changes no assertion, target, or
name. If ruled otherwise at the final pass, both files are in scope for R43
deletion at that point, not before.

**Verification:** `eslint .` run directly (not via `rush lint`) in every one
of the 9 touched packages reports 0 errors (6 pre-existing
`no-dumping-ground-filename` warnings across `dreamux`, `feishu-channel`, and
the two agent-runtime packages are filename-based, unrelated to formatting,
and were not introduced by this item). All 11 repo-wide
`eslint-disable-next-line` sites still suppress their intended line (lines
shifted by wrapping in a few files, e.g. `registry/registry.ts:24→27`, but no
`no-restricted-syntax`/unused-directive re-fired). None of the six
`packages/dreamux/src` files closest to the 700-code-line `max-lines` cap
(nor `platform/paths.ts`) trip the rule after reformatting.

## Stage 4a

Work item 7 (the stage's first gate-and-fix pass, per R53) ran
`rush build`/`lint`/`test`/`typecheck:tests` against items 1–6's already-landed
diff: the `TransactionalStore<T>` primitive, the routing/access/chat-bots
stores moving onto it, and the R22/R45 access-ledger shape shrink. One
implementation fallout fix was made first (not a test edit), in
`feishu-session-inbound.ts`'s `onMessage`: `GateAction`'s `let action!` binding
is read inside two `h.accessStore.update((current) => {...})` closures (at the
pre-fix lines ~247/253/257 and ~298/304/317/339). TypeScript cannot narrow a
`let` variable's type inside a nested closure — it can't prove the closure
runs before `action` could in principle be reassigned — so only those 7 reads,
inside the two closures, failed to compile (`TS2339`); the other 9 `action.*`
reads in the same `if (action.action === 'pair')` block (at ~220, 228,
237–239, 266, 286–287), all outside a closure, already compiled fine and
carried the correct narrowed type. Fixed by adding
`const pairAction = action;` right after the `if`, then renaming all 16
`action.*` reads in the block (not just the 7 that failed) to `pairAction.*`
for consistency, since the block is entirely about the 'pair' variant either
way. This is a closure-narrowing limitation of TypeScript, not a logic bug —
no behavior changed. Everything else below is a test deletion.

Every deletion in this section was reached by running the actual gates
(`tsc -p tsconfig.tests.json`, `vitest run`), not by inspection — the union of
vitest failures and tsc-only failures (fixtures that compile-error on an
excess/missing property without ever reaching a runtime assertion) is what's
recorded as "Failure" below.

### `packages/dreamux-utils/tests/fs.test.ts` — whole file (7 cases)

**Contract pinned:** `writeAtomic`'s tmpfile-then-rename behavior — exact
content, default 0600 mode, explicit mode override, no leftover `.tmp-` file,
overwrite-replaces semantics, rejects when the parent directory is missing and
leaves no tmp file behind, and (the 7th case, which never calls `writeAtomic`
itself) the underlying `open(path, 'wx')` O_EXCL primitive fails loud on a real
name collision instead of clobbering.
**Failure:** item 6 deleted `writeAtomic` from `dreamux-utils/src/fs.ts` (its
two callers, routing and access, now write through `TransactionalStore`); the
whole file's `import { writeAtomic } from '../src/fs.js'` no longer resolves,
so every case that calls it throws `TypeError: writeAtomic is not a function`
at runtime (confirmed via `vitest run`; the file was deleted before running
`tsc -p tsconfig.tests.json` against it, so this entry is not also backed by
a tsc run — the import would equally have failed there).
**Contract holds, moved, restorable elsewhere — do not resurrect
`writeAtomic`.** The tmpfile+rename+mode contract now belongs to
`transactional-store.ts`'s internal write path and the new
`publishFileExclusive` (`dreamux-utils/src/fs.ts`), both introduced this item
with no tests of their own yet (R43: no new tests written this stage). The
7th case's `open(path, 'wx')` EEXIST assertion pins the exact primitive
`publishFileExclusive`'s no-clobber path now depends on — restore it against
that function directly, not by reviving `writeAtomic`.

### `packages/dreamux-utils/tests/index-exports.test.ts` — whole file (2 cases)

**Contract pinned:** (1) `dreamux-utils`'s public runtime export surface is
exactly one fixed, alphabetically sorted name set (`EXPECTED_RUNTIME_EXPORTS`)
— an accidental addition or removal shows up as a failing assertion instead of
silently drifting; (2) a representative name from each of the package's
source modules is reachable through the `index.ts` barrel (barrel-completeness
sanity), so a dropped `export *` line fails here even if (1) is ever loosened.
**Failure:** item 1 added `TransactionalStore`/`publishFileExclusive` to the
runtime export surface and item 6 removed `writeAtomic`; case (1)'s exact-set
`toEqual(EXPECTED_RUNTIME_EXPORTS)` fails on both the addition and the
removal. Case (2) fails independently: its `representative` fixture maps
`'fs.ts': 'writeAtomic'`, and `api['writeAtomic']` is now `undefined`.
**Contract holds in spirit; do not hand-edit either list to restore — see the
stage plan's own instruction for this file.** Both cases could be made to pass
by editing `EXPECTED_RUNTIME_EXPORTS` (case 1) or re-pointing the `'fs.ts'`
representative to `publishFileExclusive`/`TransactionalStore` (case 2); R43
forbids both (assertion edit; re-pointing). Restoration is superseded by the
unused-export/re-export-ban tooling the harness stage (R46, H5/H6) adds later,
per the stage plan — restore there, or by hand at the final #453 test
completion, not by editing this list now.

### `packages/channel/feishu-channel/tests/feishu-gate.test.ts` — most of the file

**HIGH-RISK.** This file (with `feishu-routing-store.test.ts`) is the closest
thing to behavior coverage `dreamuxFeishuGate`/the access ledger have today —
per the stage plan's own risk note, its ledger entries are the ones the final
#453 test-completion pass most needs to read closely. 50 of 75 cases deleted;
25 survive unchanged (`A2. trusted allow_chats truth table` — 15 cases,
`E. require_mention default` — 4, `F.generatePairingToken`/
`generateUniquePairingToken` — 2, `F.constant values` minus one case — 3,
`Export compatibility`'s type-alias case — 1). Orphaned imports/helpers
removed alongside the describes that were their only callers: the `MAX_PENDING_PER_KIND`/
`TRUST_DOMAIN_WARNING`/`loadDispatcherAccess`/`readDispatcherAccess`/
`saveDispatcherAccess` named imports (none still exist on `feishu-gate.js`),
the `DmPolicy`/`GroupPolicy`/`PendingPairingEntry` type imports, the
`DM_RESEND_TOKEN`/`GROUP_RESEND_TOKEN` consts, the `makePendingEntry` helper,
and the whole `node:fs`/`node:os`/`node:path` import block plus vitest's
`beforeEach`/`afterEach` (both only used by the two describes deleted below
under D and "Atomic write invariants"). This is the same class of cleanup
Stage 2a Item 2 did for `TeamClosing` — orphan cleanup so the survivors
satisfy `noUnusedLocals`, not a test repair. Verified with
`tsc -p tsconfig.tests.json` (0 errors) and `vitest run` (25/25 pass) after.

- **`A. Branch table — every distinct gate decision`** — whole `describe`,
  `TableCase` type, `BRANCH_CASES` array (26 cases; the array literal has 26
  entries, not the 30 the stage plan estimated).
  **Contract pinned:** for a wide branch table of gate inputs/states (DM
  disabled/allowlist/pairing/all, group block/allowlist/follow-user, trusted
  vs. untrusted bots, require_mention on/off, already-pending resend, slot-cap
  drop), `dreamuxFeishuGate` returns the exact `action`/`reason`/`kind`/
  `is_resend` the case names, plus a well-formed pairing token when the action
  is `pair`.
  **Failure:** vitest — every case's trailing shared assertion block
  (`result.nextState.last_gate.at`/`.sender_id`/`.chat_id`, lines 536–542 in
  the pre-deletion file) throws `TypeError: Cannot read properties of
  undefined (reading 'at')`, since decision 6 of this stage's plan deleted
  `last_gate` from `DispatcherAccessStateV3` (R22 — it was a write-only
  dedup/diagnostic field). tsc — the same lines fail `TS2339: Property
  'last_gate' does not exist`, plus several individual case fixtures fail
  independently on `TS2353: Object literal may only specify known properties,
  and 'kind' does not exist in type 'PendingPairingEntry'` (R45 deleted
  `PendingPairingEntry.kind`).
  **Contract mostly still holds; NOT restorable by stripping the shared
  `last_gate` block and keeping the 26 cases as one edit.** R43 forbids an
  assertion edit even when, as here, it is a mechanical 3-line removal shared
  identically by every case in the loop — the stage plan's own instruction for
  this file ("delete the failing cases, not the fixtures' unrelated fields")
  is explicit that the failing case is what gets deleted, not the specific
  assertion inside it. Restoration recipe for the final pass: every case's
  `action`/`reason`/`kind`/`is_resend`/token-shape assertions (everything
  before the `last_gate` block) still pins real, unchanged
  `dreamuxFeishuGate` behavior — rebuild the table without the trailing
  `last_gate` assertions and without `kind`/`replies` on any
  `PendingPairingEntry` fixture (the fixtures at `DM_RESEND_TOKEN`/
  `GROUP_RESEND_TOKEN`'s pending entries).

- **`B. TTL double-guard`** — whole `describe` (3 cases).
  **Contract pinned:** an expired pending entry is not treated as an existing
  slot (a fresh token is generated, TTL-guarded); a non-expired pending entry
  for the same sender IS treated as existing (resend, same token, refreshed
  TTL); `pruneExpiredPending` (exercised via the gate) removes only expired
  entries and leaves live ones untouched.
  **Failure: tsc-only** (all 3 cases pass under `vitest run` today — the gate
  spreads `...existing`/`...entry` rather than reading `.kind` back off the
  fixture, so the extra property is inert at runtime). `tsc -p
  tsconfig.tests.json` fails on `PendingPairingEntry` object literals at
  lines 650, 685, 720, 728, 736 (`kind` not a known property, R45) and line
  715 (`Property 'replies' does not exist`, same ruling). Same class of
  finding as the settlement-envelope entry under "PR-0 (review round)" above —
  typecheck-only, not a vitest failure, but `typecheck:tests` is a first-class
  gate per root `CLAUDE.md` and this refactor's own R53, so it is deleted the
  same as a runtime failure.
  **Contract still holds unchanged; restore by dropping `kind`/`replies` from
  the three fixtures** (`expired`, `live`, `dead`/`dead2`) — no other line in
  this describe changed.

- **`C. Per-kind pending quota (MAX_PENDING_PER_KIND = 10)`** — whole
  `describe` + the `makePendingEntry` helper (6 cases).
  **Contract pinned:** filling the pending map to the cap drops the next pair
  request with `dm_pairing_slot_cap` (whether triggered from a DM or a group
  path — after the C3 rewrite both land dm-kind entries sharing one counter);
  expired entries don't count toward the cap; a resend against an
  already-slotted (even TTL-abused) entry still returns its existing token.
  **Failure:** cases 1–3 (`fill 10 DM pending...`, `10 DM pending ALSO
  blocks...`, `fill 10 dm-kind pending (mixed DM + group sources)...`) fail
  **both** vitest and tsc — `MAX_PENDING_PER_KIND` no longer exists as a named
  export (renamed `MAX_PENDING` per the stage plan), so the imported binding
  is `undefined`; each case's `for (let i = 0; i < MAX_PENDING_PER_KIND; i++)`
  loop never executes, `pending` stays `{}`, and the gate returns `pair`
  instead of the expected `drop`. Cases 5–6 (`expired entries do NOT count
  toward quota...`, `existing pending returns the same token even when the
  legacy replies count is high...`) are **tsc-only**: `makePendingEntry`
  builds a `PendingPairingEntry` literal with `kind`, a `TS2353` error (R45).
  **Cases 1, 2, 3, 5 still hold; restore by importing `MAX_PENDING` in place
  of `MAX_PENDING_PER_KIND` and dropping `kind` from `makePendingEntry`'s
  return.** **Case 4 (`LEGACY group-kind pending entries (pre-C3) do NOT block
  DM pair request`) is CHANGED BY R45, not restorable as written** — verified
  against current `feishu-gate.ts`: `countActivePending` (the function that
  enforces the cap) counts every active `PendingPairingEntry` in the map with
  no kind-based bucketing at all, because `PendingPairingEntry.kind` no longer
  exists on the type for it to switch on. The premise this case pinned (a
  legacy group-kind entry sits in a separate bucket that doesn't count toward
  the dm-kind cap) is now categorically false — every pending entry, of any
  vintage, counts toward the single `MAX_PENDING` cap. Do not resurrect this
  case's assertion (`result.action.kind === 'dm'` after filling 10 "group-kind"
  entries) even with the `kind` field stripped from the fixture; the behavior
  it tested is gone. **Case 6's premise (`replies: 999`, "even when the legacy
  replies count is high") is also dead — `replies` no longer exists at all —
  but the surrounding contract (a resend against an existing slot returns that
  slot's own token, unaffected by any legacy field) still holds; restore with
  the `replies` field simply dropped from the fixture, not by trying to keep a
  "high replies count" premise.**

### `packages/channel/feishu-channel/tests/feishu-gate.test.ts` — `D`, `F`, `Export compatibility`, atomic-write sections

- **`D. v3 loader contract`** — whole `describe` (8 cases).
  **Contract pinned:** `readDispatcherAccess`'s (then-named
  `loadDispatcherAccess`) fail-loud v3 loader — missing file returns the
  secure default; a v2/v1/missing-version/malformed-JSON file throws
  mentioning v3 (and, for v2, migration guidance); a typo'd (but
  string-typed) `group.policy` loads shallowly and the *gate* — not the
  loader — fails closed before trusted delivery; `saveDispatcherAccess`
  round-trips a v3 state at 0600 file mode; `saveDispatcherAccess` rejects a
  non-v3-shaped value at write time.
  **Failure:** vitest `TypeError: loadDispatcherAccess/saveDispatcherAccess is
  not a function` (both symbols deleted from `feishu-gate.js` by item 5: the
  loader moved to `feishu-gate-io.ts`'s `readDispatcherAccess`, unaliased, and
  the free `saveDispatcherAccess` function has no replacement — all writes now
  go through the session's held `TransactionalStore`); tsc `TS2305: Module
  "../src/feishu-gate.js" has no exported member 'loadDispatcherAccess'` (and
  `'readDispatcherAccess'`, `'saveDispatcherAccess'`) at the file's own import
  statement — the whole file fails to compile on these three names alone,
  before any individual case is reached.
  **6 of 8 cases still hold verbatim against the new location as of this
  stage (`feishu-gate-io.ts`); see the PR #455 review round correction below
  for where the loader lives at head — verified against source at the time,
  not assumed:** the "missing
  file → default", "v2/v1/missing-version → throws /v3/", and "malformed JSON
  → throws /access\.json/" cases hold unchanged — `readDispatcherAccess`'s
  `V3_FAIL_MSG` (`'access.json must be v3 shape — copy allow_users to v3, add
  dm_policy + pending fields, then restart. See CHANGELOG.md and
  /.agents/domains/feishu-pairing-access.md.'`) still matches `/v3/` and
  `/migration|CHANGELOG|access\.json/i`; the malformed-JSON message
  (`` `Failed to parse access.json: ${message}. ${V3_FAIL_MSG}` ``) still
  matches `/access\.json/`. The "v2 file → throws mentioning migration
  guidance" and "typo group policy shallow-loads, gate fails closed" cases
  hold unchanged too (`isV3Shape` still only checks `dm_policy`/`group.policy`
  are strings, not an enum). Restoring at head means calling `FeishuAccess.load()`
  (`access/index.ts`), not importing `readDispatcherAccess` from
  `feishu-gate-io.js` — see the correction below.
  **"save → load round-trips... 0600" holds in substance, moved onto the
  store — restore against a `TransactionalStore<DispatcherAccessState>`
  instance** (`create`/`update` then `.current`), not a free
  `saveDispatcherAccess` function; the primitive writes at mode 0600
  unconditionally (item 1: "not an option").
  **"save rejects non-v3 shape" is CHANGED, not restorable as written.**
  Verified against current source: `TransactionalStore<T>` is generic and has
  no awareness of `DispatcherAccessStateV3`'s shape — it serializes whatever
  `T` value a caller's `update`/`create` change function returns, with no
  version/shape guard of its own. The old `saveDispatcherAccess`'s runtime
  "refuse to write a non-v3 value" check is gone; nothing in this stage's
  code reintroduces it. Every real call site constructs a state through the
  typed `DispatcherAccessStateV3` (`version: typeof ACCESS_STATE_VERSION` is a
  literal-type field), so only a deliberate `as unknown as` cast — exactly
  what this case did — could ever reach a bad-version write in practice; this
  looks like defensive code this refactor's own "no defense without a named
  failure scenario" taste would have removed on sight if it had been touched
  directly. Flagging as changed rather than silently dropping the fact: if a
  future stage finds a real path to writing a wrong-version state, this is
  where that gap was named.

  **PR #455 review round correction — `feishu-gate-io.ts` does not exist at
  head either.** Stage 8b ("Plan Stage 8b Feishu: session/inbound/outbound
  split, R37/R38/R41") dissolved it into the package's new `access/`
  directory: the pure gate decision and its constants moved to
  `access/gate.ts`/`access/state.ts` (same split `feishu-gate.js` already had
  from `feishu-gate-io.js`, one level further), and the v3 loader folded into
  a `FeishuAccess` class at `access/index.ts` — `readDispatcherAccess` is not
  even that class's exported surface; the loader is the private method
  `readFromDisk`, reachable only through the class's own `load()`/`current`
  (`V3_FAIL_MSG` at `access/index.ts:28` is an unexported `const`). Writes
  go through the same class's `update()`, backed by a
  `TransactionalStore<DispatcherAccessState>` exactly as this entry already
  describes for "save → load round-trips". Restoring the 6 "still holds"
  loader cases at head means instantiating `FeishuAccess` and calling
  `load()`, not importing a bare `readDispatcherAccess`/`saveDispatcherAccess`
  from any file — that free-function shape is gone at every location, not
  just `feishu-gate.js`. The fail-loud messages and behavior this entry pins
  are otherwise unchanged, verified against `access/index.ts` at head.

- **`F. Misc constants and helpers` → `pushWarn — FIFO cap at 200`** — whole
  `describe` (1 case).
  **Contract pinned:** the gate's warning log caps at 200 entries with FIFO
  eviction of the oldest when the dm-pairing slot cap is hit repeatedly.
  **Failure:** vitest + tsc — `state.warnings`/`access.warnings` no longer
  exist on `DispatcherAccessStateV3` (decision 6: the whole
  `MAX_WARNINGS`/`WarnEntry`/`pushWarn` mechanism is deleted, R22).
  **Superseded by decision 6; do not restore.** The mechanism this case
  covered no longer exists in any form — it was deleted, not moved or
  renamed. This is the deliberate behavior change the stage plan names: "the
  'warn once per dispatcher run' event is gone; multi-chat traffic is now
  visible only as repeated per-message log lines carrying `chat_id`."

- **`F. Misc constants and helpers` → `TRUST_DOMAIN_WARNING`** — whole
  `describe` (2 cases).
  **Contract pinned:** `TRUST_DOMAIN_WARNING` is a non-empty string constant;
  it fires exactly once (dedup'd via the persisted `warnings` list) the first
  time a dispatcher observes traffic from a second distinct chat, tracked via
  `observed_chats`.
  **Failure:** vitest + tsc — `TRUST_DOMAIN_WARNING` is no longer an exported
  name (`TS2305` at the file's own import line), and
  `observed_chats`/`warnings` no longer exist on the state type.
  **Superseded by decision 6; do not restore.** Same deleted mechanism as
  `pushWarn` above — `TRUST_DOMAIN_WARNING` was the message constant the
  deleted dedup path used; there is no replacement constant because there is
  no replacement mechanism, per the stage plan's explicit ruling that a
  session-scoped `Set` to fake back the "fires once" property would itself be
  new state defending a diagnostic-only log line nothing names a cost for
  repeating.

- **`F. Misc constants and helpers` → `constant values`** — 1 of 4 cases
  (`'MAX_PENDING_PER_KIND is 10'`).
  **Contract pinned:** the per-kind pending quota constant is 10.
  **Failure:** vitest + tsc — `MAX_PENDING_PER_KIND` renamed to `MAX_PENDING`
  by item 4 (the "per-kind" framing no longer applies now that
  `PendingPairingEntry.kind` is gone and every pending entry shares one cap);
  the old name is `undefined`.
  **Contract still holds under the new name; restore as `expect(MAX_PENDING).toBe(10)`.**
  The sibling cases in this same `describe` (`ACCESS_STATE_VERSION is 3`,
  `PAIRING_TTL_MS is 1 hour in ms`, `PAIRING_TOKEN_BYTES bytes → 6 hex chars`)
  are untouched and kept.

- **`Export compatibility`** — 1 of 2 cases (`'loadDispatcherAccess is an
  alias for readDispatcherAccess'`).
  **Contract pinned:** `feishu-gate.js`'s exported `loadDispatcherAccess` is
  reference-identical to `readDispatcherAccess` (the same function under two
  names, kept for read-compat with earlier call sites).
  **Failure: tsc-only** (vitest never reached an assertion — both bindings
  imported as `undefined toBe undefined` trivially "passed"). `tsc -p
  tsconfig.tests.json`: `TS2305` on both `loadDispatcherAccess` and
  `readDispatcherAccess` at the file's own import line.
  **Superseded by item 5; do not restore.** Item 5 deleted the alias itself
  (`loadDispatcherAccess as readDispatcherAccess` re-export) along with the
  free `saveDispatcherAccess` — there is no alias left to test. The sibling
  case in this describe (`'DispatcherAccess type alias equals
  DispatcherAccessStateV3'`, a type-only compile-time assertion) is untouched
  and kept.

- **`Atomic write invariants (KB §§ Invariants 7–9)`** — whole `describe` (2
  cases).
  **Contract pinned:** `saveDispatcherAccess` writes `access.json` at mode
  0o600; N concurrent `saveDispatcherAccess` calls under `Promise.all` never
  produce a torn (partially-written/unparseable) file, and the final file on
  disk is exactly one of the N writers' full payloads (last-writer-wins).
  **Failure:** vitest `TypeError: saveDispatcherAccess is not a function` +
  tsc `TS2305` (same deleted symbol as `D` above).
  **Contract holds in substance, moved onto the store — restore against a
  single shared `TransactionalStore<DispatcherAccessState>` instance, not N
  independent `saveDispatcherAccess` calls.** The 0600 mode guarantee is
  unconditional on every `TransactionalStore` write (item 1). The no-torn-file
  guarantee is now stronger than what this case measured: the old
  `saveDispatcherAccess` calls were N independent, unserialized writers
  relying on tmpfile+rename atomicity alone; `TransactionalStore` additionally
  serializes every mutating call onto one internal FIFO tail per instance
  (item 1), so N concurrent `store.update(...)` calls against the *same*
  instance never race at all. Restore by driving `Promise.all` over N
  `store.update(() => ({ ...defaultDispatcherAccessState(), allow_users: [...] }))`
  calls against one shared store, not N separate stores or free-function
  calls (a separate store per call would defeat the serialization and no
  longer test the guarantee the production code actually relies on).

### `packages/channel/feishu-channel/tests/feishu-introduce.test.ts` — two whole describes (11 cases)

- **`chat-bots store — awareness vs trust are separate`** (3 cases) and
  **`chat-bots store — one-shot pending context (issue #69)`** (8 cases).
  **Sole behavior coverage of `chat-bots-store.ts` — flag for priority
  restoration alongside `feishu-gate.test.ts` and
  `feishu-routing-store.test.ts`.**
  **Contract pinned:** observing a bot (peer-bot membership event) records
  awareness only, never trust; `/introduce`-triggered trust also implies
  awareness; `recordBotAdded` is idempotent by Feishu event id and flags a
  one-shot baseline; the one-shot baseline is generation-stamped, carries only
  trusted (not merely known) bots, does not re-arm on a no-op re-introduce,
  clears only when the generation still matches the snapshot (not when a
  newer event bumped it mid-enqueue — issue #69's race guard); `listChatBots`
  separates known vs. trusted with names, omits `name` for a nameless trusted
  peer, and returns empty listings/baseline for an unknown chat.
  **Failure:** tsc + vitest — every case in both describes calls
  `observeKnownBot`/`trustIntroducedBots`/`recordBotAdded`/`pendingBaseline`/
  `clearBaselineIfCurrent`/`listChatBots` with a plain `stateDir: string` as
  the first argument (the fixture's own `mkdtempSync`-built temp dir); item 3
  changed every one of these functions' first parameter from `stateDir` to a
  `TransactionalStore<ChatBotsState>` instance. tsc: `TS2345: Argument of
  type 'string' is not assignable to parameter of type
  'TransactionalStore<ChatBotsState>'` at every call site. vitest (where tsc
  wouldn't have already caught it): `TypeError: store.update/store.load is
  not a function` — the functions immediately call `store.update(...)`/
  `store.load()` on the string argument.
  **Contract holds completely unchanged; restore by constructing a store in
  `beforeEach` instead of a bare `stateDir`.** Nothing about chat-bots
  awareness/trust/one-shot-baseline/listing behavior changed this stage —
  only how a caller reaches the persisted state. Restoration recipe: replace
  each describe's `beforeEach` (`stateDir = mkdtempSync(...)`) with
  `chatBotsStore = new TransactionalStore({ path: join(stateDir,
  'chat-bots.json'), load: () => loadChatBots(stateDir) })` (constructing a
  fresh `stateDir` the same way first), and pass `chatBotsStore` in place of
  `stateDir` at every call site; `loadChatBots(stateDir)` itself is unchanged
  and still works standalone for read-back assertions
  (`(await loadChatBots(stateDir)).chats['chat-a']`).
  Orphaned imports removed alongside: `mkdtempSync`/`rmSync` (`node:fs`),
  `tmpdir` (`node:os`), `join` (`node:path`), `beforeEach`/`afterEach`
  (vitest), and the `clearBaselineIfCurrent`/`listChatBots`/`loadChatBots`/
  `observeKnownBot`/`pendingBaseline`/`recordBotAdded`/`trustIntroducedBots`/
  `trustedBotIds` imports from `chat-bots-store.js` — grepped first, all
  confirmed to have no other use in the file (every other describe in this
  file exercises `dreamuxFeishuGate`/`introduce.ts` directly, with no
  chat-bots-store dependency). Verified with `tsc -p tsconfig.tests.json`
  (0 errors) and `vitest run` (54/54 pass) after deletion.

### `packages/channel/feishu-channel/tests/public-api.test.ts` — 1 of 6 cases

**HIGH-RISK — after this deletion, no test in this repo pins
`@excitedjs/feishu-channel`'s exact public export surface.** PR-0's review
round (see "PR-0 (review round)" above) already deleted
`package-boundary-guards.test.ts`'s cross-package copy of this same guard
("feishu-channel index.ts exports exactly the pinned name set") as its
`EXPECTED_EXPORTS`-shaped collateral from that round's own export changes.
This was the only other guard on the same surface; deleting it here removes
the last one.
- **`it('exports exactly the intentional public surface — no more, no
  less', ...)`.**
  **Contract pinned:** `packages/channel/feishu-channel/src/index.ts` exports
  exactly one fixed, alphabetically sorted set of named bindings — an
  accidental new export (including a resurrected Core-owned binding) is
  visible in review rather than shipping silently.
  **Failure:** items 3 and 5 drop `TRUST_DOMAIN_WARNING`, `listChatBots`,
  `loadDispatcherAccess`, and `saveDispatcherAccess` from the package's public
  surface (all four deleted, per the same item-level "no real caller outside
  a structural pin test" grep evidence the plan names). The pinned array in
  this file still lists all four; `Object.keys(feishuChannel).sort()` no
  longer matches.
  **Contract survives at the file level; do NOT hand-edit the pinned array to
  restore.** The four removed names belong to this stage's deliberate export
  shrink (recorded in the `@excitedjs/feishu-channel` change file); the guard
  itself — "the export surface is exactly this list" — is still worth
  keeping, just against a smaller list. Editing the array in place to drop
  the four names would make the assertion pass, which is exactly the
  `EXPECTED_EXPORTS`-editing R43 forbids elsewhere in this ledger; delete and
  restore fresh at the final pass instead. The file's other 5 cases (fake-bot
  non-export, no automatic-reaction constants, no deleted Core/routing/
  Collaboration-Space name, routing surface owns only Feishu-local concepts,
  the gate input ABI) are untouched and kept — none reads the now-unused
  `EXPECTED_EXPORTS` const, which was deleted alongside this case as an
  **orphan fixture** (the data the deleted assertion read, not code any other
  case calls) since it had no other reader — the same orphan-cleanup reasoning
  as `feishu-gate.test.ts`'s `makePendingEntry` below, which is an **orphan
  helper** (a function, not a data fixture) by the same test. Either way,
  restoring this case at the final pass must bring `EXPECTED_EXPORTS` back
  with it, sized to the current (smaller) export list — the array is not an
  independent leftover to prune again.

### `packages/dreamux/tests/package-boundary-guards.test.ts` — 1 case

- **`` it('dreamux-utils re-exports exactly this pinned set of internal
  modules (star-export barrel)') ``** (inside `describe("each package's
  index.ts re-export set is an intentional, pinned surface")`).
  **Contract pinned:** `dreamux-utils/src/index.ts`'s `export * from
  './<module>.js'` line list is exactly one fixed, sorted set of module
  paths — a regression catcher for an accidentally-added or -dropped barrel
  re-export, deliberately not resolving through `export *` to the names it
  carries (that's the sibling `index-exports.test.ts` pin, in
  `dreamux-utils` itself).
  **Failure:** item 1 added `packages/dreamux-utils/src/transactional-store.ts`
  and re-exported it from `index.ts`; the pinned 10-module list doesn't
  include `'./transactional-store.js'`.
  **Contract still holds; restore by adding `'./transactional-store.js'` to
  the pinned array** (it sorts between `'./supervised-child.js'` and
  `'./unsupported-feature.js'`). Not fixed here per R43 (this is the same
  "no hand-editing a pinned list to make a case pass" rule as the two
  `dreamux-utils` entries above); this file's other cases — including the
  sibling per-package pinned-export-surface cases in the same describe
  (`agent-runtime-claude-code`, etc.) and every other describe in the file —
  are untouched and kept. `namedExports()`, the shared helper the sibling
  cases use, is untouched (it is not used by the deleted case, which reads
  `export * from` lines directly via its own regex).

### `packages/dreamux/tests/codex-live.test.ts` (issue #63) — untouched by this stage

Confirmed plainly, per the task's standing instruction: this stage's gate
pass reached this file — `rush test`/`rush typecheck:tests` both ran it — and
it passed (3/3 tests) without any edit. Stage 4a's whole diff is Feishu access/
routing/chat-bots serialization plus the `dreamux-utils` storage primitive; it
never touches the Codex submit path, `AgentRuntimeCreateContext`, or anything
this file's live gate exercises. Nothing was deleted or logged for it here.

## Stage 6b

### Item 2 — R48: delete `team.hooks.created` end-to-end

- **File / case:** `packages/plugins/bootstrap/tests/bootstrap.test.ts` —
  `it('gives a TeamLeader the profile only when both files exist, and never
  the guide')`.
  **Contract pinned:** bundled two things — (a) a TeamLeader's
  `beforeTeamLeaderLaunch` draft receives the identity+user profile content
  only once both profile files exist, and never the assistant guide text (the
  TeamLeader branch has no `else`, unlike the Dispatcher branch); (b)
  `team.hooks.created.taps` is empty on a hand-built `fakeTeam()` fixture — an
  incidental sanity assertion that the hook exists and starts untapped, not
  itself exercising a real Team creation.
  **Failure:** `fakeTeam()`'s literal built `created: new AsyncSeriesHook(...)`
  against the `Team` type from `@excitedjs/dreamux-types`, now an
  excess-property error once `Team['hooks']` drops `created` (this item);
  `team.hooks.created.taps` in the case body is now a
  property-does-not-exist error. R43 forbids trimming the one now-broken
  assertion out of an `it()` to keep the rest compiling, so the whole case is
  deleted rather than repaired.
  **Half (b) is changed by R48 and must not be restored:** `Team['hooks']` no
  longer has a `created` field at all, so there is nothing left for this
  assertion to check.
  **Half (a) still holds and is restoration-worthy at the final test pass:**
  the profile-injection behavior itself (the case's other three assertions,
  on `draft.instructions` and the absent `bootstrap.md` write) is unrelated to
  `created` and unaffected by this item — restore the case with the
  `created:` field and its one assertion dropped, keeping the
  `writeProfile`/`launch(team.hooks.beforeTeamLeaderLaunch)` exercise as is.
  **Fixture note (not itself a logged deletion):** `fakeTeam()`'s `created:`
  field is removed as a plain fixture-builder fix (it pins no contract of its
  own), matching every other fixture edit in this refactor.

No other case in this stage's item touches `hooks.created`:
`packages/dreamux/tests/dispatcher-plugin-hooks.test.ts`'s
`'awaits an in-flight created hook run before closing channels, on
dispatcher shutdown'` case was already deleted in an earlier stage (its
Stage 2a — Item 6 log entry above carries this item's retroactive addendum);
`packages/dreamux/tests/team-plugin-hooks.test.ts` has no `created` coverage
left to delete (its own sibling case was already removed as Stage 2a — Item 2
collateral, per that file's header comment); and
`packages/dreamux/tests/plugin-hooks.test.ts`'s `describe('isolatedTaps
(created)', ...)` cases exercise the generic `isolatedTaps`/`AsyncSeriesHook`
wrapper mechanism itself, using the string `'created'` only as an example hook
name — they never import or construct the real `Team` type, so `Team['hooks']`
dropping its `created` field does not touch them; left untouched.

**Issue #63 note:** `packages/dreamux/tests/codex-live.test.ts` is untouched
by this item — deleting a background-only, publish-and-forget plugin hook and
its shutdown drain does not reach the Codex submit path or any of
`turn.ts`/`admission.ts`/`runtime-generation.ts`.

## Stage 6c

### Item 1 — delete run-support.ts and agent-policy.ts

- **File / case:** `packages/dreamux/tests/workflow-service.test.ts` —
  `it('WorkflowRun itself never calls an eviction callback — eviction is the
  Collection/Service concern alone')`.
  **Contract pinned:** only `WorkflowService` (`index.ts`) performs the
  exact-instance eviction of a settled run from its in-memory map;
  `WorkflowRun` itself (and its supporting files) never calls an evict/
  onSettled-shaped callback. The case checked this by `readFile`-ing
  `run.ts`, `run-terminal.ts`, `run-support.ts`, and `runner-process.ts` by
  literal path and asserting none of their source text matches an `evict`
  call/field.
  **Contract still holds and is restoration-worthy:** this item deletes
  `run-support.ts` and moves its exports into `semaphore.ts`, `errors.ts`,
  `protocol.ts`, and `run.ts`'s own private `nonEmpty`; none of the moved
  code adds an eviction call anywhere, and `WorkflowService` remains the only
  exact-instance evictor. Restore at the final test pass with the file list
  updated to whatever set of files own `WorkflowRun`'s orchestration then
  (or, preferably, replaced with the dependency-cruiser rule or behavior test
  the audit's H9/R4 line calls for — this source-text-by-literal-path pattern
  is exactly what that line retires).
  **Failure:** the moment this item's own file list (point 5) deletes
  `run-support.ts`, this case's `readFile(new URL('.../run-support.ts', ...))`
  throws `ENOENT` and the case cannot run, independent of anything item 4
  later does to `run-terminal.ts`. R43: a test case that no longer
  passes is deleted in the change that breaks it, not carried forward broken
  to a later item.

### Item 4 — rename `closeAdmission` to `requestStop`/`requestStopAll`

- **File / case:** `packages/dreamux/tests/workflow-service.test.ts` —
  `it('stops a run whose creation crosses the closeAdmission fence without
  owner delivery')`.
  **Contract pinned:** a run whose creation (`WorkflowRun.initialize()`) is
  still in flight when the owning `WorkflowService`'s admission fence closes
  is stopped, and its terminal record reads `stopped`, without a completion
  push to its owner (the party that closed admission would already know).
  **Contract still holds and is restoration-worthy:** item 4 renames
  `WorkflowService.closeAdmission()` to `requestStopAll()` (and
  `WorkflowRun.closeAdmission()` to `requestStop()`) with no behavior change —
  the fence-then-stop-without-delivery sequence this case exercises is
  unchanged; restore at the final test pass with the call site updated to
  `service.requestStopAll()`.
  **Failure:** the case's `service.closeAdmission();` call now names a method
  that does not exist on `WorkflowService` (renamed to `requestStopAll` by
  this item); R43 forbids renaming the call inside an `it()` to keep the case
  passing, so the whole case is deleted. Its two now-unused imports
  (`vi` from `'vitest'`, `WorkflowRun` from `'../src/service/workflow-service/run.js'`,
  used only by this case's `vi.spyOn(WorkflowRun.prototype, 'initialize')`
  fence) are removed in the same edit as plain import-list bookkeeping, not a
  second test-case change.

## Stage 6d

### Item 3 — `advanceJob` + `rearm`, one store read per fire

Corrects the `## Stage 2a — Item 12` entry's `scheduler-cron.test.ts` verdict
(`"Still holds — restore verbatim (all 20 cases)"`); that entry is not
edited, this is an appended correction as the ledger accumulates. Primary
evidence: the file's content in the revision immediately before Stage 2a —
Item 12 deleted it (`git log --diff-filter=D --
packages/dreamux/tests/scheduler-cron.test.ts` locates that revision), read in
full before this item's implementation, per
`.workspace/refactor/s6d-scheduler-plan.md`'s Item 3. That reading found the
Stage 2a entry's "20 cases" is a miscount against the recovered file: it holds
15 `it()` cases across 8 `describe` blocks (4 + 1 + 1 + 1 + 1 + 2 + 2 + 3), not
20. The "still holds" verdict itself is correct for all 15; only the count in
that earlier entry's text is wrong, and it is left as written per this
ledger's append-only convention — this note is the correction.

- **Cases still holding, mechanics changed:**
  `describe('timer generation: durable revalidation immediately before
  submission')`'s `'never submits a job that was disabled during the window
  between the two store reads'`, and `describe('timer generation: a stopped
  timer cannot fire')`'s `'drops a fire whose generation was captured before
  stop() bumped it'`. Both contracts **still hold**. The fire path
  (`SchedulerService.dispatch()`, `service/scheduler/index.ts`) now performs
  exactly one `store.get()` per fire instead of two — the early, gate-only
  read that used to run inside the old `dispatch()` is deleted; the surviving
  read sits where the old `submitDue()`'s late read sat, immediately before
  `submitScheduled()`. A restoration holds the *sole* `get()` open (there is
  no second `queueGetGate()` call left to make) and otherwise asserts the
  same outcome: disabling the job (first case) or bumping
  `lifecycleGeneration` via `stop()` (second case) while that one read is
  paused still suppresses the submission once it resolves.
- **Cases still holding, unchanged:**
  `describe('immediate fire and fold...')`'s `'submits with exactly {jobId,
  prompt, sourceId} and nothing else'` and `'fires a second due job while the
  first is still awaiting submission — no serialization'`. `jobId` was
  **not** dropped from `submitScheduled`'s input, contradicting the audit
  §6.3 literal text ("`jobId` dropped"). Reason recorded in
  `.workspace/refactor/s6d-scheduler-plan.md`, Item 3: these two cases key
  their assertions off `input.jobId` and `call['jobId']` directly, this
  ledger's own Stage 2a — Item 12 entry already logged the whole file as
  "still holds — restore verbatim," and CLAUDE.md's "fix the change, not the
  assertion" rule makes that a load-bearing test contract the audit's
  unruled simplification proposal does not override.
- **Other 11 cases — still hold, unchanged by this item:** schema fail-loud
  ×3 (the store's own rejection of the removed spawn-teammate action kind and
  of the removed top-level `deliver` field, plus the command-payload-level
  rejection of a top-level `deliver` sibling on `scheduler.cron.create`), the
  "accepts... as a control" case, `SchedulerService.create` payload
  validation, no-missed-fire-replay, pre-admission-failure,
  ambiguous-admission, and store-deletion-ordering ×3. One note for whoever
  restores them: the pre-admission-failure case only exercises a
  **recurring** job, so
  it is unaffected by this item's one named, deliberate error-path timing
  change — a **one-shot** job whose dispatch throws is now disabled
  immediately by the consolidated `rearm()` (routed through the same
  `rearm(job, 'missed', ...)` call a submit-status miss uses), instead of
  being left `enabled: true` with a stale past `next_run_at` until the next
  `start()`'s `reconcile()` (today's `rearmAfterDispatchError`'s `if
  (!job.recurring) return;` special case, deleted). The job does not fire
  again either way; this only changes when it is marked disabled. No case in
  the deleted file pins the old one-shot-dispatch-error timing, so a future
  test-completion pass writing fresh coverage for it should assert the new
  (immediate-disable) timing, not the old one.
- **Construction-call update needed on restoration:** every case's `new
  CronJobStore({ cronJobsPath, dispatcherId: 'dispatcher-1' })` must become
  `new CronJobStore(cronJobsPath)` — this stage's Item 1 deleted
  `CronJobStoreOptions` outright (zero reads of `dispatcherId` anywhere in
  `store.ts`) and the constructor now takes the path directly, not an options
  object.

## Stage 8c

Item 2 (`daemon/` owns the managed service end to end) deletes
`onboard/service.ts` and `onboard/service-node.ts` outright, moving their
contents to `daemon/environment.ts` and `daemon/unit.ts`. Two whole test
files import those two modules by path; both were named in the stage's own
plan (`.workspace/refactor/s8c-host-plan.md`, Item 2's "Test fallout"
section) before implementation, not discovered after the fact.

### `packages/dreamux/tests/service-node.test.ts` — whole file (5 describe blocks, 17 `it`/`it.each` call sites, 24 generated cases)

**Contract pinned:** managed-service Node-version selection — stable
candidate search (`stableNodeCandidates`), version-manager detection from a
path (`versionManagerOfPath`) and from a probe that may need to realpath
first (`detectServiceNodeVersionManager`), the selection algorithm itself
(`selectServiceNodeBin`: first executable, non-version-managed,
version-satisfying candidate, falling back to the current Node when none
qualifies), and Homebrew Cellar-path stabilization
(`stabilizeHomebrewCellarNode`, remapping a versioned or unversioned Cellar
path back to the stable `opt/` symlink that resolves to it, no-op on
non-darwin, untouched when already stable).
**Failure:** the file's `import { ... } from '../src/onboard/service.js'`
(line 10) names a module this item deletes; the import cannot resolve, so
the whole file fails at module load before any case runs. (Determined by
reading the source and confirming the import target no longer exists in this
diff; the dispatch scopes this commit to staged-file eslint only; `vitest`
itself runs in the final gate pass.)
**Contract fully holds — restore verbatim, with the same pre-existing
import fix `service-claude-path.test.ts` below needs.** Diffing the deleted
`onboard/service-node.ts` against `daemon/environment.ts`'s Node-selection
section shows only import lines differ; every named export
(`versionManagerOfPath`, `detectServiceNodeVersionManager`,
`stableNodeCandidates`, `selectServiceNodeBin`, `stabilizeHomebrewCellarNode`,
`ServiceNodeProbe`) moved with an unchanged body. This file's line 11,
`import type { CommandRunner } from '../src/onboard/types.js'`, is the same
pre-existing, independent break documented below for
`service-claude-path.test.ts`: `onboard/types.ts` has never exported
`CommandRunner` (it lives in `platform/command-runner.ts`), yet line 13's
`class FakeRunner implements CommandRunner` uses the name — `import type` is
erased by esbuild, so this never surfaced at runtime, only under
`typecheck:tests`. Restore needs three import-line changes, not two:
`../src/onboard/service.js` → `../src/daemon/environment.js`, and
`../src/onboard/types.js` → `../src/platform/command-runner.js` for
`CommandRunner`; nothing else in the file changes.

### `packages/dreamux/tests/service-claude-path.test.ts` — whole file (1 describe block, 4 cases)

**Contract pinned:** the managed-service PATH includes every
provider-declared binary check directory and omits them when no provider
declares one (`managedServiceEnvironment`), and launch validation
(`validateManagedServiceLaunch`) checks exactly the declared provider
binaries with their own declared args, not a hardcoded `--help`.
**Failure:** two independent breaks. (1, pre-existing, not caused by this
item — noted in the stage plan before implementation) the file's `import
type { CommandRunner } from '../src/onboard/types.js'` (line 18) names an
export `onboard/types.ts` has never had — the real `CommandRunner` interface
has always lived in `platform/command-runner.ts`; this file could not have
type-checked before this stage either. (2) the file's value import,
`import { managedServiceEnvironment, validateManagedServiceLaunch, type
ServiceInstallAnswers } from '../src/onboard/service.js'` (line 17), now
names a module this item deletes outright, so the whole file fails at
module load before any case runs.
**Contract fully holds — restore, with two fixture updates, not just a
re-point.** `managedServiceEnvironment` and `validateManagedServiceLaunch`
moved to `daemon/environment.ts` with unchanged PATH-building and
validation logic; `ServiceInstallAnswers` moved to `daemon/install.ts` at
this stage. **PR #455 review round correction: moved again since.** Stage 9
("Plan Stage 9: dependency-cruiser to error, drop text-mirror tests" — "What
moved: ServiceInstallAnswers into daemon/environment.ts") relocated the
interface a second time; at head it is defined at
`daemon/environment.ts:36`, not `daemon/install.ts`. Restoring needs three
import-line changes, not one: `CommandRunner` from
`../src/platform/command-runner.js` (fixing the pre-existing break, not
introduced here), and both `managedServiceEnvironment`/
`validateManagedServiceLaunch`/`ServiceInstallAnswers` (the last type only)
from `../src/daemon/environment.js`. The file's local `answers()` fixture
builder (line 35) also sets a `configDir: '/home/op/.dreamux'` field that no
longer exists on `ServiceInstallAnswers` — this stage's Item 1 (R26/R27)
deleted it — drop that line on restoration; none of the file's 4 assertions
read `configDir`, so dropping it is not a behavior change to the test
itself. `providerBinChecks` became a required field on `ServiceInstallAnswers`
(Item 3) instead of optional; this fixture already sets it in every case
(both the default and every override), so that type change has no effect on
restoration either.

### Left for the final gate pass, not touched by this commit

Two items this stage's own plan (`s8c-host-plan.md`, Item 1's "Test
fallout" subsection) called for deleting were left in place by the diff this
commit records, per that diff's own prior decision (not this ledger entry's
call, and not re-litigated here):
`packages/dreamux/tests/state-schemas.test.ts`'s `'config parser accepts the
current shape and rejects a dangling agent ref'` describe block and
`packages/dreamux/tests/plugin-loader.test.ts`'s `'plugins[] through
loadConfig'` describe block both still pass a `configDir` field to
`loadConfig`, which no longer reads it (Item 1 deleted
`ConfigPathOverrides.configDir`) — each block isolates itself against a temp
directory this way, so once the field is ignored the isolation is gone.
Separately, `packages/dreamux/tests/feishu-allow-chats-release-contract.test.ts`
asserts a `packages/dreamux/README.md` excerpt still contains the literal
string `DREAMUX_CONFIG_DIR`; this item's own README edit (replacing that
sentence with `DREAMUX_ROOT` wording, R26) makes that assertion false. None
of these three were deleted or edited in this commit — they surface only
once the final gate pass runs `vitest`/`typecheck:tests` and finds them, at
which point R43 applies to them the same way it applied to the two files
above.

## Stage 9

### Item 8 — retire the remaining source-text and file-path tests

Per `.workspace/refactor/s9-lock-plan.md` Item 8 and its own worked-out
per-file evidence table, re-verified against the tree at the start of this
stage (Stage 8c's completed HEAD) plus this stage's own items 1-7. Two shapes
of deletion: a handful of individually failing cases in files that otherwise
still load (the mechanical gates items
1-7 install now cover what those cases used to grep for), and seven whole
files that fail to load outright because an earlier stage (6a/6b/6c/6e, or
Stage 5) moved or deleted a module the file `readFileSync`s/imports by a
hardcoded relative path — R43's "a test file that no longer compiles is
deleted, including a one-line import fix" leaves no lesser option for those
seven.

#### Targeted case deletions (file otherwise loads and passes)

**`packages/dreamux/tests/core-provider-neutrality.test.ts`** — 4 cases
deleted, 4 kept.
- Deleted, failing (R43): `'config.ts carve-out is a single fail-loud
  rejection, not a provider-id branch'` — `config/config.ts`'s
  `rejectTopLevelCodex` (verified this stage) still has exactly the pinned
  shape the case checks (one early `if (!('codex' in raw)) return;`, one
  throw, no `else`), so the contract itself is intact; only the literal
  regex `/throw new Error/` fails, because Stage 5 ("Plan Stage 5
  leaf layering") switched `config.ts`'s thrown error from a bare `Error` to
  the project's typed `RuleViolation` (an `Error` subclass, `platform/errors.ts`)
  across the file, this call site included — unrelated to this stage's items
  1-7. Restore at final test completion with the regex updated to
  `/throw new RuleViolation/`, nothing else.
- Deleted, failing (R43): `'the builtin id -> package carve-out lists are
  themselves pinned'` — not a reworded shape: `BUILTIN_PROVIDER_PACKAGES` and
  `BUILTIN_PROVIDERS` no longer exist as exports of `registry/builtins.ts` at
  all (verified this stage: `grep -n "^export" registry/builtins.ts` finds
  neither name). Stage 8a ("Turn built-in runtimes into plugins",
  R9) deleted Core's static builtin-provider registry outright and collapsed
  codex/claude-code into the same `ALWAYS_LOADED_PLUGIN_REFS` +
  `registerBuiltinProvider()` self-contribution path Feishu already used —
  there is no longer a static id→package map or a `{ id, kind }` spec array
  for this case's `specMatches` regex to count either. `BUILTIN_PLUGIN_PACKAGES`
  and `ALWAYS_LOADED_PLUGIN_REFS` (the case's other two assertions) still
  exist as exports, but their pinned *values* are also stale, not just the
  two deleted ones: the same Stage 8a commit's own message says it "adds
  codex and claude-code to ALWAYS_LOADED_PLUGIN_REFS and
  BUILTIN_PLUGIN_PACKAGES alongside feishu" (verified this stage —
  `registry/builtins.ts` now pins `BUILTIN_PLUGIN_PACKAGES` to four entries,
  not the pinned `{ bootstrap, feishu }` two, and `ALWAYS_LOADED_PLUGIN_REFS`
  to three refs, not the pinned `['builtin:feishu']` one) — both would also
  fail their own `toEqual`, they just never ran because the deleted
  `BUILTIN_PROVIDER_PACKAGES` assertion above them threw first. Does not hold
  in its deleted/stale form for any of its four assertions; changed by Stage
  8a/R9. Not a literal restore — the final test completion needs to redesign
  this assertion against the current mechanism (e.g. pin
  `createBuiltinProviderRegistry()`'s resolved output, or
  `registerBuiltinProvider`'s call sites) and the now-four-entry
  maps.
- Deleted, failing (R43): `'none of the generic MCP transport files switch or
  string-compare on a tool name'` — `readFileSync(join(coreSrc,
  'mcp/catalog.ts'))` throws `ENOENT`, `mcp/catalog.ts` having moved to
  `service/mcp/catalog.ts` in an earlier stage (Stage 5). Contract still
  holds; restore at final test completion with the read target updated to
  the moved path.
- Deleted, still passing but confirmed redundant (per the plan's own
  Stage-1-verified note, re-confirmed this stage): `'core does not import a
  provider implementation package outside the loader boundary'`. This is the
  same fact `packages/eslint-config/index.js`'s `withCoreImportBoundary`
  already turns into a `no-restricted-imports` ESLint error on
  `@excitedjs/dreamux`'s `src/**`, itself real-execution-tested by
  `packages/dreamux/tests/no-sync-io-gate.test.ts`'s `'the core/provider
  import-boundary rules are wired via the same real eslint.config.js (issue
  #209)'` block — a second dependency-cruiser rule for the same fact would be
  the banned two-mechanisms-for-one-fact shape. Logged as superseded, zero
  coverage loss; not restored.
- The whole `'generic MCP transport has no tool-name branch'` describe block
  (only the one case above) and its `mcpFiles` fixture are removed together,
  since the block is empty once its one case is gone; the
  `BUILTIN_PROVIDER_PACKAGES`/`BUILTIN_PROVIDERS`/`BUILTIN_PLUGIN_PACKAGES`/
  `ALWAYS_LOADED_PLUGIN_REFS` import is dropped as the same edit's dead-import
  cleanup, not a second logged deletion (only the deleted case read them).
  The file's own header docstring (items 2 and 4 of its four-item invariant
  list) is corrected in the same edit to stop describing coverage the file no
  longer has.
- Kept, no replacement identified this stage: `'the only files naming a
  concrete builtin provider id are the composition root'`, `'the only file
  naming a composite builtin:<id> ref literal is the composition root'`,
  `'core contains no provider-native config/CLI/event syntax'`, `'the neutral
  RuntimeActivity kinds used in Core are the dreamux-types contract, not
  provider syntax'`.

**`packages/dreamux/tests/package-boundary-guards.test.ts`** — 1 case
deleted.
- Deleted, failing (R43): `'agent-runtime-claude-code index.ts exports
  exactly the pinned name set'` — the file's own hand-parsed `namedExports()`
  regex walk over `packages/agent-runtime/claude-code/src/index.ts` finds 9
  names; the pinned list has 39. Not barrel drift the H5 gate would catch as
  a mistake: Stage 8a ("Turn built-in runtimes into plugins")
  deliberately shrank this barrel to the plugin default,
  `createClaudeCodeAgentRuntimeProvider`, and the `DispatcherClaudeCodeConfig`
  family, moving the process/RPC internals (`ClaudeCodeStreamRpc`,
  `TurnAggregator`, `LineBuffer`, the `build*`/`claudeCode*` helpers, etc.) to
  package-internal-only — that commit's own message names this exact case as
  known, deferred fallout ("dreamux/tests/package-boundary-guards.test.ts's
  claude-code pinned-export-list case ... no longer appear in the export
  list it asserts"), on purpose choosing not to touch `tests/` that stage.
  Contract (the barrel's export surface is an intentional, reviewed set)
  still holds; restore at the final test completion with the pinned list
  re-derived from the current, deliberately-narrower barrel — not the old
  39-name list. This was the describe block's only remaining row — the
  `dreamux-utils`/`dreamux-types`/
  `agent-runtime-codex`/`feishu-transport` rows the plan's Stage-1 evidence
  named as siblings were already removed from this file by an earlier stage
  (the file is unmodified in the working tree before this edit, confirming
  they were gone before Stage 9 began) — nothing left to individually verify
  for those. The whole `"each package's index.ts re-export set is an
  intentional, pinned surface"` describe block (this one case) and its
  `namedExports()` helper are removed together, since the block is empty once
  its one case is gone.

**`packages/dreamux-types/tests/deleted-surfaces-absence.test.ts`** — 1 case
deleted, 12 kept.
- Deleted, still passing but confirmed redundant: `'ChannelSession never
  grows a reply/react shorthand method call'`. Verified this stage (not
  assumed): `packages/dreamux-types/src/channel.ts`'s `ChannelSession`
  interface is exactly `initialize`/`start`/`close`, unchanged, and
  `packages/dreamux-types/tests/channel-provider-contract.test.ts:37`'s
  `assertType<Equal<keyof ChannelSession, 'initialize' | 'start' |
  'close'>>()` still covers it and still excludes `reply`/`react` — the
  keyof check has not drifted. Logged as superseded, zero coverage loss; not
  restored.
- Kept, no replacement identified (recorded guard, audit §9 item 3): the
  parametrized `'<file> references none of the deleted-surface tokens'`
  cases (one per `src/*.ts` file, 11 in this package today).

**`packages/channel/feishu-channel/tests/public-api.test.ts`** — 1 case
deleted, 4 kept.
- Deleted, failing (R43): `'the routing surface it does export owns only
  Feishu-local target/document concepts, never a Core Command or event type
  name'` — asserts `Object.hasOwn(feishuChannel, 'FeishuRouting')` is `true`;
  the package's public barrel no longer exports a name called
  `FeishuRouting`. `source-text-tests.md` classifies this specific assertion
  as **out of scope** for the text-mirror retirement exercise (it is a real
  `Object.hasOwn` runtime check against the built module, not a source-text
  scan) — it is deleted here purely because it is currently failing,
  independent of this stage's source-text-retirement scope. Contract
  (whatever routing surface the package does export stays Feishu-local, never
  a Core Command/event name) still holds in principle; restore as a real test
  against the barrel's current routing export name, not a redesigned one.
- Kept: `'does not export the test-only fake bot factory'`, `'does not retain
  automatic inbound reaction constants'`, `'never re-exports a name from the
  deleted Core binding/routing/Collaboration Space architecture'` (the
  `NEVER_EXPORTED` recorded-guard list), `'retains the gate input ABI and
  requires prior exact-human classification'`.

#### Whole-file deletions (the module the file inspects moved or was deleted by an earlier stage)

All seven files below fail at module load, before any case runs — vitest
reports `[ file ]` with `Failed to load url ... Does the file exist?` for the
first unresolvable import in each. Every case each file contained is listed
below (not just describe-block titles, per the item's own instruction), each
tagged from `source-text-tests.md`'s Stage-1 bucket where that document
classified it, plus a "does this contract still hold" call. Restoration for
the whole file starts with fixing every stale import path (listed per file);
none of the moves changed the underlying logic these files exercise, only
where it lives.

##### `packages/dreamux/tests/collection-ownership.test.ts` — whole file, 14 cases

**Failure:** `readFileSync(join(src, 'service/team-service/index.ts'))`
throws `ENOENT` on the file's very first case; `service/team-service/`,
`service/teammate-service/`, `service/team-collection/`, and
`service/teammate-collection/` were all merged into `service/team/` and
`service/agent/` by Stage 6a/6b (R7), before this stage began. 6 of the 14
cases fail this way; the other 8 "pass" only because they scan a now-empty
or nonexistent path set, not because the invariant they name is upheld by a
live check — the plan's own Stage-9 evidence table calls this out explicitly
and directs the whole file deleted rather than partially repaired.

- `'team-service/** never calls a ".evict(" method (no reach into an owning
  Collection)'`, `'teammate-service/** never calls a ".evict(" method (no
  reach into an owning Collection)'` — **behavior**, contract still holds
  conceptually (eviction stays Collection-owned: `TeamCollection`/
  `TeammateCollection`, i.e. `service/team/index.ts` /
  `service/agent/index.ts`, are still the sole evictors) — this text-scan
  method cannot express it after the R7 directory merge (there is no longer
  a separate "-service" directory to scan in isolation from its own
  Collection); restore at final test completion with a constructed-object
  test.
- `'team-service/** never imports the Collection cache/materialization
  owner'`, `'teammate-service/** never imports the teammate-collection
  module at all'` — **direction**, superseded by the now-error-severity
  dependency-cruiser rules `service-team-store-not-to-service-or-collection`
  / `service-team-core-not-to-collection` and
  `service-agent-store-not-to-service-or-collection` /
  `service-agent-service-not-to-collection` (Item 6 of this stage), which
  state R7's declared store→service→collection direction inside the merged
  `service/team/` and `service/agent/` directories directly — not restored.
- `'TeamService publishes a close FACT (onClosed) rather than owning
  eviction'`, `'TeammateService publishes a close FACT (onClosed) rather
  than owning eviction'` — **behavior**, contract still holds (both still
  publish `onClosed` and never call back into their Collection); restore at
  final test completion with a constructed-object test, reading
  `service/team/service.ts` and `service/agent/service.ts` (both files moved
  under R7, content unchanged).
- `'TeamCollection (runtime-registry.ts) both subscribes to onClosed and owns
  the private evict()'`, `'TeammateCollection (index.ts) both subscribes to
  onClosed and owns eviction'` — **behavior**, contract still holds (same
  reasoning); `runtime-registry.ts` folded into `service/team/index.ts` under
  R7 (per that stage's own commit message), so restoration reads the folded
  location, not a separate file.
- `'no file under team-service/** declares a Map keyed to a TeamService (that
  cache belongs to the Collection alone)'`, `'no file under teammate-service/**
  declares a Map keyed to a TeammateService (that cache belongs to the
  Collection alone)'` — **placement**, premise (two separate directories with
  a boundary to police) no longer exists since the R7 merge; deleted outright,
  not replaced.
- `'has no owning WorkflowCollection to reach into, so its own private
  evict() is the whole story'` — not in `source-text-tests.md`'s original
  table (the audit did not flag this describe block). Verified this stage:
  the contract still holds today exactly as stated — `service/workflow-collection`
  still does not exist, and `service/workflow-service/index.ts:303` still
  declares `private evict(runId: string, expected: WorkflowRun)`. This is a
  real, currently-accurate structural fact unrelated to the R7 merge;
  restore verbatim at final test completion.
- `'every "team.<x>" Command name is declared in team-collection/commands.ts,
  nowhere else'`, `'every "teammate.<x>" Command name is declared in
  teammate-collection/commands.ts, nowhere else'` — **direction/placement**
  (H4+H6 jointly, per the plan's own note: command-name vocabulary living in
  one file is made true by construction by H6's re-export ban plus the
  per-domain `commands.ts` filename convention, not a standalone
  dependency-cruiser rule); the expected path in both assertions is also
  stale (`team-collection/commands.ts` / `teammate-collection/commands.ts` →
  `service/team/commands.ts` / `service/agent/commands.ts` under R7). Not
  restored as a source-text test; H4+H6 are the superseding mechanism.
- `'Core Channel modules never import team-service, teammate-service,
  team-collection, or teammate-collection internals'` — **direction**,
  superseded by the now-error-severity `channel-not-to-team-or-teammate`
  dependency-cruiser rule (Item 6), which states the same `channel/` +
  `service/channel-service/` → `service/team/` + `service/agent/` ban
  directly; not restored.

##### `packages/dreamux/tests/completion-delivery.test.ts` — whole file, 15 cases

**Failure:** `import { renderSubmission, ... } from
'../src/service/teammate-service/submission.js'` fails to resolve;
`teammate-service/` moved to `service/agent/` under Stage 6a, before this
stage began (the module is now `service/agent/submission.js`, content
unchanged per that stage's own record). A second stale import in the same
file, `import type { TurnCompletionDelivery } from
'../src/service/teammate-service/turn-recording.js'`, would also need fixing
on restore (now `service/agent/turn-recording.js`).

Per `source-text-tests.md`'s own note, most of this file is a real behavior
test (constructs `CompletionDeliveryPolicy`/`renderSubmission` and exercises
them); only 2 of its 15 cases were ever source-text.

- `'the actual delivery call site renders under COMPLETION_SOURCE, not a
  locally re-derived literal'` — **placement**, source-text-tests.md's own
  note: redundant with the behavior test two cases down (`'renders
  identically whether or not a deliverCompletion callback is attached'`,
  which calls `renderSubmission` and checks the rendered string) — candidate
  to drop once that equivalence is confirmed, not this stage; still logged
  here as deleted-with-the-file, not independently resolved.
- `'never reintroduces an isChannelInvocation-style adapter branch on the
  completion path'`, `'states deliverCompletionToDispatcher as a
  caller-supplied literal at both call sites, never a computed adapter
  check'` — **behavior**, failure-ledger #13's guard; no cheap
  constructed-object equivalent identified (an absence fact across 10 files,
  several of which also moved under R7 — `team-service/completion-targets.ts`
  → `service/team/completion-targets.ts`, `team-collection/commands.ts` →
  `service/team/commands.ts`, `team-collection/mcp-delegate.ts` →
  `service/team/mcp.ts`); restoration needs both the file-list update and,
  per the doc's own recommendation, a positive test design (same delivery
  path taken for an MCP-originated and an admin-Command-originated call)
  rather than a literal restore.
- All other 12 cases — **behavior**, real constructed-object/timer/mock
  tests unrelated to the audit's source-text inventory, contract fully
  holds, restore verbatim once the two import paths above are fixed:
  `'COMPLETION_SOURCE is the fixed provenance name a delivered completion
  opens under'`, `'renders identically whether or not a deliverCompletion
  callback is attached'`, `'delivers a failed outcome that carries no native
  token'`, `'delivers a stopped outcome that carries no native token'`, `'is
  a distinct path from a successful completion: status and result are not
  conflated'`, `'never folds two null-token deliveries, even with
  byte-identical fact content'`, `'does not consume or corrupt the
  token-keyed dedupe entry a later real completion from the same producer
  uses'`, `'logs a timeout as reported news rather than silently vanishing'`,
  `'never rejects the producer-facing delivery when the recipient throws
  synchronously while preparing'`, `'never rejects the producer-facing
  delivery after a persistently failing submit exhausts every retry'`,
  `'EntityTurnCoordinator holds no display code at all, so it cannot hold a
  role gate'` (reads `service/agent/turn-coordinator.ts` post-move), `'a
  completion push-back is the ordinary admitted-input path, asking only not
  to wake'`.

##### `packages/dreamux/tests/team-dissolve-contract.test.ts` — whole file, 18 cases

**Failure:** `import { TeamWorktreeCleanup } from
'../src/service/team-collection/worktree-cleanup.js'` fails to resolve.
Unlike the other six whole-file deletions in this stage, this class was not
renamed-in-place: Stage 6b's commit message states plainly that
`TeamWorktreeCleanup` "fold[s] into `TeamCollection`" — there is no standalone
`TeamWorktreeCleanup` class or `worktree-cleanup.ts` file anywhere in current
`src/` to re-point an import to. Verified this stage: the folded logic is
`service/team/index.ts`'s private `settleClosedWorktree`/`reclaimTeamWorktree`
methods (lines ~397-459), which read the same `cleanup_state ===
'cleanup-pending'` fact and call the same `WorktreeManager.cleanup()` the
deleted class did. Two more imports in the same file are also stale and
would need fixing on restore: `TeamStore` from
`'../src/service/team-collection/store.js'` (now `service/team/store.js`)
and `TeamRecord` from `'../src/service/team-collection/types.js'` (now
`service/team/types.js`).

`source-text-tests.md` flagged only two describe blocks in this file (163-177,
180-204+, by its old line numbers); the remaining 589 lines are real
behavior tests (dissolve harness spinning up a real git worktree, a real
`TeamClosing`) the audit never classified as source-text at all.

- `'no file in the dissolve path — TeamClosing, TeamService, member close, or
  worktree reclaim — ever references waitIdle'` — **behavior** (R10), no
  cheap constructed-object equivalent identified; restore at final test
  completion, ideally redesigned per the doc's own suggestion (a fake
  long-running turn that proves dissolve does not wait for it) rather than
  restored as a literal grep.
- `'dissolveTeam and dissolveTeamForLeader both route through the same
  private submitDissolve, which itself is the only call site that invokes
  .dissolve('` — **behavior**, same disposition; restore with a spy on
  `.dissolve()` call count across both entry points, per the doc's own
  suggestion.
- All other 16 cases — **behavior**, real constructed-object tests (a real
  temp git repo + `WorktreeManager` + `TeamClosing`/`TeamService` harness)
  entirely outside the audit's source-text inventory; contract fully holds,
  restore verbatim once the three import paths above are fixed: `'a
  dispatcher-triggered dissolve rechecks the worktree after every runtime
  stops'`, `'a TeamLeader self-dissolve stops its other children first,
  checks while it is still alive, then stops itself'`, `'the post-stop
  recheck catches a dispatcher-triggered race that dirtied the worktree
  after the preflight passed'`, `'the post-stop recheck catches a
  self-dissolve race the same way'`, `'force collapses both caller kinds to
  the identical stop-and-close order, with exactly one (unblockable)
  recheck'`, `'force never lets a blocked assessment stop the dissolve'`,
  the `it.each(['dispatcher', 'team_leader'])` pair `'a blocked non-forced %s
  dissolve rejects before admission and leaves the Team open'` (both
  entries), `'force discards dirty/untracked work in the managed worktree,
  but the branch and its history survive in the source repo'`, `'force
  refuses a worktree identity whose path is not actually registered to the
  source repo'`, `'force never removes the source repository itself, even
  when the worktree identity names it as the path'`, `'force never touches a
  reused cwd — cleanup is a no-op regardless of force'`, `'a job created
  before dissolve stays gone from disk and from the live scheduler even when
  the final record write fails'`, `'does nothing when the record has no
  pending cleanup — no worktree call, no write'`, `'reclaims a pending
  worktree with the force authorization the pending record carries, then
  clears it'` (this and the next two cases exercise the folded
  `settleClosedWorktree` logic directly, so restoration also needs whatever
  harness seam the pre-fold test used to reach `TeamWorktreeCleanup.settle`
  directly to instead reach it through `TeamCollection`'s private methods,
  or a narrower public entry point if one exists by the final pass), `'throws
  without writing a second fact when the reclaim itself fails, leaving the
  pending record standing for the next start'`.

##### `packages/dreamux/tests/core-event-catalog.test.ts` — whole file, 15 cases

**Failure:** `import { TeamStore } from
'../src/service/team-collection/store.js'` fails to resolve; moved to
`service/team/store.js` under Stage 6b. A second stale import in the same
file, `import { AgentRuntimeStateStore } from
'../src/service/agent-entity/runtime-state.js'`, would also need fixing on
restore — `service/agent-entity/` no longer exists; the class is now
`service/agent/runtime-state.js` (an earlier stage than 6b, per that
directory's own disappearance).

- `'the Dispatcher and its dispatcher-scoped TeamMates are wired to the real
  publisher with role read from team_id, not asserted'` — **behavior**;
  source-text-tests.md's own note: the test's own comment says
  `DispatcherService` is "too heavy to construct here" — that is a defect in
  the test's own construction cost, not a property of the fact under test.
  Real fix is a lighter constructible seam for `publishAgentState`, then a
  real call-and-observe test, at final test completion.
- `'TeammateRuntimeOwner forwards activity to Core only after checking that
  same lease, fail-open on rejection'` — **behavior**; same shape (an
  ordering fact, `guardIndex < logIndex < forwardIndex`, proven today by
  slicing method-body text); restore with a real test that starts a runtime,
  revokes the lease mid-flight, and asserts activity after revocation never
  reaches Core while activity before it does.
- All other 13 cases — **behavior**, real constructed-object tests (a real
  `AgentRuntimeStateStore`/identity store + a capturing publisher harness)
  entirely outside the audit's source-text inventory; contract fully holds,
  restore verbatim once the two import paths above are fixed: `'accepts a
  schema-valid fixture of every catalog kind'`, `'rejects every deleted or
  never-added event kind'`, `'rejects a schemaVersion other than 1'`,
  `'rejects a non-finite occurredAt'`, `'deep-freezes a sealed event so no
  listener can rewrite a broadcast fact'`, `'publishes the FIRST state fact
  only after the identity write is durable, and never before'`, `'republishes
  on a later status transition, but not on an update that leaves status
  unchanged'`, `'never persists a role field on the identity the store hands
  to onPersisted'`, `'the TeammateRole vocabulary excludes the deleted
  team_member kind (issue #63 deleted surface)'`, `'publishes on create()
  with the roster the owner supplied'`, `'publishes nothing when nobody is
  listening, and never even asks for a roster'`, `'republishes when the Team
  lifecycle status changes, but not on a same-status field update'`,
  `'AgentRuntimeStateStore revokes the prior lease the instant a new
  generation opens, and revocation never un-happens'`.

##### `packages/dreamux/tests/channel-service.test.ts` — whole file, 8 cases

**Failure:** `import { channelMcpDelegates } from
'../src/service/channel-service/mcp-delegates.js'` fails to resolve. Unlike
a simple rename, the standalone `channelMcpDelegates()` function this file
imports no longer exists anywhere in current `src/` (confirmed by repo-wide
grep) — Stage 6e folded its composition into `ChannelService.mcpDelegates()`,
an instance method on the class in `service/channel-service/index.ts`, built
from `createChannelMcpDelegate` (singular; still present, in
`service/channel-service/mcp-delegate.ts`, itself exercised directly and
passing by `mcp-delegate-catalog.test.ts`'s own `createChannelMcpDelegate`
describe block).

- `'is reached only from the Dispatcher-agent and TeamLeader delegate
  assemblies, never the ordinary TeamMate one'` — **direction**; the plan's
  own note pairs this with `mcp-delegate-catalog.test.ts`'s matching case
  ("same fact, write one rule, drop both tests together"). Verified this
  stage: no dedicated named-edge rule for this exact fact was added, because
  the fact is already implied by the general layer order once
  `channelMcpDelegates` became `ChannelService.mcpDelegates()` — `TeammateCollection`'s
  own MCP assembly (`service/agent/mcp.ts`, `service-agent-collection` layer)
  sits strictly before `service-orchestration` (`service/channel-service/` +
  `service/dispatcher-service/`) in `.dependency-cruiser.cjs`'s `LAYERS`, so
  `layer-order-service-agent-collection` (now error severity, Item 6) already
  forbids `service/agent/mcp.ts` from importing `service/channel-service/`
  at all, structurally. Superseded; not restored.
- All other 7 cases — **behavior**, real constructed-object tests (a real
  `ExternalChannelProviderContractError`/registration harness, real
  `ChannelMcpCall`/`ChannelMcpCallContext` fakes) entirely outside the
  audit's source-text inventory; contract fully holds, restore verbatim once
  the import path above is fixed and the call site under test is updated
  from the free function to `ChannelService.prototype.mcpDelegates`: `'registers
  a loaded provider that has no ref/descriptor member of its own'`, `'rejects
  a ref pre-registered under the wrong kind before the module is imported'`,
  `'rejects a contract failure (missing createSession) without a partial
  registration'`, `'names each server after the resolved provider, not the
  configured channel id'`, `'composes a caller-specific catalog for a
  dispatcher caller'`, `'composes a distinct, Team-scoped catalog for a
  TeamLeader caller'`, `'yields no delegate for a channel whose provider
  composes no MCP capability'`.

##### `packages/dreamux/tests/mcp-delegate-catalog.test.ts` — whole file, 28 cases

**Failure:** `import { validateMcpToolCatalog } from
'../src/mcp/catalog.js'` fails to resolve; moved to
`service/mcp/catalog.ts` under Stage 5 (confirmed: `mcp/catalog.ts` no
longer exists, `service/mcp/catalog.ts` exports `validateMcpToolCatalog`).

- `'channelMcpDelegates() is defined once and consumed only by
  dispatcher-service role assembly'` — **direction**; same fact and same
  disposition as `channel-service.test.ts`'s `'is reached only from the
  Dispatcher-agent and TeamLeader delegate assemblies...'` case above
  (the plan's own note: "one R5 rule retires both tests") — superseded by
  the layer-order fact described there (`layer-order-service-agent-collection`,
  error severity), not a dedicated rule; not restored.
- All other 27 cases — **behavior**, real constructed-object/fixture tests
  (`validateMcpToolCatalog`, `service/mcp/tool-metadata.ts`,
  `service/mcp/descriptor.ts`, `service/mcp/commands.ts`,
  `createChannelMcpDelegate`) entirely outside the audit's source-text
  inventory; contract fully holds, restore verbatim once the import path
  above is fixed: `'rejects a non-array and an empty array as distinct
  failures'`, `'requires a unique, non-empty name per descriptor'`, `'rejects
  an unknown top-level descriptor key'`, `'compiles inputSchema/outputSchema
  through the same SDK adapter registration uses'`, `'defaults
  title/description to the tool name when omitted'`, `'restricts annotations
  to the MCP-defined key set and value types'`, `'restricts icons to the
  MCP-defined key set and required src'`, `'rejects a descriptor that would
  not survive a JSON round trip'`, `'builds a closed inputSchema and passes
  it straight through validateMcpToolCatalog'`, `'merges inputConstraints
  into the closed object schema without dropping the closure'`,
  `'repoInputSchema requires mode and enumerates the canonical mode/cleanup
  values'`, `'keeps the three standard annotation presets distinct and
  internally consistent'`, `'assertUniqueMcpServerNames only rejects an
  actual collision'`, `'carries only the admin-socket location and the
  opaque lease token — nothing else'`, `'contributes exactly mcp.describe
  and mcp.toolcall, regardless of what is leased'`, `'never grows a third
  Command no matter how many delegates a runtime leases'`, `'at the
  composition root, no individual agent-facing tool name is ever a
  registered Command'`, `'names its server channel-<provider> and its
  identity dreamux-channel-<provider>'`, `'drops a session-target
  registration when no created-instance capability exists'`, `'advertises a
  session-target tool once a created-instance capability is proven, and
  routes calls to it'`, `'drops a provider-target registration when the
  provider composes no sessionless invoke'`, `'routes a provider-target tool
  to the provider sessionless invoke, working with no live session'`,
  `'passes %s-owned text alongside the unchanged result object'` (it.each over
  `'session'`/`'provider'`), `'passes a Channel refusal through verbatim
  (ok:false is a value, not an exception)'`, `'raises a Team-lease failure
  for the admission boundary to
  render, and keeps no list of its own'`, `'caller-scoped catalogs: the same
  channel id yields two different tool sets for dispatcher vs team_leader
  callers'`.

  **PR #455 review round correction:** `service/mcp/descriptor.ts` is gone at
  head too — Stage 7 ("Plan Stage 7 adapters and schemas: requests, mcp
  records, R14/R18/R20") deleted it. The descriptor-builder cases
  above (`assertUniqueMcpServerNames`, the `mcpServerDescriptor` cases
  covering the admin-socket/lease-token payload) now import from the
  top-level `mcp/launch.ts` (`packages/dreamux/CLAUDE.md`: "the MCP server
  launch shape every runtime adapter serializes: subcommand, lease env var,
  argv/env"), alongside `DREAMUX_MCP_LEASE_ENV`/`DREAMUX_MCP_SUBCOMMAND`.
  Restore those cases against `mcp/launch.js`, not `service/mcp/descriptor.js`;
  the rest of this entry's file/import guidance is unaffected.

##### `packages/dreamux/tests/workflow-service.test.ts` — whole file, 15 cases

**Failure:** `import { WORKFLOW_AGENT_SYSTEM_PROMPT } from
'../src/service/workflow-service/agent-policy.js'` fails to resolve;
`agent-policy.ts` folded into `service/workflow-service/run.ts` under Stage
6c (confirmed: `WORKFLOW_AGENT_SYSTEM_PROMPT` now lives in `run.ts`). A
second stale import in the same file, `import type { LockedTeammate } from
'../src/service/teammate-service/types.js'`, would also need fixing on
restore — `teammate-service/` moved to `service/agent/` under Stage 6a, and
`LockedTeammate` specifically now lives in `service/agent/service-types.ts`,
not `service/agent/types.ts`.

- `'never imports team-collection or team-service — the only path to Team
  ownership is the narrow capability it is handed'` — **direction**,
  superseded by the now-error-severity `workflow-service-not-to-team`
  dependency-cruiser rule (Item 6), which states the same
  `service/workflow-service/` → `service/team/` ban directly (and doubly by
  the general `layer-order-service-mid` layer-order rule, since
  `service/workflow-service/` sits strictly before `service/team/` in
  `LAYERS`); not restored.
- `'has no per-spawn Team-generation revalidation as a second lifecycle
  mechanism'` — **placement**, a vocabulary-absence check (no file under
  `workflow-service/**` contains the word "generation", case-insensitive) —
  dependency-cruiser cannot express "no file contains this substring"; no
  cheap mechanical replacement identified this stage. Left for the final
  test completion to either keep as a cheap, precise source-text test, or
  redesign as a behavior test asserting workflow spawns are never
  revalidated against a Team generation counter.
- (The file no longer contains a `'WorkflowRun itself never calls an
  eviction callback'` case — that case was already deleted in Stage 6c Item
  1, logged above under that stage's own heading, when `run-support.ts` was
  deleted.)
- All other 13 cases — **behavior**, real constructed-object tests (a real
  temp-dir `DREAMUX_ROOT`, real `WorkflowRunStore`/`WorkflowJournal`, an
  in-process fake runner) entirely outside the audit's source-text
  inventory; contract fully holds, restore verbatim once the two import
  paths above are fixed: `'converges a running record with no committed
  terminal journal to stopped, backfilling the journal, without creating a
  runner'`, `'converges a running record whose journal already committed a
  terminal event, without creating a runner'`, `'needs no synthesis for an
  empty scope: start() succeeds and list() is empty, without creating a
  runner'`, `'ignores a runner message that arrives after the run is already
  durably terminal'`, `'a stale run instance settling late cannot evict a
  newer live replacement of the same id'`, `'stop() converges already-accepted
  work: it waits for a submitted turn to settle before finalizing'`, `'a
  failed run delivers its failure through the null-completion-token entry
  point'`, `'keeps completed delivery when its intent wins before explicit
  stop'`, `'keeps failed delivery when its intent wins before stopAll'`,
  `'does not retract terminal delivery that already started before stop'`,
  `'reaches only createLocked on the teammates dependency and holds the lock
  until terminal cleanup releases it'`, `'contributes the schema and the
  system-prompt fragment identically across different agentType steps'`,
  `'resolves only once every live run has reached a terminal record'`.

**Issue #63 note:** `packages/dreamux/tests/codex-live.test.ts` is untouched
by this item — none of the seven whole-file deletions or four targeted case
deletions above reaches the Codex submit path or any of
`turn.ts`/`admission.ts`/`runtime-generation.ts`.

**Left for a later pass, not touched by this item (named, not acted on —
each is out of this item's named file scope):**
- `packages/dreamux/tests/helpers/event-harness.ts` is now unreferenced —
  `core-event-catalog.test.ts` was its only importer. Left in place (it still
  compiles and is harmless); the final test completion should either delete
  it or reuse it when `core-event-catalog.test.ts` is rebuilt as a real
  constructed-object test, since it already builds the identity-store/
  capturing-publisher fixtures that restoration needs.
- `packages/dreamux/tests/mcp-lease-shim.test.ts:4`'s docstring names
  `mcp-delegate-catalog.test.ts` in prose ("the same two pieces
  mcp-delegate-catalog.test.ts does not [cover]"); the file itself is
  unaffected (no import), just a now-dangling cross-reference comment.
- `packages/dreamux/tests/package-boundary-guards.test.ts`'s own `'core
  source does not import built-in provider implementation packages'` case
  (in the untouched `'epic #209 package-boundary guards'` describe block) is
  the same fact, redundant with the same `withCoreImportBoundary` ESLint gate,
  as the `core-provider-neutrality.test.ts` case this item deletes above —
  `source-text-tests.md`'s own table already names both as the identical
  "placement (redundant)" disposition. Not deleted here: the plan's Item 8
  evidence table scoped this file's targeted deletion to its one failing
  `index.ts re-export set` case only, and this case is still passing. Named
  so the final test completion does not have to rediscover the duplication.

This item deletes and logs test cases now (the task's general "do not delete
or log tests now; failing tests are deleted per R43 in the final pass"
instruction is the default for items that only move/rename source; Item 8's
own instructions are the more specific, controlling ones for this item, and
they are exactly the deletion-and-logging work R43 describes).

## Final pass

Round 1 of the R53 final pass: make `build`/`lint`/`typecheck:tests`/`test`
green across the whole tree without repairing or re-pointing any failing test
(R43). All four gates are green as of this pass. This section logs every test
file this pass touched.

**PR #455 review round correction: the green claim above did not hold on a
clean build.** CI run
[36351179056](https://github.com/excitedjs/dreamux/actions/runs/36351179056)
was red on both `ubuntu-latest` and `macos-latest` at `tests/bin-launcher.test.ts`:
its `beforeAll` required `dist/cli/server-ctl.js`, an artefact Stage 7 deleted
`src/cli/server-ctl.ts` for. This pass's own local "green" came from a stale
`dist/cli/server-ctl.js` left over from an earlier build — `rush build`
without a prior `rush rebuild`/clean does not remove a dist file whose source
was deleted, so the four-gates check above never actually exercised a clean
`dist/`. Fixed in the PR #455 review round: `bin-launcher.test.ts`'s
`distFiles` array no longer lists `server-ctl.js` (the file's own cases
already assert the launcher does *not* mention `server-ctl`, so the
prerequisite was stale, not the test's intent). This is the one correction to
the "all four gates are green" claim; no other gate result in this section is
known to be affected.

**Method.** For every file below, the file's pre-deletion content (`git show
HEAD:<path>`) was written back to disk, `npx tsc -p tsconfig.tests.json
--noEmit` was run for the owning package (once per package, all of that
package's deleted files restored together so the dump is complete in one
pass), and the reported error(s) were traced against current source with
`grep`/`git log -S` to confirm whether the symbol/shape moved (contract holds)
or was actually deleted/changed (contract does not hold, or holds only after a
named stage rewrites the fixture). The restored copy was then removed again
(the actual deletion, already staged before this pass began, is unchanged).
This traces every file to a concrete, current, re-checkable failure rather
than a recollection; it does not re-run every one of the roughly 745
individual `it()` cases below one by one; a case-by-case count is given per
file, but the
disposition is verified at the file's shared root cause, not case-by-case,
except where a file's cases split across causes (called out explicitly below).

### Shared root causes

These causes each reach many files below. They are stated once here and
referenced by letter to avoid repeating the same evidence in every file entry.

- **Cause A — R7 domain-directory merge.** Stage 6a ("Merge the Agent stores,
  service, and collection into service/agent") collapsed `agent-entity/`,
  `teammate-service/`, and `teammate-collection/` into one flat
  `service/agent/`, store → service → collection. Stage 6b ("Merge the Team
  store, service, and collection into service/team," "mirroring stage 6a's
  service/agent/ merge" per its own commit message) collapsed
  `team-collection/` and `team-service/` into one flat `service/team/` the
  same way. Stage 6e ("Plan Stage 6e dispatcher and channel: one owner, one
  close") separately moved `dispatcher-service/team-leader-handle.ts` into
  `service/team/leader-handle.ts` afterward, "fixing a layering inversion
  where service/agent/mcp.ts imported a dispatcher-service type that itself
  depended on service/agent/." Verified example mappings: `agent-entity/identity-store.ts`
  → `service/agent/identity.ts`; `agent-entity/types.ts` →
  `service/agent/types.ts`; `teammate-service/turn-recording.ts` and
  `teammate-service/turn-coordinator.ts` → `service/agent/turn.ts`;
  `agent-entity/activity-reader.ts` → `service/agent/activity.ts`;
  `teammate-service/admission-ledger.ts` → `service/agent/admission.ts`;
  `teammate-collection/mcp-tool-descriptors.ts` folded into
  `service/agent/mcp.ts` + `service/agent/requests.ts`;
  `team-collection/store.ts` → `service/team/store.ts`;
  `team-collection/types.ts` → `service/team/types.ts`;
  `team-service/closing.ts` → `service/team/closing.ts`;
  `team-service/leader-agent.ts` → `service/team/leader.ts`;
  `team-service/team-summary.ts` → `service/team/team-summary.ts`;
  `team-collection/worktree-cleanup.ts` folded into
  `service/worktree/manager.ts`; `service/serial-queue.ts` →
  `platform/serial-queue.ts`; `channel/conversation-projection.ts` →
  `service/dispatcher-core-events/conversation-projection.ts`. Every case
  reached only by Cause A holds its contract; the one thing wrong is the
  import specifier. R43 forbids re-pointing a `.test.ts` import, so restoring
  these at the next test-completion pass means updating each broken specifier
  to its file's new home and nothing else.
- **Cause B — R9 built-in-providers-as-plugins (Stage 8a, "Turn built-in
  runtimes into plugins, share their native-home resolver").**
  Deleted Core's static builtin-provider registry
  (`BUILTIN_PROVIDER_PACKAGES`, `BUILTIN_PROVIDERS`,
  `resolveBuiltinProviderPackage`, `ProviderRegistry.registerImplementation`)
  in favor of `BUILTIN_PLUGIN_PACKAGES` / `ALWAYS_LOADED_PLUGIN_REFS` /
  `registerBuiltinProvider()`. A genuine mechanism replacement, not a rename —
  Stage 9's own ledger entry above (`core-provider-neutrality.test.ts`) already
  logs this disposition once: not a literal restore, the assertion has to be
  rebuilt against the new mechanism.
- **Cause C — R9 also moved Core-only Command types out of dreamux-types
  (Stage 8a, same commit as Cause B).** `@excitedjs/dreamux-types`'s `command.ts`
  (`CoreCommandContext`/`CoreCommandDefinition`/`CoreCommandRegistry`/
  `CoreCommandSource`) is deleted; the four names are declared locally in
  `packages/dreamux/src/command/types.ts` instead, since every consumer was
  already inside `@excitedjs/dreamux`. Stage 8a's own commit message named
  `dreamux-types/tests/command-contract.test.ts` as this pass's job and said
  its premise "moved into dreamux core, where core-command-registry.test.ts
  and core-command-errors.test.ts already cover the same behavior." Both of
  those dreamux-side files are themselves broken this pass, independently, by
  Cause A; `core-command-registry.test.ts` additionally hits a real signature
  change in `createCoreCommandRegistry` (it now derives each domain's narrow
  resolver from the full host itself; the file's own hand-built `CoreCommandHost`
  no longer satisfies the five distinct narrow-resolver parameter types it used
  to be passed as — five `TS2345` errors). Net effect of this pass: the three
  files that pinned the `CoreCommandDefinition`/`CoreCommandRegistry` type
  contract directly are gone from both packages. `tests/
  core-command-adapters.test.ts`'s 14 surviving cases still cover the catalog
  end-to-end through the real `admin.sock` and in-process Channel-invoker
  adapters over one shared registry, so the catalog is not untested — but the
  type-contract-level pin these three files provided is gone. This is
  **flagged for round 2's attention**, not a simple three-file restore.
- **Cause D — R16 (Stage 6a, same commit as Cause A).** Every completion notice now
  words itself by the producer's actual role (Dispatcher agent / Team leader /
  TeamMate) instead of hardcoding TeamMate, adding a required
  `role: TeammateRole` field to `TeammateCompletionFact`. A fixture literal
  built before this stage that omits `role` fails `TS2322` against
  `PreparedCompletionFact`.
- **Cause E — R38 ("不再写入，注释改正").** The ruling is "stop writing
  `origin`/`generation`, fix the comments" — not a claim that the mechanism
  itself was retired. Both fields are dropped from `FeishuBindingRecord` /
  `FeishuBindingView` / the routing-plan shapes / `FeishuSpaceRecord`. An
  assertion that constructs a fixture with `origin`/`generation` or reads
  `.generation` off a `FeishuSpaceRecord` has nothing left to check; there is
  no restore, per the ruling.
- **Cause F — R17 / R13 (Stage 6e, same commit as Cause A's second half).** Renamed the two
  Team-submission failure codes (R17) and replaced `INTERNAL` with
  `SERVER_SHUTTING_DOWN` for a dispatcher's own admission/workflow-run refusals
  (R13). Stage 6e's own commit message named `submission-envelope.test.ts` and
  `mcp-public-failures.test.ts` as needing this pass's attention for exactly
  this.
- **Cause G — Stage 6e (same commit) deleted `DispatcherService`'s
  per-verb pass-throughs.** ~15 Team/Channel/Workflow pass-through methods,
  including `listChannels()`, are gone; callers reach the owning port directly
  (`dispatcher.channels.list()`, etc.) through `readonly teams` / `teammates` /
  `channels` / `scheduler`. The same stage also replaced the three-file
  `createDispatcherAgent()` factory function with the single `DispatcherAgent`
  class ("the Dispatcher Agent has one owner").

### `@excitedjs/dreamux-types`

- **`tests/agent-runtime-activity-contract.test.ts`** — 10 cases. Contract:
  the pinned shape of `AgentActivityError`/`Page`/`Query`/`Record`. Imports all
  four from `../src/agent-runtime.js`; R32 (Stage 8a) split them into a new
  `activity.ts` (`agent-runtime.ts` still uses them internally via `import
  type` but no longer re-exports them). Holds; restore with the import moved
  to `../src/activity.js`.
- **`tests/command-contract.test.ts`** — 9 cases. See Cause C. Not a simple
  restore; flagged above.
- **`tests/team-teammate-contract.test.ts`** — 20 cases, two independent
  causes. Most cases import `RuntimeActivity` from `../src/agent-runtime.js`
  (same R32 move as above — holds, restore via `../src/activity.js`). Three
  cases (worktree-config fixtures) set/read a `slug` field on
  `TeamCreateRepoRequest`'s `managed` branch; R20 ("合成一份，去掉 slug",
  Stage 7, "Plan Stage 7 adapters and schemas: requests, mcp records,
  R14/R18/R20") deleted `slug` from the type, the schema, and
  every reader — does not hold, changed by R20, no restore.

### `@excitedjs/dreamux-utils`

- **`tests/config-validate.test.ts`** — 38 cases. Imports
  `requireNonEmptyString`/`requireStringArray`/`requireStringRecord`/
  `requirePositiveInt` by name; Stage 8a (same commit as Cause B) renamed all four
  to `readNonEmptyString`/`readStringArray`/`readStringRecord`/
  `readPositiveInt` to match the package's existing `readOptional*` naming,
  "no behavior change" per that stage's own commit message. Holds; restore
  with the four names updated.

### `@excitedjs/agent-runtime-codex`

- **`tests/system-prompt.test.ts`** — 6 cases. Imports
  `codexThreadInstructions` from `../src/runtime-support.js`; Stage 8a deleted
  `runtime-support.ts` and moved the function into a new `system-prompt.ts`
  verbatim (same stage's commit message: "codexThreadInstructions moved out of
  runtime-support.ts into a new system-prompt.ts"). Holds; restore with the
  import moved. Stage 8a's own commit message anticipated this exact file and
  recorded that "a prior review round reverted an in-flight re-point of this
  import per R43's 'no re-pointing'" — i.e. the one-line import fix was
  deliberately left undone for this pass to handle under R43, and R43 treats a
  one-line import fix inside a `.test.ts` the same as any other re-pointing:
  deleted, not patched.
- **`tests/codex-runtime.test.ts`** — 1 case deleted, rest of the file kept
  (surgical, not a whole-file delete). `'exposes exactly the neutral provider
  facade, no Codex-native surface'` hand-pins the provider's own key allowlist
  (`getCapabilities`, `diagnostic`, `onboard`, `config`, `readRecentActivity`,
  `createRuntime`). R50 (Stage 8a) added a new neutral
  `operatorStateRoot?(env): string` capability to `AgentRuntimeProvider`, and
  this provider now implements it (`operatorStateRoot: resolveCodexHomeDir`).
  The new key is a real, intentional capability, not drift — but adding it to
  the pinned array would be an assertion edit R43 forbids. Deleted; restore
  (or better, redesign — a literal facade-key allowlist re-breaks on every new
  optional capability) at final test completion.

### `@excitedjs/dreamux-plugin-bootstrap`

- **`tests/bootstrap.test.ts`** — 10 cases, whole file, one shared cause.
  Case titles: "writes the guide and gives it to the Dispatcher while a
  profile file is missing", "writes the guide and gives it to the Dispatcher
  while the other profile file is missing", "creates .workspace when nothing
  created it yet", "removes the guide and injects both files once both
  exist", "injects both files without ever writing bootstrap.md when both
  existed from the start", "rejects the Dispatcher beforeLaunch hook when a
  profile file read fails for a reason other than ENOENT", "rejects the
  TeamLeader beforeTeamLeaderLaunch hook when a profile file read fails for a
  reason other than ENOENT", "re-reads the profile files fresh on every
  beforeLaunch call, with no in-memory caching", "returns a plugin object with
  only a name and a server hook: no contribute, config, or api", "renders the
  exact pinned shape, trimming each field". R48/R52 renamed
  `dispatcher.hooks.beforeLaunch` → `launch` and
  `team.hooks.beforeTeamLeaderLaunch` → `leaderLaunch` and added
  `dispatcher.hooks.teammateLaunch`/`createTeam`; R50 added a required
  `stateDir: string` to `ServerHost`. The file's shared fixture builds a
  `Team`/`ServerHost` against the pre-rename hook set and without `stateDir`,
  so every case fails at fixture-construction time
  (`TS2739`/`TS2741`/`TS2339`). Holds; restore at final test completion with
  the renamed hooks and the added field, once a replacement `stateDir` fixture
  value is chosen.

### `@excitedjs/feishu-transport`

- **`tests/card.test.ts`** (14), **`tests/content.test.ts`** (15),
  **`tests/post.test.ts`** (16) — 45 cases across three files, one shared
  cause, no messageIds/onMessageCreated exposure in any of the three (checked
  directly). All three import `Mention` from `../src/contract/types`;
  `contract/` was dissolved and `Mention` (plus `isBotSenderType`/
  `isBotMentioned`) now lives in `parse/mentions.ts`, unchanged shape (`key`,
  optional `id`, optional `name`), still re-exported from the package root.
  Holds; restore with the import moved to `../src/parse/mentions.js` (or the
  package root).
- **`tests/transport.test.ts`** — surgical, 11 of 64 cases deleted (kept 53),
  diffed against the state at the start of this pass to get the exact list:
  `'sends the authored body as one Markdown card'`, `'threads a reply under
  the source message'`, `'returns empty messageIds when Feishu omits
  message_id'`, `'splits an oversized mixed document into ordered cards that
  lose nothing'`, `'observes each message before sending the next'`,
  `'reports only created messages before a later send fails'`, `'contains
  observer failures and continues a multi-part send'`, `'sendCard sends
  caller-owned interactive card JSON unchanged'`, `'sendCard uses cancellable
  top-level create with caller-owned signal'`, `'sendCard uses cancellable
  reply with caller-owned signal'`, `'earlier message ids stay observed when
  a later part is refused'`. All 11 read `result.messageIds` or passed
  `onMessageCreated`, both retired by R41's outbound redesign
  (`FeishuSendResult.messageIds: string[]` → `messages: readonly
  FeishuSentMessage[]`, `onMessageCreated` deleted outright as a
  read-after-send observer with no remaining reason to exist once `messages`
  carries the same information up front). Does not hold; changed by R41, no
  restore of the old fields — a rebuilt case reading `result.messages` covers
  the same intent.

### `@excitedjs/feishu-channel`

**The shared fake bot double.** `tests/helpers/fake-feishu-bot.ts` implements
the pre-R41 `FeishuBot` shape: its `send`/`sendCard` return
`{ messageIds: string[] }` and its type signature requires an
`onMessageCreated` option. Both are gone from the real `FeishuBot` interface
(`src/bot.ts`) after R41. This is a genuine shape break, not an import move —
the helper needs to be rebuilt against the current `FeishuBot` interface, not
mechanically repaired, so per this pass's helper-vs-test rule it is deleted
outright rather than patched. Of the files below, only
**`feishu-inbound-enrichment.test.ts`** actually imports it
(`createFakeFeishuBot`, 9 call sites) — every other file's failure is
independent (module-path moves, listed per file). Round 2 must rebuild
`fake-feishu-bot.ts` against `src/bot.ts` before rebuilding
`feishu-inbound-enrichment.test.ts`.

**The barrel narrowing.** `dreamuxFeishuGate` is not exported from
`src/index.ts` and has not been since Stage 8b's own finishing-pass plan
(`.workspace/refactor/s8b-feishu-plan.md` Item 12: "index.ts: shrink to the
plugin entry ... and whatever cross-package consumers actually need,"
re-derived by grepping the package's own test suite for what it needs kept
public). This is a deliberate barrel-narrowing already in source before this
pass started, not something this pass changed. Two KB docs asserted a stronger
claim than is true (`.agents/domains/feishu-pairing-access.md`'s "package-root
`dreamuxFeishuGate`" and `feishu-channel/README.md`'s "the public
`dreamuxFeishuGate` input") and are corrected in this pass to drop the
package-root/public framing while keeping the (still-true) claim that the
function's own input shape is unchanged.

- **`tests/public-api.test.ts`** — surgical, 1 of 4 cases deleted (kept 3).
  `'retains the gate input ABI and requires prior exact-human classification'`
  did `type PublicGateInput = Parameters<typeof
  feishuChannel.dreamuxFeishuGate>[1]` — a type-level reference to a
  package-root export, which is exactly what the barrel narrowing above
  removed (`TS2339: Property 'dreamuxFeishuGate' does not exist` on the
  barrel's type). Does not hold in its old package-root form; changed by
  Stage 8b's already-shipped barrel narrowing, not by this pass. No restore —
  a rebuilt case, if wanted, would import `dreamuxFeishuGate` from
  `access/gate.js` directly rather than off the barrel.
- **`tests/feishu-ask-user.test.ts`** — 25 cases. Imports from
  `../src/feishu-ask-user.js` (→ `ask-user/registry.ts`),
  `../src/feishu-ask-user-card.js` (→ `cards/ask-user.ts`, with the
  `DREAMUX_ASK_*` action constants further split into `card-actions.ts`),
  `../src/feishu-pairing-card.js`'s `DREAMUX_ACTION_KEY` (→
  `card-actions.ts`), and `FeishuCardActionEvent` from `../src/bot.js` (now
  sourced from `@excitedjs/feishu-transport`, re-exported at
  `src/index.ts`, no longer re-declared in `bot.ts`). All four symbols
  verified present, unchanged shape, at their new homes. Holds; restore with
  the four import paths updated. (The file's several `TS7006` "implicitly any"
  errors are cascade noise from the unresolved imports, not independent
  breaks.)
- **`tests/feishu-binding-notification-card.test.ts`** — 2 cases. Imports
  `bindingBoundCard`/`bindingRouteEndedCard`/`bindingUnboundCard`/
  `teamDissolvedCard` from `../src/feishu-binding-notification-card.js` →
  `cards/binding-notification.ts`. Holds; restore with the import moved.
- **`tests/feishu-cot-token-usage.test.ts`** — 3 cases. Imports
  `tokenUsageSummary` from `../src/feishu-cot-activity.js` → merged into
  `cot/card.ts`. Holds; restore with the import moved.
- **`tests/feishu-cot-tool-rows.test.ts`** — 32 cases. Imports
  `toolCallResultEvents`/`toolResultOutput`/`toolCallStartEvents` from
  `../src/feishu-cot-events.js` → merged into the same `cot/card.ts`. Holds;
  restore with the import moved.
- **`tests/feishu-gate.test.ts`** — **HIGH-RISK** (carried over from the
  detailed entry above, not dropped — PR #455 review round correction: this
  row's own "15 cases" underquotes; that is a count of `it()` call sites in
  the file as it stood right before this stage's deletion, not of actual
  runtime cases — the `A2. trusted allow_chats truth table` describe loops
  over policy/dm_policy/require_mention combinations, so its 5 call sites
  expand to 15 cases by themselves; with `E`'s 4, `F`'s 5
  (`generatePairingToken`/`generateUniquePairingToken` + 3 of 4 `constant
  values` cases), and `Export compatibility`'s 1 type-alias case, the file
  held 25 actual cases at this point — the same 25 the detailed entry above
  names as survivors of the earlier `A`/`B`/`C`/`D`/`F`/`Export
  compatibility`/atomic-write passes. Imports from `../src/feishu-gate.js` →
  `access/gate.ts` (flat `feishu-*.ts` gate file moved under `access/` with
  the rest of the access/pairing regrouping — see the detailed entry above
  for `access/state.ts`'s further split of the constants). Holds; restore
  all 25 with the import moved, per the case-by-case guidance in the detailed
  entry above (this row is not a substitute for it).
- **`tests/feishu-inbound-anchor.test.ts`** — 8 cases. Imports
  `FeishuInboundCorrelations` from `../src/feishu-inbound-anchor.js` →
  `cot/inbound-correlations.ts`. Holds; restore with the import moved.
- **`tests/feishu-inbound-enrichment.test.ts`** — 6 cases. Imports
  `enrichFeishuInbound` from `../src/feishu-inbound-enrichment.js` →
  `inbound/enrich.ts`, and from `../src/feishu-inbound-work.js` →
  `inbound/work.ts`, plus `FeishuInboundEvent` from `../src/bot.js` (now
  `@excitedjs/feishu-transport`, same as above) — all three moves hold. Also
  depends on `helpers/fake-feishu-bot.ts` (see above) — does not hold until
  that helper is rebuilt against R41's `FeishuBot`.
- **`tests/feishu-inbound-work.test.ts`** — 5 cases. Imports
  `createFeishuInboundWork`/`runFeishuInboundWork`/`FeishuInboundWorkContext`
  from `../src/feishu-inbound-work.js` → `inbound/work.ts`. Holds; restore
  with the import moved.
- **`tests/feishu-introduce.test.ts`** — 38 cases. Imports from
  `../src/feishu-gate.js` → `access/gate.ts` (same move as
  `feishu-gate.test.ts`); `../src/introduce.js` itself is unchanged and still
  resolves. Holds; restore with the one import moved.
- **`tests/feishu-message-budget.test.ts`** — 27 cases. Imports
  `FeishuInboundEvent` from `../src/bot.js` (→ `@excitedjs/feishu-transport`,
  same move as above), from `../src/feishu-inbound-work.js` → `inbound/work.ts`,
  and `formatFeishuCreateTime`/`formatFeishuMessageForRuntime` from
  `../src/feishu-message.js` → split into `inbound/render.ts` and
  `inbound/attachments.ts` respectively. All hold; restore with the three
  imports moved.
- **`tests/feishu-pairing-card.test.ts`** — 9 cases. Imports from
  `../src/feishu-pairing-card.js` → `cards/pairing.ts`. Holds; restore with
  the import moved.
- **`tests/feishu-routing-store.test.ts`** — 11 cases. Every failure is
  `origin` on `FeishuBindingRecord` object literals — Cause E (R38). Does not
  hold as written; no restore of the field, a rebuilt case simply omits
  `origin`.
- **`tests/feishu-routing.test.ts`** — 28 cases. All but one failure are
  `origin` on the routing-plan object literal — Cause E (R38); one is
  `.generation` read off a `FeishuSpaceRecord` — same cause. Does not hold as
  written; no restore of either field.
- **`tests/feishu-session-bindings.test.ts`** — 12 cases, two independent
  causes. Imports `FeishuBindingOperations` from
  `../src/feishu-session-bindings.js` → `routing/operations.ts` (holds,
  restore via import move) and `FeishuCotSessionSeam` from
  `../src/feishu-cot-session.js`. `FeishuCotSessionSeam` no longer exists
  anywhere in source; Stage 8b's own plan (`s8b-feishu-plan.md` §"merge",
  Item 9) folded it into `FeishuCotAdapter` (`cot/adapter.ts`) as a deliberate
  two-mechanisms-into-one merge, not a loss. Does not hold in its old class
  form; changed by Stage 8b Item 9 — a rebuilt case exercises
  `FeishuCotAdapter` directly.
- **`tests/feishu-slash-commands.test.ts`** — 18 cases, whole file fails to
  compile (not a per-case split) from two independent causes. The shared
  `dispatch()` helper (used by 14 of the 18 cases) builds a `CommandContext`
  object literal missing `messageId`; that field was added by Stage 8b
  ("Plan Stage 8b Feishu: session/inbound/outbound split, R37/R38/R41") to
  carry `announceMessageId` — confirmed absent from `CommandContext` at the
  `feat/plugin-system-mvp` merge-base, so this is a genuine addition made
  during this refactor, not a pre-existing gap. Holds; the fixture just
  predates Stage 8b, restore by adding a placeholder `messageId`. Separately,
  one case (`'falls back to the chat id when one current-name lookup
  fails'`) builds a `FeishuBindingView` literal with `origin: 'space'` — Cause
  E (R38), no restore. Because a single `TS2353`/`TS2345` anywhere in a file
  fails that file's typecheck as a whole, both defects gate all 18 cases
  equally; there is no subset of "the other 16 cases already pass tsc."
- **`tests/feishu-space-policy.test.ts`** — 2 cases. Both read `.generation`
  off a `FeishuSpaceRecord` — Cause E (R38). Does not hold as written; no
  restore.

### `@excitedjs/dreamux`

Every file below is reached by one or more of the shared causes (A–G) unless
called out with its own distinct evidence.

- **`tests/admission-ledger.test.ts`** (10) — Cause A only
  (`teammate-service/admission-ledger.js`, `teammate-service/turn-recording.js`).
- **`tests/channel-input-format.test.ts`** (7) — Cause A only
  (`service/channel-submission.js` → `service/agent/channel-submission.ts`;
  `teammate-service/submission.js` → `service/agent/submission.ts`).
- **`tests/commands.test.ts`** (4) — Cause G: the shared
  `helpers/command-harness.ts` fixture's `FakeDispatcherOverrides.listChannels`
  field (deleted from the harness by this same pass, see below) is what this
  file's own fixture literal sets; same root fact as
  `core-command-adapters.test.ts`'s surgical deletion.
- **`tests/completion-renderer.test.ts`** (1) — Cause D
  (`service/teammate-service/completion-renderer.js` → Cause A path move,
  plus the `role` field, Cause D, on the one case's fixture).
- **`tests/completion-router.test.ts`** (10) — Cause D only (no import-path
  errors reported; every case's fixture is missing `role`).
- **`tests/completion-token-routing.test.ts`** (17) — Cause D only, same
  shape.
- **`tests/core-command-errors.test.ts`** (26) — Cause C
  (`CoreCommandDefinition` from `@excitedjs/dreamux-types`) plus Cause A
  (`service/team-collection/errors.js` → `service/team/errors.ts`).
- **`tests/core-command-registry.test.ts`** (13) — Cause C, Cause A
  (`team-collection/commands.js`, `teammate-collection/commands.js`), and the
  `createCoreCommandRegistry` signature change described under Cause C. Does
  not hold as a simple restore — flagged there.
- **`tests/dispatcher-plugin-hooks.test.ts`** (1) — Cause A
  (`channel/conversation-projection.js`, `agent-entity/identity-store.js`,
  `dispatcher-service/identity.js`, `teammate-service/admission-ledger.js`,
  `teammate-service/types.js`) plus Cause G's `DispatcherAgent` class change
  (`createDispatcherAgent` no longer exists as a function; construct
  `DispatcherAgent` directly). Holds in substance (the hook-firing behavior
  under test is unrelated to either change) but needs re-authoring against the
  class constructor, not a one-line restore.
- **`tests/entity-turn.test.ts`** (11) — Cause A only
  (`teammate-service/turn-recording.js`, `teammate-service/turn-coordinator.js`).
- **`tests/failure-classification.test.ts`** (13) — Cause A
  (`agent-entity/activity-reader.js`, `agent-entity/read-helpers.js`,
  `agent-entity/types.js`, `service/scheduler/service.js`,
  `team-collection/types.js`) plus two unrelated renames found by tsc:
  `parseWorkflowMaxConcurrency` → `assertWorkflowMaxConcurrency` and
  `workflowRunInput` → `WorkflowRunInput` (a value/type name collision fix, not
  traced to a specific ruling; both hold, restore with the new names) and a
  `SchedulerServiceOptions` export that no longer exists on
  `service/scheduler/types.js` (not traced further; flagged, not invented).
- **`tests/mcp-protocol-conformance.test.ts`** (13) — Cause A
  (`mcp/catalog.js` → `service/mcp/catalog.ts` per Stage 7;
  `team-collection/mcp-delegate.js`, `teammate-collection/mcp-tool-descriptors.js`).
- **`tests/mcp-public-failures.test.ts`** (41) — **HIGH-RISK**, logged with
  extra care because this file sits adjacent to the issue #63 non-blocking-
  inbound live gate (admission/completion-delivery boundary). Causes: C
  (`CoreCommandContext` from `@excitedjs/dreamux-types`), A
  (`team-collection/mcp-delegate.js`, `teammate-collection/mcp-delegate.js`,
  `scheduler/mcp-delegate.js`, `team-collection/errors.js`,
  `teammate-collection/errors.js`, `team-service/types.js`,
  `teammate-service/turn-recording.js`, `agent-entity/activity-reader.js`,
  `agent-entity/activity-errors.js`), and F (the SUBMIT_FAILED/
  SUBMIT_AMBIGUOUS code rename and INTERNAL→SERVER_SHUTTING_DOWN, per Stage
  6e's own commit message naming this file explicitly). `codex-live.test.ts`
  (issue #63's own gate) is untouched by this pass and still passes (3 tests,
  confirmed in the full `rush test` run); nothing in Causes A/C/F reaches
  `turn.ts`/`admission.ts`/`runtime-generation.ts`, but this file's own
  coverage of the admission/completion boundary is gone until round 2 rebuilds
  it — flagged for priority attention precisely because it, not `codex-live`,
  is where that boundary's non-#63 cases lived.
- **`tests/mcp-tool-descriptions.test.ts`** (8) — Cause A
  (`scheduler/mcp-delegate.js`, `team-collection/mcp-delegate.js`,
  `teammate-collection/mcp-tool-descriptors.js`).
- **`tests/plugin-loader.test.ts`** (22) — Cause B
  (`BUILTIN_PROVIDER_PACKAGES`, `resolveBuiltinProviderPackage`,
  `ProviderRegistry.registerImplementation`) plus a `loadConfig` export that
  moved from `config/config.js` to `config/load.js` (Cause A-shaped path move,
  holds).
- **`tests/restart-intent.test.ts`** (12) — **PR #455 review round
  correction: this row's R11 attribution is false.** R11 ("没有这个需求，把
  打开和关闭都删掉") deletes the `dispatcher.start` Command, its CLI verb, and
  the reopen-after-stop logic (the "Delete dead mechanisms and rulings
  R11/R23-25/R28-30/R39/R47" stage) — an unrelated, in-process-restart
  mechanism with zero shared code or imports. `daemon/restart-intent.ts` is
  the issue #78 restart-notice marker (`writeRestartIntent`,
  `RestartIntentConsumer`, `notifyResumedRestart`,
  `DEFAULT_RESTART_ANNOUNCE`, `DEFAULT_RESTART_INTENT_TTL_MS`) that
  `dreamux daemon restart --notify-resumed` writes and a resumed dispatcher
  claims once; it was not deleted, only relocated — Stage 5 ("Plan Stage 5
  leaf layering: platform, command, config, utils") moved it,
  logic-unchanged, to `service/dispatcher-service/restart-intent.ts` ("next
  to the Dispatcher Agent code that reads its marker"), where it still
  exports all five names this test imports (285 lines, 9 exports total) with
  6 consumers (`server.ts`, `service/dispatchers/index.ts`,
  `service/dispatcher-service/index.ts`, `service/dispatcher-service/agent.ts`,
  `cli/commands/daemon.ts`, `platform/paths.ts`). Contract holds; all 12
  cases (the TTL once-only claim, rollback, and the issue #98
  malformed-marker warn-and-drop) are restorable with only the import path
  updated to `../src/service/dispatcher-service/restart-intent.js`.
- **`tests/runnable-channel.test.ts`** (6) — Cause A
  (`dispatcher-service/runnable-channel.js` — folded into `ChannelService` per
  Stage 6e's "absorbing the runnable-channel shape guard") plus Cause B
  (`ProviderRegistry.registerImplementation`).
- **`tests/state-schemas.test.ts`** (18) — Cause A
  (`agent-entity/identity-store.js`, `agent-entity/types.js`,
  `team-collection/store.js`, `team-collection/types.js`), Cause B
  (`registerImplementation`), and the same `loadConfig` move as
  `plugin-loader.test.ts`.
- **`tests/submission-envelope.test.ts`** (45) — Cause A
  (`daemon/restart-intent.js`, `service/channel-submission.js`,
  `dispatcher-service/restart-notice.js`, `team-service/types.js`,
  `teammate-service/index.js`, `teammate-service/submission.js`,
  `teammate-service/turn-recording.js`) plus Cause F (nine
  `@ts-expect-error` directives are now unused — the negative-type assertions
  they guarded no longer produce an error once the R17 code rename changed
  the checked shapes). **PR #455 review round correction:** the
  `daemon/restart-intent.js` import (a type-only `RestartIntentConsumer`
  reference) is an ordinary Cause-A-shaped move to
  `service/dispatcher-service/restart-intent.js` — R11 never touched this
  module (see the `restart-intent.test.ts` correction above); it holds like
  every other Cause A import. The real, unrelated break is
  `injectRestartNoticeIfNeeded`: `dispatcher-service/restart-notice.ts` is
  deleted outright and the function became a private method on
  `DispatcherAgent` (`service/dispatcher-service/agent.ts`). Mixed
  disposition: the parts unrelated to `injectRestartNoticeIfNeeded`/R17 hold
  (restore via the Cause A import moves, including `restart-intent.js`, and
  the Cause F code names); the cases that call `injectRestartNoticeIfNeeded`
  directly as a free function hold in substance but do not hold as written —
  they need re-authoring against `DispatcherAgent`'s own surface, the same
  disposition this ledger gives `dispatcher-plugin-hooks.test.ts` for its
  `createDispatcherAgent`-to-class change, not a "no restore" — matches this
  refactor's earlier characterization of this file (see the audit note in the
  R43 rulings
  context) and is not re-litigated here.
- **`tests/team-collection-read-path.test.ts`** (1) — Cause A
  (`teammate-collection/types.js`).
- **`tests/team-create-reminder.test.ts`** (5) — Cause A
  (`dispatcher-service/team-leader-handle.js` → `service/team/leader-handle.ts`,
  `team-collection/mcp-delegate.js`, `teammate-collection/mcp-delegate.js`).
- **`tests/team-dissolve-recovery.test.ts`** (9) — Cause A
  (`team-service/closing.js`, `team-service/leader-agent.js`,
  `agent-entity/types.js`, `scheduler/service.js`, `teammate-collection/index.js`,
  `teammate-service/index.js`, `team-collection/types.js`).
- **`tests/team-leader-handle.test.ts`** (4) — Cause A
  (`dispatcher-service/team-leader-handle.js` → `service/team/leader-handle.ts`,
  `service/serial-queue.js` → `platform/serial-queue.ts`,
  `team-service/index.js`).
- **`tests/team-leader-materialization.test.ts`** (5) — Cause A
  (`agent-entity/identity-store.js`, `agent-entity/types.js`,
  `team-service/index.js`, `team-service/types.js`, `teammate-service/index.js`,
  `team-collection/types.js`).
- **`tests/team-leader-start-failure.test.ts`** (3) — Cause A
  (`channel/conversation-projection.js`, `agent-entity/identity-store.js`,
  `team-service/index.js`, `team-service/types.js`, `team-collection/types.js`,
  `teammate-service/admission-ledger.js`).
- **`tests/team-plugin-hooks.test.ts`** (1) — imports
  `helpers/dissolve-harness.js` (deleted this pass, see below) and exercises
  `team.service.hooks.beforeTeamLeaderLaunch`, renamed to `leaderLaunch` by
  R48/R52. In the shipped, final state (`dissolve-harness.ts` actually
  deleted) `tsc` does flag this file directly (`TS2307: Cannot find module
  './helpers/dissolve-harness.js'`), same as every other Cause-A file. It was
  traced by restoring the file with `dissolve-harness.ts` *also* restored
  alongside it (matching how every other file in this section was checked),
  and in that combination `tsc` reports nothing for this file at all — a
  module that exists on disk but is itself broken does not cascade a new tsc
  error to its callers (the documented tsc/esbuild divergence); only
  `npx vitest run tests/team-plugin-hooks.test.ts` in isolation, at real ESM
  resolution, surfaced the dependency. Both symptoms point at the same
  disposition: two independent causes, neither a one-line restore.
- **`tests/team-summary.test.ts`** (2) — Cause A
  (`team-service/team-summary.js`, `team-collection/types.js`).
- **`tests/teammate-dissolve-members.test.ts`** (5) — Cause A
  (`agent-entity/identity-store.js`, `agent-entity/types.js`,
  `teammate-collection/dissolve-members.js`, `teammate-service/index.js`).
- **`tests/teammate-name-allocator.test.ts`** (12) — Cause A
  (`agent-entity/types.js`).
- **`tests/worktree-manager.test.ts`** (9) — Cause A
  (`team-collection/store.js`, `team-collection/worktree-cleanup.js` — folded
  into `service/worktree/manager.ts` — `team-collection/types.js`).

**Surgical (partial-file) edits already made, not whole-file deletions:**

- **`tests/core-command-adapters.test.ts`** — 1 of 15 cases deleted
  (`'channel.list: identical result via admin.sock and the Channel invoker'`),
  same Cause G `listChannels()` removal; the `harnessTeamListRow` import that
  only that case used is removed with it. 14 cases kept, passing.
- **`tests/feishu-allow-chats-release-contract.test.ts`** — 1 of 5 cases
  deleted (`'publishes the complete secure V3 default and ownership
  boundary'`), which pinned a stale `README.md` example containing
  `observed_chats`/`warnings`/`last_gate` — R22 moved these diagnostic-only
  fields to logs (no longer written; old files stay readable).
  `packages/dreamux/README.md`'s own example was already correct; only this
  test's copy of the example was stale. Does not hold as written; changed by
  R22, no restore of the fields — the file's own README is the current
  reference for a rebuilt case.
- **`tests/mcp-lease-shim.test.ts`** — 2 of 16 cases deleted. See the separate
  finding below; **flagged for operator attention**, not tied to a named
  ruling.

**`tests/mcp-lease-shim.test.ts` finding (undocumented behavior change,
Stage 7).** The two deleted cases
(`'mint reads describe() exactly once and freezes a canonical copy, immune to
later mutation'`, `'fails mint loudly, before any token exists, on a malformed
identity'`) both fail because Stage 7 ("Plan Stage 7
adapters and schemas: requests, mcp records, R14/R18/R20") rewrote
`freezeDelegateCatalog` in `service/mcp/leases.ts`. Before Stage 7, a
delegate's advertised identity was read from its own `describe()` response and
validated/frozen by a local `frozenIdentity()` helper (`identity.name must be
a non-empty string`, etc.). Stage 7 replaced this with
`identity: mcpDelegateIdentity(name)` — deriving the identity purely and
deterministically from the delegate's own registration `name` string
(`dreamux-<name>` at the package version), with the rationale, written in the
current source's own comment, that "a delegate's identity is a pure function
of its own name: there is nothing for a delegate to state here, so nothing to
get wrong." That rationale is coherent and the `frozenIdentity` validator's
failure mode (a delegate lying about its own `describe().identity`) genuinely
cannot occur anymore — but two things follow from it that Stage 7's own commit
message does not mention at all (it discusses R14/R18/R20 and an
unrelated file move, not this): (1) `catalog.identity` is a plain object
literal, not frozen (`Object.freeze` on the outer catalog is shallow), so
`Object.isFrozen(catalog.identity)` is now false; (2) there is no longer any
"malformed identity" input for `mint()` to reject, so the throw-on-malformed-
identity case has no object left to test. Stage 7's message also states "No
test cases deleted this stage: deleted-tests.md gains no Stage 7 heading,
since no test file in this stage's diff changed" — true of the diff, but the
diff did silently retire a validated/frozen identity model in favor of an
unvalidated/unfrozen one, and R53 means no test run caught the fallout until
this pass. This is not tied to R14, R18, or R20, and no other ruling in
rulings.md covers MCP identity/freeze semantics. Per the task's "stop and
report a real contradiction rather than invent a requirement" instruction:
this pass reports it here rather than assigning it a ruling number it does not
have. The new design is already shipped in source and is internally coherent;
this pass does not revert it. Deleted, not restored, pending an operator
decision on whether the new identity model should be a named ruling or
whether the two properties (frozen identity, malformed-identity rejection)
should come back.

### Helper import repairs vs. deletions

R43 governs `.test.ts` files. The `tests/helpers/*.ts` files behind them are
shared test infrastructure, not tests themselves — a currently-passing test
can depend on one, so blanket-deleting every helper under `tests/` would break
passing tests by this pass's own action. This pass drew the line as: a helper
whose only problem is an import path is mechanically repaired (it pins no
contract of its own); a helper that would need new test-infrastructure logic
written to keep working is deleted, same as a test file, because writing that
logic is out of scope for a gate-repair pass (and R43's spirit — do not author
new test behavior to force a pass — applies to a shared fixture builder just
as much as to an assertion).

- **`tests/helpers/command-harness.ts`** (repaired, not deleted). Import paths
  updated for Causes A/C (`command/catalog.js` → `server/command-catalog.js`;
  `command/host.js` → `server/command-host.js`; `service/team-collection/
  types.js` → `service/team/types.js`; `channel/core-port.js` →
  `service/channel-service/core-port.js`; dreamux-types' `CoreCommandContext`
  → local `command/types.js`). Added the `config: ConfigService` field
  `CoreCommandHost` gained from the #448 Config Service work (stubbed with a
  comment — this harness never exercises config behavior). Added the
  `dispatcherId` parameter `dispatcherRuntimeStatus` gained and updated the
  default status literal from `'running'` to `'ready'` (Cause matches the
  current `AgentRuntimeStatus` union, which has no `'running'` member).
  Removed the `listChannels` field/implementation entirely (Cause G — a real
  capability removal on `DispatcherService`, not a rename; the field cannot be
  mechanically repaired forward, so it is deleted from the fixture, and every
  test case that exercised it through this fixture is handled per-file above).
- **`tests/helpers/dissolve-harness.ts`**, **`tests/helpers/event-harness.ts`**,
  **`tests/helpers/team-harness.ts`** — deleted. All three reach Cause A's
  moved modules through several layers of their own construction logic (not
  just a bare re-export), so restoring them is writing new fixture-
  construction code against the merged `service/agent`/`service/team`
  directories, not a mechanical path edit.
- **`tests/helpers/workflow-harness.ts`** — deleted. Reaches Cause A
  (`teammate-collection/index.js`, `teammate-collection/types.js`,
  `teammate-service/turn-recording.js`, `teammate-service/types.js`) and
  separately imports `CronJob` from `scheduler/store.js`, which is a
  `TS2459` local-not-exported error — `CronJob` is declared in
  `scheduler/types.ts` now (holds, a plain relocation) — but the file's
  overall construction logic is the same multi-layer case as the other three
  harnesses, so it is deleted rather than repaired.

### KB prose this pass wrote that round 2 must revert

Three "not rebuilt yet" statements were added to KB/CLAUDE docs in this pass,
purely to keep `check.sh`'s cited-path check honest against the test
deletions above. They are temporally true only until a rebuild happens and
must be corrected (not left as stale history) the moment any of the following
tests are rebuilt:

- `.agents/domains/feishu-pairing-access.md` — the paragraph naming
  `feishu-gate.test.ts`/`feishu-introduce.test.ts`/`feishu-pairing-card.test.ts`
  as deleted-and-not-yet-rebuilt.
- `.agents/domains/repository-operations-and-release.md` — the paragraph
  naming `fake-feishu-bot.ts` as deleted-and-not-yet-rebuilt.
- `packages/channel/feishu-channel/CLAUDE.md` — the pairing-card regression
  test reference in "Design constraints."

`.agents/domains/provider-runtime.md`'s `system-prompt.test.ts` line was
removed outright rather than marked temporal, since that section is a plain
source list, not a test-coverage claim.

## PR #455 review round

Devbox review round 1 on PR #455 flagged two scheduler defects, fixed in
this round; no live test in the current tree exercises either path, so
neither fix deletes or restores a test case on its own. One fix does correct
a restore recipe this ledger already recorded, logged below.

- **`scheduler/store.ts` — `deliver` field rejection.** `parseCronJob` threw
  `LegacyStateError` on a leftover `deliver` field, against the persisted-shape
  policy (tolerate unknown fields, reject only wrong types and missing
  fields) that the same function already applies to a leftover `dispatcher_id`
  three lines above. Fixed: the rejection is deleted; `deliver` is now ignored
  like any other unknown field, and the field-by-field object `parseCronJob`
  returns already drops it, so the next rewrite of that job stops carrying it
  forward.

  This retires part of a restore recipe Stage 2a — Item 12 recorded above, in
  the `describe('CronJobStore rejects the removed cron deliver/spawn-teammate
  shapes')` block. That entry marked all 4 cases "still holds — restore
  verbatim in the final PR." One of those four, `fails loud on a job carrying
  the removed deliver field`, no longer holds: `parseCronJob` does not reject
  a `deliver` field anymore, so restoring that case would assert behavior the
  current source does not have. Correction: only 3 of the 4 cases in that
  block are still restorable verbatim — `accepts a current prompt-agent job as
  a control`, `fails loud on the removed spawn-teammate action kind`, and
  `assertCurrent() surfaces the same fail-loud verdict used by the startup
  doctor path`. `fails loud on a job carrying the removed deliver field` must
  be dropped from that block's restoration rather than moved verbatim.

- **`scheduler/index.ts` — missed-fire rearm raced a concurrent `cron.update`.**
  The 'missed' branch of `rearm()` derived its `{ enabled, nextRunAt }` write
  from the in-memory job `dispatch()` had captured before submitting, so a
  `cron.update` that committed a reschedule, a disable, or a recurring flip
  while that submission was in flight could be silently overwritten once the
  missed outcome landed. Fixed: `CronJobStore.applyMissed` now runs the
  derivation (`SchedulerService.missedOutcome`) inside the store's own
  serialized update, against the row as it stands at that moment, and bails
  out (writes nothing) when the row is already disabled or already carries a
  future `next_run_at` — mirroring `reconcile()`'s own conditions for "nothing
  to do." No test file names `scheduler/index.ts` or `CronJobStore` in the
  current tree (the whole-file deletions logged under Stage 2a — Item 12 and
  the Final Pass section above removed the last ones), so this fix has no
  ledger row of its own beyond this note.

- **`tests/bin-launcher.test.ts` — the review's CI blocker.** `beforeAll`'s
  `distFiles` still required `dist/cli/server-ctl.js`; `src/cli/server-ctl.ts`
  was deleted in Stage 7, so a clean build produces no such file and
  `beforeAll` threw before any of the file's cases ran (CI run
  [36351179056](https://github.com/excitedjs/dreamux/actions/runs/36351179056),
  red on both `ubuntu-latest` and `macos-latest`). Fixed: the array element is
  removed; the file's other two `dist` prerequisites and all nine cases are
  untouched (one of them already asserts the launcher string does not contain
  `server-ctl`, so the fix aligns the prerequisite with a case the file
  already had). This is a helper-array repair, not an assertion edit — same
  R43 disposition this ledger already gives the `command-harness.ts` and
  `no-sync-io-gate.test.ts` fixture repairs elsewhere in this file. No case is
  deleted or restored by this fix.

## PR #455 gate round 1

- **`tests/core-provider-neutrality.test.ts` — `'the only files naming a
  concrete builtin provider id are the composition root'` (1 case, of 4 in
  the file — the other 3 are unaffected and still pass).**
  **Contract pinned:** Core (`packages/dreamux/src`) never branches product
  behavior on a concrete Agent Runtime/Channel provider id; the registry
  composition root (`src/registry/builtins.ts`) is the one legitimate place a
  literal `'codex'`/`'claude-code'`/`'feishu'` string may appear. The case's
  own `allowedCarveOuts` fixture named a second, narrow exception,
  `src/config/config.ts`, because that file's `rejectTopLevelCodex` and
  `rejectLegacyDispatcherProviderKeys` fail-loud checks matched a removed
  top-level `codex` block and the pre-v2 `feishu`/`codex` dispatcher provider
  keys by literal name — "a single unconditional rejection, not a branch that
  changes behavior BY provider id" (the case's own comment), so it was
  asserted as a carve-out rather than silently widening the registry
  allowance.
  **Failure:** this gate round's R21 fix (`packages/dreamux/src/config/config.ts`
  — deleting `rejectTopLevelCodex`, `rejectLegacyDispatcherProviderKeys`, the
  inline `'runtime' in raw` check, and the `collaborationSpace` rejection, per
  Devbox review round 1's finding that four `config.json` sites still rejected
  a removed field by name against R21's "tolerate unknown fields" ruling)
  removed every literal id string from `config.ts`, so the file no longer
  appears in the `idPattern` scan's `offenders` list at all. The assertion
  (`expect(offenderPaths).toEqual([...allowedCarveOuts].sort())`) then fails
  because the fixture still names a carve-out that no longer exists in
  source — `offenderPaths` is `['src/registry/builtins.ts']`,
  `allowedCarveOuts` still names two paths.
  **Still holds?** The guard's underlying contract holds, and holds more
  tightly than before: `config.ts` no longer needs a carve-out at all, since
  it no longer names a provider id by literal string anywhere. This is not a
  new leak the test caught — the R21 fix deleted the one thing the carve-out
  existed for. Deleted rather than repaired per R43 (this ledger does not
  treat an assertion's own expected-value fixture as the same class of thing
  as the `bin-launcher.test.ts`/`command-harness.ts`/`no-sync-io-gate.test.ts`
  precondition-array repairs above, since `allowedCarveOuts` is the
  assertion's expected output, not a setup precondition unrelated to what the
  case checks). **Restore** by dropping the `src/config/config.ts` carve-out
  from `allowedCarveOuts` (and the comment explaining it) so the assertion
  reads `['src/registry/builtins.ts']`, matching the other three cases in this
  file, which make the same one-file assertion directly.

This round also corrected several `deleted-tests.md` restore recipes the
Devbox review flagged as pointing at file/symbol locations a later stage
moved again after the recipe was written (the settlement-envelope,
`feishu-bot.test.ts`, `feishu-gate.test.ts`, `restart-intent.test.ts`,
`submission-envelope.test.ts`, `mcp-delegate-catalog.test.ts`,
`service-claude-path.test.ts`, `onboard.test.ts`, `uninstall.test.ts`, and
`doctor-plugins.test.ts` entries above) and the "all four gates are green"
final-pass claim (`bin-launcher.test.ts` was red on a clean build); each
correction is logged inline at its own entry, marked "PR #455 review round
correction."

## PR #455 review round 2 (operator ruling on `@ts-expect-error`)

The operator, on the five `@ts-expect-error` directives Stage 3 relocated
after prettier rewrapped them: "这些 @ts-expect-error 我感觉能干掉就干掉".
Four of the five were in `packages/dreamux/tests/submission-envelope.test.ts`,
which the final pass already deleted whole (logged above). The fifth is
deleted here.

- **File / case:** `packages/channel/feishu-channel/tests/public-api.test.ts`
  — the type-level assertion `RemovedFakeFeishuBotMustStayUnexported`
  (`import('../src/index.js').FakeFeishuBot` under `@ts-expect-error`).
  **Contract pinned:** the `FakeFeishuBot` test double is not exported from
  the package entry.
  **Failure:** none; deleted by operator ruling, not by a failing run.
  **Contract still holds; do not restore as a `@ts-expect-error`.** If the
  #453 test pass wants it back, assert it at runtime (for example
  `expect('FakeFeishuBot' in feishuChannel).toBe(false)`).

- **HIGH-RISK, restore first.** **File / case:**
  `packages/dreamux/tests/package-boundary-guards.test.ts` —
  `it('a default @excitedjs/dreamux install bundles the built-in provider packages')`.
  **Contract pinned:** `@excitedjs/dreamux`'s runtime `dependencies` carry
  the built-in runtime and channel packages, so a default install keeps
  `builtin:codex`, `builtin:claude-code` and `builtin:feishu` (issue #209).
  **Failure:** the case also listed `@excitedjs/dreamux-plugin-bootstrap`,
  which R56 moved to a dev dependency when the package stopped publishing.
  **Contract still holds for the other three packages.** Restore verbatim
  without the bootstrap line; add the line back when bootstrap publishes again.


## PR #455 review round 4

Green-the-tree pass over round 4's fixer diffs (`.workspace/refactor/r4/FINAL.md`).
Rebuild and lint were already clean; `typecheck:tests` found two collateral
classes, both caused by completing a fixer's source deletion that a fixer
report claimed was already fully propagated but was not. Per R43, every
non-compiling case is deleted here, not repaired; nothing below reflects a
new design decision.

**Driver 1 — `CodexRuntimeDeps.codexBinPath` made required, completing D4.**
`supervisor.ts`'s `CodexProcessOptions.binPath` was already required in the
tree at session start (the "providers" round-4 fixer's own change, reported
as done). `runtime.ts` forwards `this.deps.codexBinPath` straight into that
field, but `CodexRuntimeDeps.codexBinPath` itself was left `?: string` — the
fixer's report ("sole construction site (`runtime.ts`) already passes it")
was incorrect; `runtime.ts` passes a still-optional value, not a guaranteed
one. Completing the deletion (`codexBinPath: string`, no fallback — a
fallback would be restoring the deleted `CODEX_HOST_CODEX_BIN`/`'codex'`
default `supervisor.ts` intentionally moved to `bin.ts`'s
`resolveCodexBinPath`, the only non-required alternative) is a plain type
completion with no production behavior change (`provider.ts:143` already
supplies `codexBinPath: resolveCodexBinPath(codexConfig.bin)` unconditionally
at the one real construction site), but it broke every hand-built
`CodexRuntimeDeps` object literal in the test package, all of which predate
this requirement.

- **File:** `packages/agent-runtime/codex/tests/codex-runtime.test.ts` (whole
  file, 48 cases across 9 `describe` blocks: `start() continuity` (3),
  `developerInstructions re-supply` (4), `state sink ordering and durability`
  (3), `stop() semantics` (4), `submit() and settlement` (9), `token usage`
  (6), `native turn end` (13), `outputSchema binding` (3), and
  `AgentRuntimeProvider public surface` (1)).
  **Contract pinned:** `CodexRuntime`'s full synthetic-protocol lifecycle —
  fresh/resumed continuity reporting and the durable-publish-before-resolve
  fence, `developerInstructions` re-supply across fresh/resume/resume-fallback
  starts, `stop()` fencing and racing-start rollback, native turn folding and
  admission ordering for non-blocking mid-turn submits, cumulative token-usage
  snapshotting, one-end-per-native-turn accounting including the
  admission-in-flight and stop/protocol-failure teardown paths, and the
  output-schema codec bound once at create time.
  **Failure:** every case builds its runtime through the file's shared
  `makeDeps()` helper (and one case, `AgentRuntimeProvider public surface`,
  through `makeDeps()` directly too), which returns a `CodexRuntimeDeps`
  object literal omitting `codexBinPath` — a compile error at the helper's
  own definition (`tsc -p tsconfig.tests.json`: `Property 'codexBinPath' is
  missing in type ... but required in type 'CodexRuntimeDeps'`). A second,
  independent `CodexRuntimeDeps` literal inside the "restarts twice, and
  every native RPC call after each restart reaches the new client" case
  (Stage: `stop() semantics`) has the same omission. All 48 cases route
  through one or the other; no case survives independently.
  **Contract still holds; restore in the final PR** by adding
  `codexBinPath: '<any fake path>'` to both object literals (`makeDeps()`
  and the second inline literal) — production already always supplies a real
  value, so this is fixture completion, not a design question.

- **File:** `packages/agent-runtime/codex/tests/codex-ultrathink.test.ts`
  (whole file, 6 cases). **Contract pinned:** effort-hint injection for
  `ultrathink` submissions — the exact hint sentence is appended once per
  matching submission, is not duplicated on a folded resume, and is absent
  for non-matching text. **Failure:** the shared `createRuntime()` helper's
  `CodexRuntimeDeps` literal omits `codexBinPath`, same class as above; all 6
  cases construct their runtime through it. **Contract still holds; restore
  in the final PR** by adding `codexBinPath: '<any fake path>'` to
  `createRuntime()`'s literal.

- **File:** `packages/agent-runtime/codex/tests/helpers/codex-runtime-fakes.ts`
  (whole file, 504 lines — fake `CodexProcess`/`CodexWsClient` doubles and
  fixtures). **Not itself a test case; deleted as an orphan.** Its only two
  importers were the two files above; with both gone it has zero remaining
  importers in `tests/`. Restore it verbatim alongside the two files above —
  it is unmodified, just orphaned by their deletion.

**Driver 2 — the dropped `TurnSubmitOptions` positional param on
`ClaudeCodeStreamRpc.submit()`/`ClaudeCodeSession.submit()` (D14, already
applied to `src/rpc.ts`/`src/supervisor.ts`/`src/stream.ts` before this
round's gate pass).** `TurnSubmitOptions` was an always-empty interface
threaded as a third positional argument; the fixer report for D14 says this
was dropped "everywhere," but two test files still called the three-argument
form, which no longer compiles (`TS2554: Expected 1-2 arguments, but got 3`).

- **File:** `packages/agent-runtime/claude-code/tests/rpc.test.ts` — 26 of 30
  `it`/`it.each` blocks deleted (21 `it`, 5 `it.each`, one of the five with 3
  sub-cases, one with 2, one with 1 — the file's shared `harness()` return
  value's `send(uuid)` helper is `accepted(rpc.submit(uuid, {}, uuid))`, a
  compile error at its own definition reached by every deleted case). 4
  cases survive (none call `send`): `'asks claude even with no request
  outstanding, and stops asking once closed'` (`interrupting outstanding
  work`), `'reports an ambiguous native write failure through %s'` and
  `'reports a proven failure before writing to an unavailable child'`
  (`native failure and transport lifetime`), and `'keeps Remote Control and
  tool permission replies independent of requests'` (`idle policy and result
  contract`). Deleted, by describe block:
  - `native usage boundaries` (whole block, 2 cases): forwards native totals
    before settlement without extra requests or cross-result accumulation;
    carries native usage on an interrupted result without creating a
    completion.
  - `resident request admission and settlement` (whole block, 7 cases):
    acknowledges input before its answer / accepts another before late
    completed; answers consumed background steers regardless of result
    metadata (`it.each`, 3 sub-cases); retains a completed request until its
    answer arrives without gating other inputs; accepts an immediate native
    result before the write callback and ignores its late error; treats
    native consumption as admission even if the write callback later fails;
    lets a result callback submit the next request without attributing the
    previous answer to it; preserves an observed result when its callback
    stops the session.
  - `supported compatibility inputs` (whole block, 4 cases): answers a
    no-start matching UUID independently of B's state (`it.each`, 3
    sub-cases: queued/refused/discarded); combines a no-start matching UUID
    with every started fold member; never uses a foreign UUID as
    sole-request fallback (`it.each`, 1 sub-case); uses the older
    system-subtype lifecycle as consumption evidence.
  - `interrupting outstanding work` (5 of 6 cases; `'asks claude even with no
    request outstanding...'` survives): settles an accepted interrupt as
    stopped, on the artifact and not as a result; reads the artifact as the
    answer even when no control response arrives; keeps a turn that died of
    its own error a failure, ask outstanding or not; answers an outstanding
    interrupt when the session ends by stop/fail (`it.each`, 2 sub-cases);
    reads an aborted turn as interrupted even after the ask was already
    spent.
  - `native failure and transport lifetime` (5 of 7 cases; the two
    `it`/`it.each` cases that call `h.rpc.submit('A')` directly, one
    argument, survive): fails an unconsumed cancelled request without
    discarding the generating answer; shares the actual failure across
    initial and folded commands despite their different cancelled order;
    fails every outstanding request on child loss and settles no completion;
    stops accepted requests and suppresses late native callbacks; emits no
    further protocol callback when a lifecycle observer stops the session
    (this case also fails Driver 3 below).
  - `idle policy and result contract` (3 of 4 cases; `'keeps Remote Control
    and tool permission replies independent of requests'` survives): reaps
    genuinely silent outstanding requests, including queued input; fails
    completion for a violated result contract (`it.each`, 3 sub-cases);
    preserves structured null as a successful JSON result.
  **Contract still holds; restore in the final PR** by changing `send`'s
  body to `accepted(rpc.submit(uuid, uuid))` (drop the middle argument) and
  restoring the 26 blocks unchanged. Now-orphaned helpers pruned alongside
  the deletion (dead-import/dead-export cleanup after the cut, not an edit to
  keep anything passing, per the Stage 2a — Item 3 precedent above): the
  `send`/`lifecycle`/`result`/`assistant`/`events`(return field)/`tick`/
  `accepted`/`completion`/`nativeFailure`/`interruptArtifact` helpers, and the
  `CommandLifecycleState`/`RuntimeAdmission`/`RuntimeCompletion`/
  `RuntimeSubmission` imports — restore these alongside the 26 blocks, since
  the restored cases need them again.

- **File / case:** `packages/agent-runtime/claude-code/tests/session.test.ts`
  — `describe('resident session over real pipes') > it('returns admission
  and per-request answers, reusing one process for subsequent input')` (1 of
  5 cases in the file; the other 4 call `session.submit()` with one argument
  and are unaffected). **Contract pinned:** a resident session reuses one
  native process across sequential inputs, each gets its own completion, and
  `command_lifecycle`/`stream`/`result` protocol events interleave in the
  expected order (assistant text observed before the matching result).
  **Failure:** calls `session.submit('hello', {}, 'A')` /
  `session.submit('again', {}, 'B')`, the three-argument form; also fails
  Driver 3 below in the same case. **Contract still holds; restore in the
  final PR** by dropping the middle `{}` argument from both calls (alongside
  the Driver 3 fix below).

**Driver 3 — the public `command_lifecycle` `ClaudeProtocolEvent` variant
removed (D14, already applied to `src/rpc.ts`/`src/runtime-activity.ts`/
`src/types.ts` before this round's gate pass; the internal stream-json
`command_lifecycle` parsing this deletes is unrelated and untouched).** Two
cases compared a live `ClaudeProtocolEvent.kind` against the literal
`'command_lifecycle'`, which is no longer in the type's kind union
(`'result' | 'interrupted' | 'stream'`) — `TS2367`/`TS2339` (`Property
'state' does not exist on type 'never'`). Both cases are already counted
above under Driver 2, since both also called the dropped-argument
`submit()`/`send()` form in the same body:
- `rpc.test.ts` — `'emits no further protocol callback when a lifecycle
  observer stops the session'` (`native failure and transport lifetime`,
  listed above).
- `session.test.ts` — `'returns admission and per-request answers, reusing
  one process for subsequent input'` (listed above).
No case fails Driver 3 alone. **Restore recipe, folded into the two entries
above:** the underlying `command_lifecycle` observation these two cases
asserted no longer has a public surface to assert against post-D14 (the
runtime's `onProtocolEvent` callback never emits that kind); the final PR
either drops that assertion from each restored case or restores it against
whatever replacement surface D14's `rpc.ts` internal `command_lifecycle`
admission tracking exposes by then.

**Not a Driver-1/2/3 case, noticed in passing:** `codex-runtime.test.ts`'s
now-deleted `AgentRuntimeProvider public surface` describe block was the
package's only compile-time check that `CodexRuntime` satisfies the public
`AgentRuntime` interface with no extra required members. No other file in
the package currently asserts this; flagging for the final PR's restoration
pass rather than silently leaving the gap unrecorded.
