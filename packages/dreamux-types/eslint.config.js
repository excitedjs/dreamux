// Lint config for @excitedjs/dreamux-types.
//
// Base: the shared synchronous-blocking-IO gate (issue #85). Plus a neutral-
// contract guard: the published runtime contract (agent-runtime.ts, turn.ts) is
// the seam every provider implements and core depends on. It must stay neutral —
// it must never NAME a provider-specific field (channel routing/identity such as
// chat_id / app_id / sender_id / message_id belongs to the channel layer; a
// runtime turn carries only neutral text + a dedupe id + opaque passthrough; see
// packages/dreamux/CLAUDE.md boundaries). This bans declaring such a field name
// as an interface/type property key in those two files.
//
// Scoped to the RUNTIME contract files on purpose — this is a principle, not a
// frozen shape. The boundary is "a runtime turn must not route/identify on
// provider fields"; routing/identity legitimately BELONGS to the channel layer.
// So `channel.ts` (the ChannelProvider contract) rightly declares `message_id`
// and must NOT be covered here, and core has many legitimate `chat_id` uses
// (MCP tool descriptions, reads off an opaque `meta` bag, Team binding compat).
// A whole-package or repo-wide ban would be wrong AND false-positive. Do not
// broaden this scope; if the runtime contract is ever split into more files,
// update this list together with the decision record (the rule moves on
// purpose, it is not silently bypassed). The selector matches only a declared
// property KEY, never a comment or a string-literal example.
import baseConfig, { SYNC_DESTRUCTURE_SELECTOR } from '@excitedjs/eslint-config';

/** Provider-specific field names that must not appear as a contract property key. */
const PROVIDER_FIELD_NAME = [
  'chat_id',
  'chat_type',
  'app_id',
  'sender_id',
  'open_id',
  'union_id',
  'user_id',
  'message_id',
  'root_id',
  'parent_id',
  'tenant_key',
];

const NEUTRAL_CONTRACT_FIELD_BAN = {
  // A property KEY (interface/type member) whose name is a provider field.
  // `TSPropertySignature > Identifier` is only the key; the type annotation is
  // nested under TSTypeAnnotation, so it is not matched.
  selector: `TSPropertySignature > Identifier[name=/^(${PROVIDER_FIELD_NAME.join('|')})$/]`,
  message:
    'The neutral AgentRuntime/turn contract must not name a provider-specific ' +
    'field. Channel routing/identity (chat_id, sender_id, message_id, …) stays in ' +
    'the channel layer; a runtime turn carries neutral text + a dedupe id + opaque ' +
    'passthrough only (packages/dreamux/CLAUDE.md boundaries).',
};

export default [
  ...baseConfig,
  {
    // Compose with the shared `no-restricted-syntax` (rule options are replaced,
    // not merged, by the last matching block) so the sync-destructure backstop
    // is preserved for these files alongside the contract-field ban.
    files: ['src/agent-runtime.ts', 'src/turn.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        SYNC_DESTRUCTURE_SELECTOR,
        NEUTRAL_CONTRACT_FIELD_BAN,
      ],
    },
  },
];
