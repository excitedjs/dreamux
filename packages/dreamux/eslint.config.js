// Core lint config for @excitedjs/dreamux.
//
// Base: the shared synchronous-blocking-IO gate (issue #85), the single source
// of rules/scoping in @excitedjs/eslint-config.
//
// Plus a dreamux-only neutrality guardrail (issue #209): core MUST NOT import a
// provider package. Pluginization is polymorphism — core calls only the neutral
// @excitedjs/dreamux-types contracts and resolves `builtin:*` to a package NAME
// (a string) that the dynamic loader imports at runtime. A static import of a
// provider package re-forms the boundary this whole cleanup removed. This is
// MERGED into the shared `no-restricted-imports` rule for `src/**` so it composes
// with the #85 sync-IO ban instead of replacing it (flat-config last-wins would
// otherwise drop the red-line sync gate).
import baseConfig from '@excitedjs/eslint-config';

/**
 * Packages core must never statically import (issue #209): the builtin provider
 * packages AND the Feishu platform-I/O package. Core calls only the neutral
 * @excitedjs/dreamux-types contracts; it names no provider and owns no Feishu
 * transport (the feishu-channel package owns feishu-transport end-to-end).
 */
const PROVIDER_PACKAGE_BAN = {
  group: [
    '@excitedjs/agent-runtime-codex',
    '@excitedjs/agent-runtime-codex/*',
    '@excitedjs/agent-runtime-claude-code',
    '@excitedjs/agent-runtime-claude-code/*',
    '@excitedjs/feishu-channel',
    '@excitedjs/feishu-channel/*',
    '@excitedjs/feishu-transport',
    '@excitedjs/feishu-transport/*',
  ],
  message:
    'Core (@excitedjs/dreamux) must not import a provider or Feishu platform-I/O ' +
    'package. Call the neutral @excitedjs/dreamux-types contract instead; builtin:* ' +
    'resolves to a package name the dynamic loader imports at runtime (issue #209 ' +
    'polymorphism boundary).',
};

/** Add the provider-package ban to a block's `no-restricted-imports`, keeping its existing options. */
function withProviderBan(block) {
  const restricted = block.rules?.['no-restricted-imports'];
  const options = Array.isArray(restricted) ? (restricted[1] ?? {}) : {};
  return {
    ...block,
    rules: {
      ...block.rules,
      'no-restricted-imports': [
        'error',
        { ...options, patterns: [...(options.patterns ?? []), PROVIDER_PACKAGE_BAN] },
      ],
    },
  };
}

export default baseConfig.map((block) =>
  Array.isArray(block.files) && block.files.includes('src/**/*.ts')
    ? withProviderBan(block)
    : block,
);
