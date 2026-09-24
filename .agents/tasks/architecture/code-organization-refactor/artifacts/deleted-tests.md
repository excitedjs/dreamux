# Deleted tests ledger

This is the ledger for the final test completion on PR #453. Every pull
request in the code-organization-refactor stack writes no new unit tests and
repairs none: a test case that no longer passes is deleted outright, never
re-pointed or edited to pass. Each entry below records the test file and case
name, the contract that test pinned, and the failure that made it fail after
this stage's change, so the final test completion on PR #453 can restore the
coverage under the new contract.

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

- **File / case:** `packages/channel/feishu-channel/tests/feishu-extensions.test.ts` —
  `it('describes every registered extension with its tools, their caller
  kinds, and its card actions', ...)`.
  **Contract pinned:** the provider's diagnostic detail text lists every
  registered extension's tools with their caller kinds and its card action
  keys.
  **Failure:** same R35 return-type change; the fixture's card action
  `{ key: 'alpha_ack', handle: async () => ({}) }` no longer type-checks.
