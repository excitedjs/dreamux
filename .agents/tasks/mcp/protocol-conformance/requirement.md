# MCP protocol conformance: settled rulings

> Distilled 2026-09-01 from the implemented proposal
> [mcp-protocol-conformance](/.agents/archive/proposals/mcp-protocol-conformance.md)
> during the decisions-tree dissolution. These are the rulings a future MCP
> change must not silently re-litigate; current behavior is owned by the
> domains pages and source (`/packages/dreamux/src/mcp/`).

## Settled rulings

1. **Structured results are not duplicated into text blocks (operator ruling).**
   The MCP tool specifications say a server SHOULD serialize structured results
   into a text block for backward compatibility. Dreamux deliberately does not:
   duplicate objects burn model context, and the supported clients (Codex,
   Claude Code) read `structuredContent`. This is a documented exception for
   Dreamux's supported-client contract, not a claim that the recommendation is
   absent or mandatory.
2. **The SDK's lenient legacy pre-init behavior is accepted (operator ruling).**
   `serveStdio({ legacy: 'serve' })` may serve `tools/list` before a standard
   legacy initialize completes. Dreamux adds no transport wrapper, prototype
   patch, fork, vendored SDK, or hand-written lifecycle gate to make the SDK
   stricter.
3. **SDK upgrade admission.** An official SDK upgrade is accepted only when its
   discovery and negotiation tests still advertise and negotiate exactly the
   three supported protocol revisions (`/packages/dreamux/src/mcp/server.ts`).
   A newly added SDK-global modern revision remains unsupported until this
   contract is deliberately revised.
4. **Client baseline forensics (2026-08-13).** Codex CLI 0.147.0 initializes at
   `2025-06-18`; Claude Code 2.1.229 probes `2026-07-28` `server/discover` and
   falls back to `2025-11-25`; neither sends a non-standard bare `initialized`.
   This evidence set the revision floor.
5. **The MCP Tasks extension is deliberately unused.** A submit-style tool's
   result is its receipt; downstream completion rides the completion router,
   not an unfinished MCP operation. Adopting Tasks would change cancellation,
   retention, polling, and result-ownership semantics and needs its own
   contract first.
