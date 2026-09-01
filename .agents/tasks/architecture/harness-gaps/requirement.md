# Harness gaps: open items


1. **prompt ↔ MCP registry parity gate (regression).** The
   `prompt-registry-parity` / `mcp-contract-whitelist` tests no longer exist,
   and no test reads the dispatcher base prompt. A removed MCP verb can stay in
   a prompt or bundled skill unnoticed — the one drift class the post-110
   diagnosis rated self-reinforcing.
2. **Dependency-cruiser full-graph gate.** No repo-wide no-circular /
   no-orphans check. The built-CLI smoke now imports `dist/server.js` and the
   service index in one fresh Node process (an ESM cycle gate for that slice),
   but it is not a full dependency-graph check.
3. **Provider-field member-access AST gate.** Core neutrality is guarded by
   text scans; a `no-restricted-syntax` rule against `.chat_id`-style member
   access in `service/**` and `server.ts` is still missing.
4. **Knowledge-delta drift gate.** No CI heuristic asks a PR that touches
   contract files, `paths.ts`, or `eslint-config` to also touch `.agents/` (or
   carry an explicit no-delta marker).
5. **settle-before-register send-lifecycle edge.** A global send/steer
   completion-promise design gap noted by the dispatcher-send proposal; never
   resolved, applies to every send path.

