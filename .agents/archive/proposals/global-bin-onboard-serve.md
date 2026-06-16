# Global `dreamux` bin, `onboard`, and `serve`

- **Status:** Superseded by accepted decision
- **Date:** 2026-06-02
- **Issue:** [issue #18](https://github.com/excitedjs/dreamux/issues/18)
- **Decision:** [global-bin-onboard-serve](../../decisions/global-bin-onboard-serve.md),
  amended by [dispatcher-tm-packaging](../../decisions/dispatcher-tm-packaging.md)

This proposal is retained only as the issue #18 design entry point. The
binding behavior now lives in the accepted decision:

Archive note: the bullets below are a historical bridge from this proposal to
the accepted decision. Current Dreamux injects bundled skills at runtime by role;
`dreamux onboard` no longer installs bundled Codex skill symlinks into
workspace `.codex/skills/`.

- `@excitedjs/dreamux` exports `dreamux` plus the dispatcher-required `tm`
  wrapper.
- At the time of this proposal, `dreamux onboard` was expected to install
  bundled Codex skill symlinks into each dispatcher's workspace-local
  `.codex/skills/` directory. That behavior is now superseded by runtime skill
  injection.
- Dispatcher app-server processes use Codex's global default home for auth,
  config, and memory; dreamux does not set `CODEX_HOME`.
- dreamux-owned state defaults to `~/.dreamux/state/`, and logs default to
  `~/.dreamux/logs/`.
- Codex and Claude plugin marketplace installation is not part of dreamux
  onboarding.
