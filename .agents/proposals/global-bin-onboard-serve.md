# Global `dreamux` bin, `onboard`, and `serve`

- **Status:** Superseded by accepted decision
- **Date:** 2026-06-02
- **Issue:** [issue #18](https://github.com/excitedjs/dreamux/issues/18)
- **Decision:** [global-bin-onboard-serve](../decisions/global-bin-onboard-serve.md),
  amended by [dispatcher-tm-packaging](../decisions/dispatcher-tm-packaging.md)

This proposal is retained only as the issue #18 design entry point. The
binding behavior now lives in the accepted decision:

- `@excitedjs/dreamux` exports `dreamux` plus the dispatcher-required `tm`
  wrapper.
- `dreamux onboard` copies the bundled dispatcher Codex skill into each
  dispatcher's workspace-local `.codex/skills/dispatcher/` directory.
- Dispatcher app-server processes use Codex's global default home for auth,
  config, and memory; dreamux does not set `CODEX_HOME`.
- dreamux-owned state defaults to `~/.dreamux/state/`, and logs default to
  `~/.dreamux/logs/`.
- Codex and Claude plugin marketplace installation is not part of dreamux
  onboarding.
