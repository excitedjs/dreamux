# Minimal repair

After `askUserQuestion` successfully sends the card, record every returned message
id against its already resolved `target` with `FeishuTargetRouter.observe`, then
activate the round as before. This is the same existing ledger used for sent
replies and notifications. Failed sends never reach the registration step.

Keep `deliverAskUserSettlement` unchanged: its envelope and presentation anchor
already identify the answered card correctly. No other layer needs a new fact.

Add one integration regression in the existing settlement suite using the real
session operations, registry and target router with a fake transport. Execute two
question/pick/submit rounds, feed the first answer's message id into the next
question, and assert transport destinations plus both answer identities. Run it
against the baseline first to establish the missing second reply anchor.

Validation: Rush build, lint, test, typecheck:tests and built-CLI smoke; knowledge
links, diff whitespace and change declarations; one independent read-only review.
