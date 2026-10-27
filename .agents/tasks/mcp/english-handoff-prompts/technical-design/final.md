# Parameter descriptions

Add "Always write the prompt in English." to the five `prompt` descriptions
owned by `service/agent/mcp.ts`, `service/agent/member-mcp.ts`, and
`service/team/mcp.ts` in `packages/dreamux/src/`.

The existing owner TeamMate catalog serves Dispatcher and TeamLeader callers;
the member catalog serves ordinary members. Keep the sentence local to each
schema rather than introducing a helper for a short piece of prose.

Run the repository build, lint, test, and test-typecheck gates, inspect the
advertised parameter descriptions, and obtain independent diff review. Do not
add exact-sentence tests for this prose-only edit.
