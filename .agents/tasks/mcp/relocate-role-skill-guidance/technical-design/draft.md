# Technical solution (draft)

Superseded by [final.md](final.md) after the Codex review; kept as the
reviewed input. Input: [requirement.md](../requirement.md) as of the
operator's path ruling on 2026-09-02. Author: TeamLeader.

The draft differed from the final in these respects, each changed by a review
finding recorded in final.md §10:

- Role prompts enumerated every tool name per server and said "the
  description and parameter descriptions are the tool's contract"; the final
  maps server names plus purpose and keeps only "load a tool's definition
  before calling it". The draft assumed one "connected channel's own server";
  the final says one `channel-<id>` server per configured channel that
  provides tools.
- The relocation table lacked rows for the frontmatter load mandates, the
  branch-deletion warning, the background worktree deletion note, the
  key-milestone reply guidance, and the due-cron folding fact; it dropped the
  TeamLeader "user asked for parallel edits" clause and attributed the whole
  routing inventory to `bind_channel`.
- Property descriptions said `recurring:false` "fires once and then disables
  the job", `last.limit` "newest page first", Team `history.grep` over three
  fields, and unconditional `repo.base_ref` / `repo.slug` effects; the
  existing malformed `spawn.agent_runtime` text was kept as "exists".
- `reply.text` banned secrets and machine-local paths from every reply
  instead of from broad-audience replies; the TeamLeader `bind_channel`
  "ask the Dispatcher" wording was marked as an existing owner.
- Skill bodies described a TeamMate through its tool operations (addressed
  by name, pushed completion, reopen after close, `identity`/`prompt`/`intent`
  field mapping, polling and close-note rules) and asserted subagent
  lifecycle facts Dreamux does not own; frontmatter descriptions began with
  "Load when …".
- The test plan special-cased a "repo union" (it is one closed object) and
  gated only the Dispatcher prompt constants; `react` was an unlabeled
  adjacent edit; the feishu-channel change file was typed `minor`.

The Codex probe evidence (Codex 0.147.0 defers MCP definitions behind an
`ALL_TOOLS` catalog; skills are name+description per turn, body on read) was
recorded in the draft's §2 and §9 before review and carried into the final.
