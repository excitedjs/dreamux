# Verification

## Gates on the branch

- Skill validator (skill-creator `quick_validate.py`) over
  `packages/dreamux/skills/team-leader/teamwork` — passed.
- Rush build, lint, `typecheck:tests`, and the full test run — passed. The
  tests that read the skill file (`mcp-tool-descriptions`,
  `bundled-skill-sources`, `team-leader-prompt`) stay green; the fragments the
  first one rejects are absent from the skill body.
- `.agents/scripts/check.sh` and `git diff --check` — passed.

## Not verified

Whether a TeamLeader that loads the new text reopens a premise instead of
patching is observable only in later real Teams. No automated measure is
claimed.
