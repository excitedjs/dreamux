# Codexmux Marketplace

This directory is a local Codex plugin marketplace for the dreamux dispatcher
product layer.

It contains:

- `.agents/plugins/marketplace.json` — marketplace metadata named `dreamux`
- `plugins/codexmux/` — the Codex plugin source
- `plugins/codexmux/skills/codexmux-dispatcher/` — dispatcher instructions for
  pinned `tm` delegation

## Install Locally

From the repository root:

```bash
codex plugin marketplace add ./codex-marketplace
codex plugin add codexmux@dreamux
```

Prewarm the pinned tm package before using the dispatcher flow:

```bash
npm exec --yes --package @excitedjs/tm@2.1.2 -- tm --help
```

## Runtime Boundary

The dreamux server hosts dispatcher Codex app-server processes only. Codexmux
does not add server-owned teammate state, admin methods, or database tables.
The dispatcher agent invokes `tm` commands, and tm owns the work behind that
command boundary.

## First Demonstration

Ask the dispatcher to delegate a bounded task and include the target repo path,
for example:

```text
Use codexmux to spawn a tm teammate in /path/to/repo, run the focused tests, and summarize the result.
```

The skill should run:

```bash
npm exec --yes --package @excitedjs/tm@2.1.2 -- tm spawn /path/to/repo --engine codex ...
npm exec --yes --package @excitedjs/tm@2.1.2 -- tm wait <name> --timeout 180
```

If `tm` fails, the dispatcher reports the failed verb, teammate name, repo path,
and useful stderr/stdout instead of attributing the failure to dreamux server
state.

If `tm spawn --engine codex` reports that the Codex daemon exited before
binding its socket, verify the dispatcher environment can run:

```bash
codex app-server --listen unix:///tmp/codexmux-check.sock
```

Read-only filesystem or operation-permitted errors here are environment
failures below codexmux.
