# Requirement

The operator requested on 2026-10-27 (English translation): add a sentence to
the prompt parameter descriptions for Team and TeamMate handoffs saying to
always pass prompts in English.

## Acceptance criteria

- `teammate.spawn`, owner and ordinary-member `teammate.send`, `team.create`,
  and `team.send` describe the English-language requirement on `prompt`.
- Preserve each parameter's existing explanation, requiredness, and bounds.
- Limit the change to model-facing guidance; language validation, translation,
  identity, cron, and user-facing reply language are outside this request.

The ordinary-member `teammate.send` projection previously exposed `prompt`
without a description. It receives the same guidance at its existing owner.
