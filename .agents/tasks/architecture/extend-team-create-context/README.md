# Add Team creation context and use the dispatcher workspace by default

## Current state

- Goal: Allow callers to attach provider-owned context to fresh Team creation and default repository-free agents to the dispatcher working directory.
- State: `review`
- Requirement: [Current requirement](/.agents/tasks/architecture/extend-team-create-context/requirement.md)
- Final solution: [Implementation scope](/.agents/tasks/architecture/extend-team-create-context/technical-design/final.md)
- Solution review Issue: [#407](https://github.com/excitedjs/dreamux/issues/407).
- Blockers: None.
- Next action: Publish a draft PR for external review, then adjudicate findings.
- Related tasks: Builds on [minimal provider boundaries](/.agents/tasks/architecture/minimize-provider-boundaries/README.md) and [Team projections](/.agents/tasks/architecture/unify-team-command-projections/README.md).

## Development approval

- Status: The operator explicitly requested implementation on 2026-09-11 after the comparison explained the default change and its effect, then added the Team creation change. The exact instructions are preserved in the requirement.
- Approved implementation boundary: Default workspace configuration and onboarding; provider-neutral creation context/result/event; the Feishu event consumer and binding notification; corresponding tests, maintenance guidance, release notes, and knowledge.
- Review path: One implementation writer and independent external review in the originating discussion, as supported by this Team's operating instructions.

## Delivery

- Verification: [Validation and review record](/.agents/tasks/architecture/extend-team-create-context/verification.md).
- Pull request: Preparing a draft so the external reviewer can access the code.
- CI / merge: Pending.
- Knowledge closeout: Current domain, product, and maintenance guidance updated;
  final closeout follows independent review.
