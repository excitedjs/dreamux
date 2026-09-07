# Verification

## TeamLeader pre-review

The complete implementation diff was inspected against the approved
requirement and final technical solution. The first pass found that the route
cards preserved the selected hierarchy but omitted meaningful details from the
operator-selected rendered designs: Card 2.0 config and summary, header icons,
hero subtitles, and the selected unbind/dissolution state wording. The same
developer corrected those omissions and strengthened the card-shape tests.

The second pass confirmed:

- plain-text COT tool results cut only when an eleventh content line exists,
  terminal LF/CRLF does not invent a line, JSON objects and arrays bypass the
  line rule, and Feishu byte fitting remains final;
- non-null anchor replacement emits `done`, while anchor retirement and all
  existing runtime, route, Team, and session interruption paths remain
  interrupted;
- manual binding reads `team.status` before the route becomes visible, while
  automatic provisioning consumes the configured runtime ID and cwd directly
  from `team.create` without a redundant status query;
- the three selected Card 2.0 notifications preserve their approved English
  hierarchy, config, summaries, icons, state tags, spacing, fact order, and
  full-width detail panels, with every dynamic value kept as `plain_text`;
- explicit MCP unbind, final `team.state(status: 'closed')`, and pre-final
  `TEAM_CLOSED` rejection select the active, dissolved, and neutral
  presentations respectively, without changing route mutation, COT fencing, or
  the single Dispatcher fallback;
- Collaboration Space cards, provider contracts, and persisted schemas are
  unchanged. The neutral `team.create` result now exposes the runtime facts its
  provisioning consumer needs.

## Checks

The TeamLeader reran these checks after the architecture correction:

```text
node common/scripts/install-run-rush.js build --to @excitedjs/feishu-channel
PASS

node common/scripts/install-run-rush.js build --to @excitedjs/dreamux
PASS

node common/scripts/install-run-rush.js test --only @excitedjs/dreamux-types --only @excitedjs/feishu-channel --only @excitedjs/dreamux --verbose
PARTIAL — dreamux-types passed 106 tests; feishu-channel passed 416 tests;
dreamux passed 977 deterministic tests and failed 5 live Codex tests because
the external runtime timed out or produced no mid-turn activity

node common/scripts/install-run-rush.js change --verify --target-branch origin/next --no-fetch
PASS

.agents/scripts/check.sh
PASS — 162 files reachable

git diff --check
PASS
```

Affected-package lint and test typechecking, the deterministic Dreamux rerun,
full-repository gates, and independent implementation review remain for the
Draft PR follow-up.

## Known limitations

- No live Feishu client send was performed after implementation. The selected
  Card 2.0 component vocabulary was rendered and selected during requirement
  clarification, and production shape tests now lock its meaningful details.
- Card 2.0 requires Feishu client 7.20 or newer, an operator-accepted baseline
  recorded in the approved requirement.
