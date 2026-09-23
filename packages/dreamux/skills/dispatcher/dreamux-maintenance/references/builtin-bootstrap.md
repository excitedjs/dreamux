# Built-in Bootstrap Plugin

Enable it by listing it in the top-level `plugins[]` of `config.json`:

```json
{ "plugins": ["builtin:bootstrap"] }
```

It takes no `config` block; one is rejected. It applies to every Dispatcher
with a configured `cwd`.

## Files

All three live in `<dispatcher cwd>/.workspace/`:

- `identity.md`: who the agent is when it works for this user. User-owned:
  create and edit freely, normally together with the user.
- `user.md`: who the user is. User-owned: create and edit freely.
- `bootstrap.md`: plugin-owned. Written at each Dispatcher start while either
  profile file is missing, deleted at the first Dispatcher start after both
  exist. Do not edit or delete it; its content is the guide the Dispatcher
  already received.

The plugin creates `.workspace/` when it is missing. It does not write a
`.gitignore`, so in a git-backed cwd the files can show as untracked until
Dreamux first creates a managed worktree there.

## What Each Agent Receives

- Dispatcher: while either profile file is missing, the guide to create them
  with the user; once both exist, both files.
- TeamLeader: both files once both exist; nothing otherwise, and never the
  guide.
- TeamMates: nothing.

## When Changes Take Effect

- The Dispatcher reads the files each time its Agent starts: a daemon or
  Dispatcher restart. Creating or editing the files does not change the prompt
  of a Dispatcher that is already running.
- A TeamLeader reads them each time it is constructed: Team creation, Team
  rebuild after a restart, and a TeamLeader started on demand.

A read or write error other than a missing file is logged with
`plugin: bootstrap` and skipped; the agent starts without the plugin's text.
