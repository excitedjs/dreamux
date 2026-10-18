# Support native Windows execution

## Current state

- Goal: Run Dreamux natively on Windows, then deliver a PR and publish an alpha from its branch.
- State: `done`
- Requirement: [Current requirement](/.agents/tasks/architecture/native-windows-support/requirement.md)
- Final solution: [Native process and filesystem boundaries](technical-design/final.md)
- Verification: [Checks and coverage](verification.md)
- Blockers: No unresolved product decision.
- Next action: None in the implementation; follow the authorized PR and branch-alpha delivery sequence.
- Related tasks: None.

## Development approval

- On 2026-10-18 the operator selected native Windows source support in the runtime-choice card, then explicitly instructed implementation.
- Approved boundary: Native CLI, local IPC, provider processes, managed service, and Windows test infrastructure. The operator separately required Windows test failures to be repaired in the test infrastructure.
- Delivery authority: The operator explicitly requested a PR first, then an alpha built from that PR branch. This authorizes publishing the branch and alpha, not merging into `next`.
- The operator prioritized completing this repository after a test-isolation incident. Recovery of unrelated operator state is outside this public change; regression prevention belongs here.

## Delivery

- Submit this implementation as a PR to `next`, then publish alpha from that branch. GitHub owns delivery status; merging is not authorized.
- Knowledge closeout: Native platform boundaries, service maintenance, test isolation, publication lifetime and product behavior are documented in the owning references.
