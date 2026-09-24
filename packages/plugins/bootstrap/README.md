# @excitedjs/dreamux-plugin-bootstrap

The built-in Dreamux bootstrap plugin. It ships with `@excitedjs/dreamux` and
is enabled by listing it in the top-level `plugins[]` of the Dreamux config:

```json
{ "plugins": ["builtin:bootstrap"] }
```

It keeps two profile files in `.workspace/` under each Dispatcher's cwd:

- `identity.md`: who the agent is when it works for this user. User-owned.
- `user.md`: who the user is. User-owned.

While either file is missing, the Dispatcher Agent receives a guide asking it
to create them with the user; the guide is also written to
`.workspace/bootstrap.md` (plugin-owned, removed automatically once both files
exist). Once both files exist, the Dispatcher Agent and every TeamLeader
receive them in their launch prompt. TeamMates receive nothing.

The Dispatcher reads the files each time its Agent is constructed (Dispatcher
start or restart); a TeamLeader reads them each time it is constructed.

The package depends on `@excitedjs/dreamux-types` only, never on
`@excitedjs/dreamux`.
