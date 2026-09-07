# Post-merge compact-layout solution

## Outcome and boundary

Tighten only the three selected Card 2.0 route notifications: route bound,
explicit MCP unbind, and confirmed Team dissolution. Keep their fixed copy,
dynamic values, field order, colors, icons, summaries, cause semantics, and
routing behavior unchanged. The cause-neutral Card 1.0 route-ended card and
Collaboration Space cards stay outside this correction.

## Shared typography

The header remains the card's only full title. The Team name uses one modest
display step, while every other text component in the body uses normal body
typography:

- Team name: `heading-4`, retaining its state color;
- subtitle: `normal` in grey;
- fact labels and values: `normal`;
- detail labels and values: normal body size. The existing fixed Markdown label
  may remain bold and colored because that changes emphasis, not font size.

No body component except the Team name uses `heading-*`; no body component uses
`notation`. This is one shared body rule, not three card-specific exceptions.

## Shared compact spacing

Use one private spacing vocabulary in the existing notification-card module:

- body padding: `8px 12px 12px 12px`;
- Team-name margin: `0px`;
- subtitle margin: `0px 0px 8px 0px`;
- fact-row margin: `0px 0px 8px 0px`;
- fact-cell padding: `6px 8px 6px 8px`;
- fact-cell vertical spacing: `0px`;
- detail-panel padding: `8px 10px 8px 10px`;
- detail-panel vertical spacing: `2px`.

The existing 8px horizontal spacing between fact columns remains. The 8px
vertical group rhythm is the smallest rendered layout that still keeps the Team
line, subtitle, fact row, and detail panel visually distinct; the zero-spacing
preview made those groups appear piled together.

The Team-dissolution card uses an `orange` header template, orange warning icon
and status tag, orange Team-name emphasis, and an `orange-50` detail panel. The
bound and explicit-unbind color systems remain green and neutral grey.

## Implementation and verification

Change only `feishu-binding-notification-card.ts` and its payload tests for this
presentation correction. Keep the private shared builders; do not introduce a
repository-wide card abstraction.

Tests assert the exact shared spacing values, permit only the Team name's
`heading-4`, reject every other body `heading-*` and all `notation`, and keep
the existing assertions for literal dynamic text and card semantics. After the
package and repository gates pass,
send the actual JSON returned by each production card constructor to the
operator's Feishu group with `lark-cli`; do not send handwritten approximations.
