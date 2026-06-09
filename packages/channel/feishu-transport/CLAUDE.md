# @excitedjs/feishu-transport

This package is the Feishu/Lark platform boundary. Treat it as an external
package that exposes Lark SDK / JSAPI capabilities to channel layers.

## Responsibilities

- Own the `@larksuiteoapi/node-sdk` import and direct Lark API calls.
- Provide low-level JSAPI-shaped operations for connection, inbound event
  delivery, outbound message calls, reactions, resource APIs, and other Feishu
  platform capabilities.
- Keep exported types and results platform-oriented, not Dreamux- or
  agent-oriented.
- Keep the package usable by multiple hosts. Dreamux and claudemux must not
  depend on each other through this package.

## Boundaries

- Do not couple this package to Dreamux dispatcher state, runtime paths,
  Codex threads, cache directories, access-file layout, or logging layout.
- Do not assemble the `<channel source="feishu" …>` envelope or `<attachment>` blocks.
- Do not serialize or deserialize agent-facing message body formats.
- Do not parse model replies or any special format emitted by an agent.
- Do not own attachment cache layout, retention, preview extraction, or
  fallback text. Those are channel-layer responsibilities.
- Do not add Dreamux-only behavior here. If a feature needs Dreamux state or
  Codex-facing UX, put it in `@excitedjs/feishu-channel` or `@excitedjs/dreamux`.

## Existing Compatibility Surface

Some current exports are shared parsing/rendering/policy primitives from earlier
work. Do not use them as precedent for adding Dreamux-specific serialization.
When touching them, keep changes engine-agnostic and avoid expanding this
package toward channel orchestration.

## Upstream / Downstream Contract

- Upstream: the Feishu/Lark SDK and platform JSON contracts.
- Downstream: `@excitedjs/feishu-channel`, `@excitedjs/dreamux`, and external
  consumers that need platform I/O primitives.
- If a downstream caller needs attachment download/cache policy or
  Codex-friendly formatting, expose only the low-level Lark resource operation
  here and implement policy/formatting in the channel package.
