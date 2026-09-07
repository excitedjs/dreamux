import { describe, expect, it } from 'vitest';

import {
  bindingBoundCard,
  bindingRouteEndedCard,
  bindingUnboundCard,
  teamDissolvedCard,
} from '../src/feishu-binding-notification-card.js';
import { chatTarget, topicTarget } from '../src/routing/target.js';

function nodes(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (value === null || typeof value !== 'object') return [];
  const record = value as Record<string, unknown>;
  return [record, ...Object.values(record).flatMap(nodes)];
}

const target = topicTarget('chat-example', 'topic-example');
const display = '**target** [literal](url)';
const team = {
  teamName: '*team* _literal_',
  leaderName: '`leader` <literal>',
  agentRuntime: 'trae-gpt',
  runtimeCwd: `/workspace/[literal]/${'long directory_'.repeat(50)}end`,
};

// Selected candidate 4 / set 2, with the final English and runtime-cwd refinements.
const cards = [
  {
    name: 'bound',
    card: bindingBoundCard({ target, display, ...team }),
    summary: `${display} bound to Team ${team.teamName}`,
    title: 'Dreamux topic bound',
    color: 'green',
    icon: { token: 'group_outlined', color: 'green' },
    status: 'Bound',
    statusColor: 'green',
    heroColor: 'green',
    subtitle: `Bound to ${display} · topic`,
    facts: [['Target', display], ['TeamLeader', team.leaderName], ['Agent Runtime', team.agentRuntime]],
    panel: 'green-50',
    panelLabel: "**<font color='green'>Runtime cwd</font>**",
    panelValue: team.runtimeCwd,
  },
  {
    name: 'unbound',
    card: bindingUnboundCard({ target, display, teamName: team.teamName }),
    summary: `${display} unbound from Team ${team.teamName}`,
    title: 'Dreamux topic unbound',
    color: 'grey',
    icon: { token: 'close_outlined', color: 'grey' },
    status: 'Unbound',
    statusColor: 'neutral',
    heroColor: 'default',
    subtitle: `Unbound from ${display}`,
    facts: [['Target', display], ['Binding', 'topic'], ['Team', team.teamName]],
    panel: 'grey-50',
    panelLabel: "**<font color='grey'>Why</font>**",
    panelValue: 'Unbound via Feishu Channel; the Team remains active.',
  },
  {
    name: 'dissolved',
    card: teamDissolvedCard({ target, display, teamName: team.teamName }),
    summary: `Team ${team.teamName} dissolved; routes removed`,
    title: 'Dreamux team dissolved',
    color: 'orange',
    icon: { token: 'warning_outlined', color: 'orange' },
    status: 'Team dissolved',
    statusColor: 'orange',
    heroColor: 'orange',
    subtitle: 'Team closed; routes removed automatically',
    facts: [['Target', display], ['Binding', 'topic'], ['Team', team.teamName]],
    panel: 'orange-50',
    panelLabel: "**<font color='orange'>Why</font>**",
    panelValue: 'Team closed; all of its routes were removed automatically.',
  },
];

describe('selected route notification cards', () => {
  it.each(cards)('$name preserves the selected config, English summary, icon and state tag', ({
    card, summary, title, color, icon, status, statusColor,
  }) => {
    expect(card).toMatchObject({
      schema: '2.0',
      config: { update_multi: true, width_mode: 'default', summary: { content: summary } },
      header: {
        title: { tag: 'plain_text', content: title },
        template: color,
        icon: { tag: 'standard_icon', ...icon },
        text_tag_list: [{ tag: 'text_tag', text: { tag: 'plain_text', content: status }, color: statusColor }],
      },
    });
    expect(nodes(card).filter((node) => node['tag'] === 'text_tag')).toHaveLength(1);
  });

  it.each(cards)('$name preserves the Team hero, subtitle and selected body spacing', ({ card, heroColor, subtitle }) => {
    expect(card).toMatchObject({ body: {
      direction: 'vertical',
      padding: '8px 12px 12px 12px',
      elements: [
        {
          tag: 'div', margin: '0px',
          text: { tag: 'plain_text', content: team.teamName, text_size: 'heading-4', text_color: heroColor },
        },
        {
          tag: 'div', margin: '0px 0px 8px 0px',
          text: { tag: 'plain_text', content: subtitle, text_size: 'normal', text_color: 'grey' },
        },
        { tag: 'column_set', margin: '0px 0px 8px 0px' },
        { tag: 'column_set', margin: '0px' },
      ],
    } });
    const body = nodes(card).find((node) => node['direction'] === 'vertical');
    expect(body).not.toHaveProperty('vertical_spacing');
  });

  it.each(cards)('$name keeps the final fact order in compact, centered grey cells', ({ card, facts }) => {
    const rows = nodes(card).filter((node) => node['tag'] === 'column_set');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      flex_mode: 'none', horizontal_spacing: '8px',
      columns: facts.map(([label, value]) => ({
        tag: 'column', width: 'weighted', weight: 1,
        background_style: 'grey-50', padding: '6px 8px 6px 8px', vertical_spacing: '0px',
        elements: [
          { text: { tag: 'plain_text', content: label, text_size: 'normal', text_color: 'grey', text_align: 'center' } },
          { text: { tag: 'plain_text', content: value, text_align: 'center' } },
        ],
      })),
    });
    expect(rows[0]!['columns']).toHaveLength(3);
  });

  it.each(cards)('$name keeps its full-width tinted panel with a static label and complete literal value', ({
    card, panel, panelLabel, panelValue,
  }) => {
    const rows = nodes(card).filter((node) => node['tag'] === 'column_set');
    expect(rows[1]).toMatchObject({
      flex_mode: 'none', margin: '0px',
      columns: [{
        tag: 'column', width: 'weighted', weight: 1,
        background_style: panel, padding: '8px 10px 8px 10px', vertical_spacing: '2px',
        elements: [
          { tag: 'markdown', content: panelLabel },
          { tag: 'div', text: { tag: 'plain_text', content: panelValue, text_align: 'left' } },
        ],
      }],
    });
    expect(rows[1]!['columns']).toHaveLength(1);
  });

  it.each(cards)('$name uses heading typography only for the Team name', ({ card }) => {
    const headingTexts = nodes(card)
      .filter((node) =>
        typeof node['text_size'] === 'string' && node['text_size'].startsWith('heading-'),
      )
      .map((node) => node['content']);
    expect(headingTexts).toEqual([team.teamName]);
    expect(nodes(card).filter((node) => node['text_size'] === 'notation')).toEqual([]);
  });

  it.each(cards)('$name renders dynamic values literally without preview labels or Chinese fallback copy', ({ card, panelLabel }) => {
    const all = nodes(card);
    const text = all.filter((node) => node['tag'] === 'plain_text').map((node) => node['content']);
    expect(text).toContain(display);
    expect(text).toContain(team.teamName);
    expect(all.filter((node) => 'i18n_content' in node)).toEqual([]);
    // Only the static panel label uses Markdown; names, subtitles and paths do not.
    expect(all.filter((node) => node['tag'] === 'markdown' || node['tag'] === 'lark_md'))
      .toEqual([{ tag: 'markdown', content: panelLabel }]);
    expect(JSON.stringify(card)).not.toMatch(/[\u3400-\u9fff]|candidate|preview|set 2|builtin:codex/iu);
  });

  it.each([
    { kind: 'group', route: chatTarget('chat-example', 'group') },
    { kind: 'topic', route: target },
  ])('names the $kind in bind/unbind titles and binding facts', ({ kind, route }) => {
    const bound = bindingBoundCard({ target: route, display, ...team });
    const unbound = bindingUnboundCard({ target: route, display, teamName: team.teamName });
    expect(bound).toMatchObject({ header: { title: { content: `Dreamux ${kind} bound` } } });
    expect(unbound).toMatchObject({ header: { title: { content: `Dreamux ${kind} unbound` } } });
    expect(nodes(bound)).toContainEqual(expect.objectContaining({
      tag: 'plain_text', content: `Bound to ${display} · ${kind}`,
    }));
    expect(nodes(unbound)).toContainEqual(expect.objectContaining({ tag: 'plain_text', content: kind }));
  });

  it('keeps pre-final route removal neutral and outside the selected Card 2.0 designs', () => {
    const card = bindingRouteEndedCard({ target, display, teamName: team.teamName });
    expect(card).not.toHaveProperty('schema', '2.0');
    expect(card).toMatchObject({ header: { title: { content: 'Dreamux route ended' } } });
    expect(JSON.stringify(card)).toContain('This conversation is no longer routed to this Team.');
    expect(JSON.stringify(card)).not.toMatch(/dissolved|Team closed|remains active/);
  });
});
