# @excitedjs/eslint-config

Private (unpublished) workspace package: the single source of the dreamux
monorepo's **synchronous-blocking-IO lint gate** (issue #85).

dreamux is one Node process driving N dispatchers off a single event loop, so a
`fs.*Sync` / `child_process.execSync|spawnSync` call in runtime code stalls every
concurrent session. This config makes such calls a hard error in source.
It also caps package source files at 700 code lines (blank lines and comments
excluded) as a smell detector for a module carrying more than one
responsibility — see the `max-lines` bullet below for the two legitimate
responses to a file tripping it.

## What it enforces

- **`n/no-sync`** (primary) — flags any callee whose name ends in `Sync`.
- **`max-lines`** — flags `src/**/*.ts` files over 700 code lines (blank lines
  and comments excluded). This is a smell detector, not a budget: the two
  legitimate responses are giving the responsibility that wants its own owner
  a real named module, or recording the file as a micro-refactor candidate for
  the operator to schedule. Trimming comments/whitespace or exiling a helper
  just to duck the gate is itself a violation (whitepaper §6).
- **`no-restricted-imports`** (backstop) — bans `Sync$` named imports from
  `fs` / `child_process`, closing the renamed-import bypass.
- **`no-restricted-syntax`** (backstop) — bans `const { readFileSync: x } = fs`
  destructure rebinding.
- **`eslint-comments/require-description`** + `reportUnusedDisableDirectives` —
  every sync exemption must be a reasoned, non-stale inline disable.
- **`no-restricted-syntax` package-wide re-export ban** (opt-in via
  `withPackageEntryOnlyReexports(baseConfig, { entryFiles })`) — bans
  `export * from` / `export { X } from` outside a package's declared
  `entryFiles`. Only a package's own entry point(s) may re-export another
  module; every other file must be imported directly, so ownership of a name
  is never hidden behind a barrel. `error`.
- **`dreamux/no-dumping-ground-filename`** (package-wide, always on) — flags a
  filename matching `*-helpers.ts` / `*-support.ts` / `*-ops.ts` /
  `run-support.ts` / `runtime-session.ts`: a name that describes no single
  responsibility. `warn` while the code-organization refactor's later stages
  still have live matches scheduled for deletion or fold-in; flips to `error`
  once they are gone.

It is **focused**: no `eslint:recommended` / typescript-eslint recommended sets,
and pure-syntactic (the typescript-eslint parser runs without
`parserOptions.project`), so `rush lint` needs no prior build.

## Scope

| Glob | `n/no-sync` | Notes |
| --- | --- | --- |
| `src/**/*.ts` | error | runtime / CLI source — no synchronous blocking IO; max 700 code lines |
| `tests/**/*.ts` | off | synchronous fs fixtures allowed; sync `child_process` still banned |

Tightening tests further (converting fixture IO to async) is deliberately
deferred to a separate change — see issue #85.

## Usage

Each package re-exports it from a thin `eslint.config.js`:

```js
import config from '@excitedjs/eslint-config';
export default config;
```

and adds `"lint": "eslint ."` plus `eslint` + `@excitedjs/eslint-config`
(`workspace:*`) to devDependencies. `rush lint` fans the script out across the
workspace.
