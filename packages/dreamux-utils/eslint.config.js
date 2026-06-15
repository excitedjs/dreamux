// Thin re-export of the shared synchronous-blocking-IO lint gate (issue #85).
// The single source of rules/scoping is @excitedjs/eslint-config; this file
// only wires it into this package so `npm run lint` / `rush lint` pick it up.
import config from '@excitedjs/eslint-config';

export default config;
