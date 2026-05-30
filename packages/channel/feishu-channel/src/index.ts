/**
 * @excitedjs/feishu-channel — the dreamux-side channel layer.
 *
 * Scope (issue excitedjs/dreamux#25): the stateful orchestration that sits on
 * top of the platform-I/O core — ① inbound filter (@-mention gate + access
 * gate), ② conversation→Codex-thread mapping + forwarding. It is dreamux's
 * counterpart of claudemux's proxy/daemon; the two are symmetric but never
 * depend on each other. Both depend only on @excitedjs/feishu-transport.
 *
 * PR0 is scaffold only — no business logic. The re-export below proves the
 * channel → core dependency wiring compiles end-to-end; real exports land in
 * later PRs.
 */

// Re-exported from the core package to verify the dependency edge compiles.
export { FEISHU_TRANSPORT_PACKAGE } from '@excitedjs/feishu-transport';

/** Package identity marker. Replaced by the real public surface in later PRs. */
export const FEISHU_CHANNEL_PACKAGE = '@excitedjs/feishu-channel';
