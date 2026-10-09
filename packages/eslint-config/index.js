/**
 * Shared ESLint flat config for the dreamux monorepo (issue #85).
 *
 * Single purpose: forbid synchronous, event-loop-blocking IO in runtime / CLI
 * source. dreamux is one Node process driving N dispatchers off a single event
 * loop; any `fs.*Sync` / `child_process.execSync|spawnSync` call stalls every
 * concurrent session. This config is the hard gate that keeps such calls out.
 *
 * Scope (see issue #85 convergence):
 *   - `src/**\/*.ts`   — hard error. No synchronous blocking IO.
 *   - `tests/**\/*.ts` — `n/no-sync` is OFF (synchronous fixture IO is fine in
 *                        a test process that is not the server event loop). The
 *                        sole remaining test restriction is on synchronous
 *                        child_process imports, so new sync subprocess usage in
 *                        tests still has to be justified with a reasoned
 *                        disable. The two existing call sites
 *                        (bin-launcher / codex-live) carry such disables.
 *
 * Rule set (issue #85 convergence — primary + backstops):
 *   - max-lines .................. source files over 700 *code* lines (blank
 *                                  lines and comments excluded) are a hard
 *                                  error. This is a smell detector, not a
 *                                  budget: the two legitimate responses to a
 *                                  file tripping it are finding the
 *                                  responsibility that wants its own owner
 *                                  and giving it a real named module, or
 *                                  recording the file as a micro-refactor
 *                                  candidate for the operator to schedule.
 *                                  Trimming comments/whitespace or exiling
 *                                  one or two small helpers to duck the gate
 *                                  is itself a violation (whitepaper §6).
 *   - n/no-sync .................. primary. Matches any callee whose name ends
 *                                  in `Sync` (the Node convention), so it
 *                                  catches `readFileSync()`, `fs.mkdirSync()`,
 *                                  `execSync()`, etc. at the call site.
 *   - no-restricted-imports ...... backstop #1. n/no-sync matches the *call
 *                                  site*, so a renamed import
 *                                  `import { readFileSync as read }` followed by
 *                                  `read()` would slip through. This bans the
 *                                  `Sync$` named imports outright.
 *   - no-restricted-syntax ....... backstop #2. Bans the destructure form
 *                                  `const { readFileSync: read } = fs`, the
 *                                  other way to rebind a Sync export away from
 *                                  its detectable name.
 *   - eslint-comments/require-description + reportUnusedDisableDirectives:
 *                                  every `eslint-disable` for a sync exemption
 *                                  must carry a written reason, and a stale
 *                                  disable is itself an error. This is the
 *                                  auditable exemption mechanism.
 *
 * This config intentionally does NOT pull in `eslint:recommended` or the
 * typescript-eslint recommended sets: the issue is a focused sync-IO gate, not
 * a repo-wide lint overhaul. It is pure-syntactic — the typescript-eslint
 * parser is configured WITHOUT `parserOptions.project`, so no type information
 * is needed and lint runs without a prior build.
 */

import tseslint from 'typescript-eslint';
import n from 'eslint-plugin-n';
import comments from '@eslint-community/eslint-plugin-eslint-comments';

// eslint-plugin-n is pinned to 17.18.0 on purpose: from 17.19.0 onward
// `n/no-sync` calls getParserServices() unconditionally to support a *typed*
// `ignores` option, which forces `parserOptions.project` (type-aware linting)
// even when no typed ignore is used. We deliberately keep this gate
// pure-syntactic (no project / no build needed), and do not use typed ignores,
// so we stay on the last syntactic-only release. Revisit the pin only together
// with a move to type-aware linting.

/** Modules whose synchronous (`*Sync`) exports must never be imported. */
const FS_AND_CHILD_PROCESS = [
  'node:fs',
  'fs',
  'node:child_process',
  'child_process',
];
const CHILD_PROCESS_ONLY = ['node:child_process', 'child_process'];

/** `no-restricted-imports` option banning `Sync$` named imports from `groups`. */
function bannedSyncImports(groups, message) {
  return [
    'error',
    {
      patterns: [
        {
          group: groups,
          importNamePattern: 'Sync$',
          message,
        },
      ],
    },
  ];
}

/**
 * `no-restricted-syntax` selector for `const { readFileSync: x } = fs` style
 * destructuring of a `Sync$` member. Anchored to a destructure whose key ends
 * in `Sync`; narrow enough to leave unrelated `*Sync`-keyed objects alone in
 * practice, and any false positive is handled by a reasoned inline disable.
 */
const SYNC_DESTRUCTURE_SELECTOR = {
  selector:
    'VariableDeclarator > ObjectPattern > Property[key.name=/Sync$/][computed=false]',
  message:
    'Destructuring a synchronous (*Sync) member is banned in runtime/CLI source (issue #85). Use the node:fs/promises (async) API instead.',
};

// Re-exported so a package that needs to ADD its own `no-restricted-syntax`
// selectors to a scoped subset of files can compose them with the shared sync
// gate instead of replacing it (flat-config rule options are replaced, not
// merged, on the last matching block). See the dreamux-types neutral-contract
// guard.
export { SYNC_DESTRUCTURE_SELECTOR };

/**
 * The neutrality import boundary (issue #209 polymorphism). Pluginization is
 * polymorphism: core calls only the neutral `@excitedjs/dreamux-types`
 * contracts, and a provider package implements them against `dreamux-types`
 * only — neither side statically imports the other. These two helpers express
 * the two directions of that boundary as a hard lint error, layered ON TOP of
 * the shared sync-IO gate (merged into `no-restricted-imports`, so flat-config
 * last-wins does not drop the red-line sync gate). They are repo-wide policy,
 * so they live here rather than being re-coded in each consuming package.
 */

/** Packages that core (`@excitedjs/dreamux`) must never statically import. */
const PROVIDER_PACKAGES_BAN = {
  group: [
    '@excitedjs/agent-runtime-codex',
    '@excitedjs/agent-runtime-codex/*',
    '@excitedjs/agent-runtime-claude-code',
    '@excitedjs/agent-runtime-claude-code/*',
    '@excitedjs/feishu-channel',
    '@excitedjs/feishu-channel/*',
    '@excitedjs/feishu-transport',
    '@excitedjs/feishu-transport/*',
    '@excitedjs/dreamux-plugin-bootstrap',
    '@excitedjs/dreamux-plugin-bootstrap/*',
  ],
  message:
    'Core (@excitedjs/dreamux) must not import a provider, plugin, or Feishu ' +
    'platform-I/O package. Call the neutral @excitedjs/dreamux-types contract ' +
    'instead; builtin:* resolves to a package name the dynamic loader imports at ' +
    'runtime (issue #209 polymorphism boundary).',
};

/** The core host package that a provider package must never import. */
const CORE_PACKAGE_BAN = {
  group: ['@excitedjs/dreamux', '@excitedjs/dreamux/*'],
  message:
    'A provider package must depend on @excitedjs/dreamux-types (and dreamux-utils) ' +
    'ONLY — it must never import @excitedjs/dreamux core. The provider implements ' +
    'the neutral contract; it never reaches back into the host (issue #209 ' +
    'polymorphism boundary).',
};

/** Merge extra `no-restricted-imports` patterns into a config's `src/**` block, preserving the sync gate. */
function withSrcImportBans(baseConfig, patterns) {
  return baseConfig.map((block) => {
    if (!Array.isArray(block.files) || !block.files.includes('src/**/*.ts')) {
      return block;
    }
    const restricted = block.rules?.['no-restricted-imports'];
    const options = Array.isArray(restricted) ? (restricted[1] ?? {}) : {};
    return {
      ...block,
      rules: {
        ...block.rules,
        'no-restricted-imports': [
          'error',
          { ...options, patterns: [...(options.patterns ?? []), ...patterns] },
        ],
      },
    };
  });
}

/** Core host lint config: shared gate + "core must not import a provider". */
export function withCoreImportBoundary(baseConfig) {
  return withSrcImportBans(baseConfig, [PROVIDER_PACKAGES_BAN]);
}

/** Provider package lint config: shared gate + "provider must not import core". */
export function withProviderImportBoundary(baseConfig) {
  return withSrcImportBans(baseConfig, [CORE_PACKAGE_BAN]);
}

/**
 * Package-wide re-export ban (code-organization refactor, H6). A module must
 * not re-export another module's surface (`export * from` / `export { X }
 * from`) — that hides which module actually owns `X` behind a package-wide
 * grep and invites a barrel-of-barrels shape. Only a package's own declared
 * entry point(s) legitimately do this, since re-exporting the package's
 * public surface is what an entry point is for.
 */
const PACKAGE_REEXPORT_SELECTORS = [
  {
    selector: 'ExportAllDeclaration',
    message:
      "A module must not re-export another module's whole surface. Import the owning module directly, or add an intentional export to the package entry point.",
  },
  {
    selector: 'ExportNamedDeclaration[source]',
    message:
      'A module must not re-export another module. Import the owning module directly, or add an intentional export to the package entry point.',
  },
];

/**
 * Entry-point-only re-export ban: appends a NEW config block on top of
 * `baseConfig` rather than mutating its `src/**\/*.ts` block. Flat-config
 * merges rule *keys* across matching blocks but replaces a single key's
 * option array wholesale on the last match — so this block must carry
 * `SYNC_DESTRUCTURE_SELECTOR` too (dropping it here would silently disable
 * the issue #85 sync-destructure backstop for every file this block matches,
 * since its `no-restricted-syntax` value would win over the base block's for
 * the same rule key). `entryFiles` is the caller's own package-relative list
 * (its declared public entry points; core has none that re-export).
 */
export function withPackageEntryOnlyReexports(baseConfig, { entryFiles }) {
  return [
    ...baseConfig,
    {
      files: ['src/**/*.ts'],
      ignores: entryFiles,
      rules: {
        'no-restricted-syntax': [
          'error',
          SYNC_DESTRUCTURE_SELECTOR,
          ...PACKAGE_REEXPORT_SELECTORS,
        ],
      },
    },
  ];
}

/**
 * "Dumping ground" filename ban (code-organization refactor, H4). A file
 * named `*-helpers.ts` / `*-support.ts` / `*-ops.ts` / a bare `run-support.ts`
 * / `runtime-session.ts` names no single responsibility, which is exactly
 * what invites unrelated functions to keep landing in it. Filename-only, so
 * it is a small inline rule (no stock ESLint rule reports on a filename) —
 * package-wide by default via `sharedPlugins`/the base `src/**\/*.ts` block
 * below, not an opt-in helper like the boundary functions above, since it has
 * no per-package parameter to supply. Severity is `error`: the
 * code-organization refactor deleted or folded in every prior match, so a
 * new one is a regression to reject, not a warning to tolerate.
 */
const DUMPING_GROUND_FILENAME_PATTERNS = [
  /-helpers\.ts$/,
  /-support\.ts$/,
  /-ops\.ts$/,
  /^run-support\.ts$/,
  /^runtime-session\.ts$/,
];

const dreamuxPlugin = {
  rules: {
    'no-dumping-ground-filename': {
      meta: {
        type: 'suggestion',
        docs: {
          description:
            'disallow filenames that describe no single responsibility',
        },
        schema: [],
      },
      create(context) {
        return {
          Program(node) {
            const filename = context.filename.split(/[\\/]/).pop() ?? '';
            if (
              DUMPING_GROUND_FILENAME_PATTERNS.some((pattern) =>
                pattern.test(filename),
              )
            ) {
              context.report({
                node,
                message:
                  'Filename names no single responsibility (matches *-helpers.ts / *-support.ts / *-ops.ts / run-support.ts / runtime-session.ts). Name the file for the one thing it owns, or fold it into its owner.',
              });
            }
          },
        };
      },
    },
  },
};

const baseLanguageOptions = {
  parser: tseslint.parser,
  ecmaVersion: 2023,
  sourceType: 'module',
};

const sharedPlugins = {
  n,
  '@eslint-community/eslint-comments': comments,
  dreamux: dreamuxPlugin,
};

/**
 * The shared flat-config array. Consuming packages re-export it from their own
 * thin `eslint.config.js`; the `files` globs are relative to each package root,
 * which all share the `src/` + `tests/` layout.
 */
export default [
  {
    ignores: ['**/dist/**', '**/node_modules/**'],
  },
  // Runtime / CLI source: synchronous blocking IO is a hard error.
  {
    files: ['src/**/*.ts'],
    languageOptions: baseLanguageOptions,
    plugins: sharedPlugins,
    linterOptions: {
      reportUnusedDisableDirectives: 'error',
    },
    rules: {
      'max-lines': [
        'error',
        { max: 700, skipBlankLines: true, skipComments: true },
      ],
      'n/no-sync': ['error', { allowAtRootLevel: false }],
      'no-restricted-imports': bannedSyncImports(
        FS_AND_CHILD_PROCESS,
        'Synchronous IO is banned in runtime/CLI source (issue #85): it blocks the single dreamux event loop. Import from node:fs/promises, or use the async child_process API.',
      ),
      'no-restricted-syntax': ['error', SYNC_DESTRUCTURE_SELECTOR],
      '@eslint-community/eslint-comments/require-description': [
        'error',
        { ignore: [] },
      ],
      'dreamux/no-dumping-ground-filename': 'error',
    },
  },
  // Tests: synchronous fs fixtures are fine (not the server event loop). Only
  // synchronous child_process stays banned so new sync subprocess usage still
  // needs a reasoned disable.
  {
    files: ['tests/**/*.ts'],
    languageOptions: baseLanguageOptions,
    plugins: sharedPlugins,
    linterOptions: {
      reportUnusedDisableDirectives: 'error',
    },
    rules: {
      'n/no-sync': 'off',
      'no-restricted-imports': bannedSyncImports(
        CHILD_PROCESS_ONLY,
        'Synchronous child_process (execSync/spawnSync) is banned even in tests (issue #85). Prefer the async API; if a black-box CLI test genuinely needs it, justify with a reasoned eslint-disable.',
      ),
      'no-restricted-syntax': 'off',
      '@eslint-community/eslint-comments/require-description': [
        'error',
        { ignore: [] },
      ],
    },
  },
];
