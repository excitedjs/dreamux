# Change Log - @excitedjs/agent-runtime-antigravity

This log was last generated on Sat, 28 Nov 2026 02:21:15 GMT and should not be manually modified.

## 0.2.0
Sat, 28 Nov 2026 02:21:15 GMT

### Minor changes

- Align model/effort validation and unattended approval posture with codex and claude-code: remove the closed effort enum allowlist, reject blank model/effort strings with RuleViolation, and cancel unexpected ACP session/request_permission callbacks fail-fast instead of auto-allowing.
- Add the external Antigravity CLI provider with config-selected native tmux and resident ACP v1 transports, exact native conversation resume, bounded activity reads, and provider diagnostics.

### Patches

- Align Antigravity ACP live COT projection: show file basenames with raw paths in items, prefer toolSummary and plain-text outputs for run_command, classify MCP tools with action null and toolName · toolSummary, deduplicate tool start rows, keep structured failures on result for redaction, and stream reasoning and assistant messages with process-local live display block ids when ACP omits messageId.

