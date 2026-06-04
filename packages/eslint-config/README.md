# @excitedjs/eslint-config

Private (unpublished) workspace package: the single source of the dreamux
monorepo's **synchronous-blocking-IO lint gate** (issue #85).

dreamux is one Node process driving N dispatchers off a single event loop, so a
`fs.*Sync` / `child_process.execSync|spawnSync` call in runtime code stalls every
concurrent session. This config makes such calls a hard error in source.

## What it enforces

- **`n/no-sync`** (primary) — flags any callee whose name ends in `Sync`.
- **`no-restricted-imports`** (backstop) — bans `Sync$` named imports from
  `fs` / `child_process`, closing the renamed-import bypass.
- **`no-restricted-syntax`** (backstop) — bans `const { readFileSync: x } = fs`
  destructure rebinding.
- **`eslint-comments/require-description`** + `reportUnusedDisableDirectives` —
  every sync exemption must be a reasoned, non-stale inline disable.

It is **focused**: no `eslint:recommended` / typescript-eslint recommended sets,
and pure-syntactic (the typescript-eslint parser runs without
`parserOptions.project`), so `rush lint` needs no prior build.

## Scope

| Glob | `n/no-sync` | Notes |
| --- | --- | --- |
| `src/**/*.ts` | error | runtime / CLI — no synchronous blocking IO |
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
