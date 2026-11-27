# Slice 3 Product Shape — Review and Recommendation

Slice 3 feels heavier than expected for one reason: the four `plugin` commands are small and fit a headless Dispatcher agent, while `dreamux channel add` pulls in onboarding, requires a terminal, and collides with current config invariants. **Recommend Option B**: defer `channel add`, ship the four `plugin` commands with the adjudicated fixes, and settle channel wiring with config self-maintenance and channel-less onboarding.

## 1. Product surface for live plugin install and channel wiring

- `dreamux plugin add <npm-pkg>` — agent or human, **no terminal**. Installs into `<root>/plugins`, verifies load, appends `npm:<pkg>` to `plugins[]`.
- `dreamux plugin remove <npm-pkg>` and `dreamux plugin list` — agent or human, **no terminal**.
- `dreamux plugin run <npm-pkg> [args...]` — human when interactive (Weixin QR scan), agent when non-interactive; Dreamux names no verb (`plugin/run.ts:12-17`).
- `dreamux daemon restart` — agent or human, **no terminal**.
- **Channel wiring**: defer `channel add`. In this slice, the agent or human writes the `dispatchers[]` entry in `config.json`. This **removes** `onboard/channel-add.ts` and `cli/commands/channel.ts` (~130 lines) and all three Card 2 defects (`review-s3-adjudication.md:63-65`).

In the follow-up, channel wiring must be **non-interactive first** (explicit flags/JSON or a `config` Command, with TTY prompts optional), because the primary caller is a terminal-less Dispatcher agent (`requirement.md:255-258`; `onboard/channel-add.ts:25` locks agents out) **[needs operator ruling]**.

## 2. Where channel wiring belongs (and Feishu in onboarding)

The operator's remark that Feishu does not belong in onboarding names the root coupling: `config/config.ts:534-538` forbids a zero-channel Dispatcher, and `onboard/wizard.ts:97, 203` defaults onboarding to `builtin:feishu`. Because every onboarded Dispatcher already carries Feishu, Option A ("append to an existing Dispatcher") creates the unsupported Feishu+Weixin pair (`requirement.md:301-302, 455`) or still requires a manual edit.

- **Onboarding** should create only host essentials: config, agent runtime, a zero-channel Dispatcher (lifting `config/config.ts:534-538` **[needs operator ruling]**), and optional service. That removes Feishu's special case.
- **Channel wiring** belongs in Dreamux's config-mutation layer (one non-interactive CLI or Command for attaching/detaching channels on existing or new Dispatchers) — **not** in onboarding (which avoids external plugins, `requirement.md:311`) and **not** in a plugin's CLI (which would duplicate `config.json` writes, mode `0600`, and schema checks across third-party packages).

## 3. Which commands earn their place, and what is missing end-to-end

- **Keep**: `plugin add`, `remove`, `list`, `run` — symmetric on `<npm-pkg>`, paid for by live self-install (`requirement.md:255-258`) and verb-free forwarding (`requirement.md:231-236`).
- **Defer**: `channel add` — TTY-only, and Option A collides with Feishu-in-onboarding and the next PR's config self-maintenance.
- **Missing for end-to-end Weixin** (Slice 1 code does not exist yet, so grounded in `requirement.md` and `plugin/run.ts`, not inspected Slice 1 code):
  1. `plugin/run.ts:27-30` forwards only args, cwd, and env; Weixin's `login` must define how it resolves the target Dispatcher/channel state file before first start.
  2. A headless Dispatcher cannot scan a terminal QR; a human must run `plugin run ... login` in a shell, or Weixin's `login` must print the raw QR URL for the agent to relay.
  3. The accepted `config.agents.replace` lost-write window (`requirement.md:269-273`).

## 4. Smallest slice vs. follow-up

- **Smallest slice (Option B)**: ship the four `plugin` commands plus adjudicated Cards 1, 3, and 4; delete `channel add`. End-to-end Weixin works via `plugin add` → edit `dispatchers[]` in `config.json` → `plugin run @excitedjs/weixin-channel login` → `daemon restart`.
- **One follow-up PR**: unify Dispatcher config self-maintenance (closing the lost-write window), drop Feishu from onboarding (allowing zero-channel Dispatchers), and add one non-interactive channel-wiring surface.

## 5. What will hurt later (and what should come back)

- **No local/non-npm path**: `registry/provider-ref.ts:89-99` and `plugin/resolve.ts:74-83` accept only bare npm package names in `<root>/plugins`, forcing manual symlinks for local plugin development. From my earlier `draft-plugin-surface.md`, `file:<abs-path>` (or `plugin add --link <dir>`) still earns its place **[needs operator ruling]**. (`plugin setup` and `ChannelProvider.login` should **not** come back.)
- **Two-name split (`npm:<pkg>` vs `builtin:<name>`)**: CLI takes package names while `config.json` stores `builtin:<name>`, forcing `plugin remove` to load the plugin to check usage (`plugin/manage.ts:179-211`).
- **`plugin run` pre-yargs bypass (`final.md:788-792`; `cli/dreamux.ts` not read directly) and single-`bin` rule (`plugin/run.ts:62-69`)**: `dreamux plugin run --help` fails as an invalid package name (`review-s3-adjudication.md:152`), and multi-binary packages are rejected.
