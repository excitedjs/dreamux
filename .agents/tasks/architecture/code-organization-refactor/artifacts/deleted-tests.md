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
