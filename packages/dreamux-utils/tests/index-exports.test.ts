/**
 * Public export surface guard for @excitedjs/dreamux-utils (index.ts).
 *
 * `index.ts` is a set of `export *` barrels over every module in `src/`. This
 * pins the exact runtime-visible name set so an accidental addition (a helper
 * meant to stay module-private) or removal (a consumer-facing break) shows up
 * as a failing test instead of silently drifting. Type-only exports (interfaces,
 * type aliases) are invisible at runtime and therefore excluded from this list
 * by construction — only classes, functions, and const values appear here.
 */
import { describe, it, expect } from 'vitest';

import * as api from '../src/index.js';

const EXPECTED_RUNTIME_EXPORTS = [
  // config-validate.ts
  'isPlainObject',
  'describeType',
  'rejectUnknownKeys',
  'requireNonEmptyString',
  'readOptionalString',
  'readOptionalBoolean',
  'requireStringArray',
  'requireStringRecord',
  'requirePositiveInt',
  'readProviderConfigObject',
  // os.ts
  'isProcessAlive',
  'isProcessGroupAlive',
  'killProcessGroup',
  'ensureOwnerOnlyDir',
  'removeEmptyLogFile',
  'pathExists',
  // fs.ts
  'writeAtomic',
  // completion-body.ts
  'COMPLETION_INLINE_BUDGET_DEFAULT',
  'COMPLETION_INLINE_BUDGET_MAX',
  'completionInlineBudget',
  'resolveCompletionBody',
  // socket-budget.ts
  'DREAMUX_UNIX_SOCKET_PATH_MAX_BYTES',
  'unixSocketPathFitsBudget',
  'assertUnixSocketPathBudget',
  // supervised-child.ts
  'SupervisedChild',
  // activity-scan.ts
  'SCAN_DISCOVERY_MAX_ENTRIES',
  'SCAN_DISCOVERY_MAX_ELAPSED_MS',
  'scanDigest',
  'isScanDigest',
  'createScanBudget',
  'readBytesAt',
  'isPathWithin',
  // unsupported-feature.ts
  'unsupportedFeatureError',
  'isUnsupportedFeatureError',
  // runtime-state-fence.ts
  'STATE_LEASE_REVOKED_ERROR_NAME',
  'RuntimeStateFencedError',
  'isStateLeaseRevoked',
  'RuntimeStateFence',
  // json-invoke.ts
  'PublicInvokeFailure',
  'settleJsonInvoke',
].sort();

describe('@excitedjs/dreamux-utils public export surface', () => {
  it('exposes exactly the intended runtime name set — no more, no less', () => {
    const actual = Object.keys(api).sort();
    expect(actual).toEqual(EXPECTED_RUNTIME_EXPORTS);
  });

  it('re-exports every module listed in index.ts (barrel completeness sanity)', () => {
    // A representative name from each of the ten src modules, so a barrel line
    // silently dropped from index.ts fails here even if the full-list
    // comparison above were ever loosened.
    const representative: Record<string, keyof typeof api> = {
      'config-validate.ts': 'isPlainObject',
      'os.ts': 'pathExists',
      'fs.ts': 'writeAtomic',
      'completion-body.ts': 'resolveCompletionBody',
      'socket-budget.ts': 'unixSocketPathFitsBudget',
      'supervised-child.ts': 'SupervisedChild',
      'activity-scan.ts': 'isPathWithin',
      'unsupported-feature.ts': 'isUnsupportedFeatureError',
      'runtime-state-fence.ts': 'RuntimeStateFence',
      'json-invoke.ts': 'settleJsonInvoke',
    };
    for (const [module, name] of Object.entries(representative)) {
      expect(api[name], `${module} should export ${name}`).toBeDefined();
    }
  });
});
