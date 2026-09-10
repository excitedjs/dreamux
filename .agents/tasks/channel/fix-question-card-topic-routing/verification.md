# Verification

## Actual-card routing revision

- Integration base: `6bb8a713` (next, including PR #403).
- Product diff is limited to Feishu transport/channel. The registry no longer
  stores a target; settlement reads the actual card's conversation. Sending uses
  the explicit reply id without consulting the observation ledger.
- The observed-message ledger tests were moved to their owning router suite,
  not removed. Ordinary inbound projection delegates to the same chat-mode rule.
- Developer checks passed: Rush build, lint, test and typecheck:tests; channel
  tests passed 27 files / 473 cases before rebasing. Developer-reported mutation
  checks made the regression tests fail when topic projection or explicit reply
  addressing was removed, or when read failure delivered to a guessed chat.
- Final rebased gates: Rush build, lint, test, typecheck:tests and
  smoke-built-cli all passed (exit 0). Logs are in
  `/tmp/question-card-final-gates/`. Test warnings are the existing intentional
  failure-path and live-runtime stderr output; no tests failed.
- Final package tests: feishu-channel 27 files / 475 passed (including the two
  additional tests from #403); feishu-transport 12 files / 195 passed.
- Knowledge links: 227 files reachable; whitespace check passed.
- `rush change --verify -b origin/next` passed after the implementation commit,
  finding both the feishu-channel and feishu-transport change files.
- Mandatory commit hooks passed, including staged ESLint, gitleaks and the
  internal-content gate; no hook was bypassed.
- Message-read failure and empty lookup results produce no delivery. Expiry card
  repaint remains independent of answer delivery.
- Chat-mode resolution retains the existing inbound behavior, including ordinary
  group projection when mode cannot be resolved. The no-misdelivery guarantee on
  query failure covers the new message-details lookup. A thread-bearing card may
  also require the existing cached chat-mode lookup on a cold cache.
- Message details do not report `chat_type`. Readback without a thread uses the
  existing group default; unbound direct-chat answers still reach the Dispatcher.
  This internal target-kind limitation is visible to the PR reviewer.
- No live Feishu probe or service installation was performed.
- Independent review: Pending DevBox on the updated PR, as explicitly requested.
  The planned dynamic workflow was not started.

## Earlier minimal patch (superseded)

The earlier `1e011989` revision registered sent cards in the observation ledger.
Its two-round regression, local gates, CI and independent Claude review passed,
with two documentation wraps corrected. It was published as an Alpha. Those
results describe the earlier patch, not the replacement implementation above.

## Follow-up maintenance candidate

`feishu-session-ops.ts` remains below the 700-line gate at 675 lines. Its
question-card send/settlement/expiry responsibilities are a candidate for a future
owner-level extraction if that area grows. No extraction or comment trimming was
included in this routing fix.
