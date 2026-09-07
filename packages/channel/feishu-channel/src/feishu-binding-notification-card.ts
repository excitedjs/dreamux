/**
 * What the people in a Feishu conversation are told about its routing.
 *
 * These cards used to be rendered from Core binding events, which meant Core
 * had to publish a binding fact for a Channel to be able to describe its own
 * state. They are now rendered from this Channel's own records, at the moment
 * this Channel changes them, and no Core binding event is involved.
 */
import type { FeishuSpaceRecord } from './routing/document.js';
import { describeTarget, type FeishuTarget } from './routing/target.js';
import {
  buildFeishuStatusCard,
  feishuCardField as line,
} from './feishu-card.js';

const BODY_PADDING = '8px 12px 12px 12px';
const GROUP_MARGIN = '0px 0px 8px 0px';

export function bindingBoundCard(input: {
  target: FeishuTarget;
  display: string | null;
  teamName: string;
  leaderName: string;
  agentRuntime: string;
  runtimeCwd: string;
}): unknown {
  const targetDisplay = input.display ?? describeTarget(input.target);
  const binding = input.target.kind === 'topic' ? 'topic' : 'group';
  return {
    schema: '2.0',
    config: {
      update_multi: true,
      width_mode: 'default',
      summary: { content: `${targetDisplay} bound to Team ${input.teamName}` },
    },
    header: {
      ...routeHeader(`Dreamux ${binding} bound`, 'green', 'Bound', 'green'),
      icon: { tag: 'standard_icon', token: 'group_outlined', color: 'green' },
    },
    body: {
      direction: 'vertical',
      padding: BODY_PADDING,
      elements: [
        { ...textBlock(input.teamName, 'heading-4', 'green'), margin: '0px' },
        {
          ...textBlock(`Bound to ${targetDisplay} · ${binding}`, 'normal', 'grey'),
          margin: GROUP_MARGIN,
        },
        factRow([
          ['Target', targetDisplay],
          ['TeamLeader', input.leaderName],
          ['Agent Runtime', input.agentRuntime],
        ]),
        detailPanel(
          "**<font color='green'>Runtime cwd</font>**",
          input.runtimeCwd,
          'green-50',
        ),
      ],
    },
  };
}

export function bindingUnboundCard(input: {
  target: FeishuTarget;
  display: string | null;
  teamName: string;
}): unknown {
  const targetDisplay = input.display ?? describeTarget(input.target);
  const binding = input.target.kind === 'topic' ? 'topic' : 'group';
  return {
    schema: '2.0',
    config: {
      update_multi: true,
      width_mode: 'default',
      summary: { content: `${targetDisplay} unbound from Team ${input.teamName}` },
    },
    header: {
      ...routeHeader(`Dreamux ${binding} unbound`, 'grey', 'Unbound', 'neutral'),
      icon: { tag: 'standard_icon', token: 'close_outlined', color: 'grey' },
    },
    body: {
      direction: 'vertical',
      padding: BODY_PADDING,
      elements: [
        { ...textBlock(input.teamName, 'heading-4'), margin: '0px' },
        {
          ...textBlock(`Unbound from ${targetDisplay}`, 'normal', 'grey'),
          margin: GROUP_MARGIN,
        },
        factRow([
          ['Target', targetDisplay],
          ['Binding', binding],
          ['Team', input.teamName],
        ]),
        detailPanel(
          "**<font color='grey'>Why</font>**",
          'Unbound via Feishu Channel; the Team remains active.',
          'grey-50',
        ),
      ],
    },
  };
}

export function teamDissolvedCard(input: {
  target: FeishuTarget;
  display: string | null;
  teamName: string;
}): unknown {
  return {
    schema: '2.0',
    config: {
      update_multi: true,
      width_mode: 'default',
      summary: { content: `Team ${input.teamName} dissolved; routes removed` },
    },
    header: {
      ...routeHeader('Dreamux team dissolved', 'orange', 'Team dissolved', 'orange'),
      icon: { tag: 'standard_icon', token: 'warning_outlined', color: 'orange' },
    },
    body: {
      direction: 'vertical',
      padding: BODY_PADDING,
      elements: [
        { ...textBlock(input.teamName, 'heading-4', 'orange'), margin: '0px' },
        {
          ...textBlock('Team closed; routes removed automatically', 'normal', 'grey'),
          margin: GROUP_MARGIN,
        },
        factRow([
          ['Target', input.display ?? describeTarget(input.target)],
          ['Binding', input.target.kind === 'topic' ? 'topic' : 'group'],
          ['Team', input.teamName],
        ]),
        detailPanel(
          "**<font color='orange'>Why</font>**",
          'Team closed; all of its routes were removed automatically.',
          'orange-50',
        ),
      ],
    },
  };
}

/** Admission can be refused while dissolution is still pending. */
export function bindingRouteEndedCard(input: {
  target: FeishuTarget;
  display: string | null;
  teamName: string;
}): unknown {
  return buildFeishuStatusCard({
    template: 'grey',
    title: 'Dreamux route ended',
    enTitle: 'Dreamux route ended',
    fields: [
      line('Target', 'Target', input.display ?? describeTarget(input.target)),
      line('Team', 'Team', input.teamName),
      line('Status', 'Status', 'This conversation is no longer routed to this Team.'),
    ],
  });
}

function routeHeader(
  title: string,
  template: 'green' | 'grey' | 'orange',
  status: string,
  color: 'green' | 'neutral' | 'orange',
) {
  return {
    title: { tag: 'plain_text', content: title },
    template,
    text_tag_list: [{ tag: 'text_tag', text: { tag: 'plain_text', content: status }, color }],
  };
}

function textBlock(
  content: string,
  textSize: 'heading-4' | 'normal',
  textColor: 'default' | 'grey' | 'green' | 'orange' = 'default',
  textAlign: 'left' | 'center' = 'left',
) {
  return {
    tag: 'div',
    text: { tag: 'plain_text', content, text_size: textSize, text_color: textColor, text_align: textAlign },
  };
}

function factRow(facts: Array<[string, string]>) {
  return {
    tag: 'column_set',
    flex_mode: 'none',
    horizontal_spacing: '8px',
    margin: GROUP_MARGIN,
    columns: facts.map(([label, value]) => ({
      tag: 'column',
      width: 'weighted',
      weight: 1,
      background_style: 'grey-50',
      padding: '6px 8px 6px 8px',
      vertical_spacing: '0px',
      elements: [
        textBlock(label, 'normal', 'grey', 'center'),
        textBlock(value, 'normal', 'default', 'center'),
      ],
    })),
  };
}

function detailPanel(labelMarkdown: string, value: string, background: string) {
  return {
    tag: 'column_set',
    flex_mode: 'none',
    margin: '0px',
    columns: [{
      tag: 'column',
      width: 'weighted',
      weight: 1,
      background_style: background,
      padding: '8px 10px 8px 10px',
      vertical_spacing: '2px',
      elements: [
        { tag: 'markdown', content: labelMarkdown },
        textBlock(value, 'normal'),
      ],
    }],
  };
}

export function spaceBoundCard(space: FeishuSpaceRecord): unknown {
  const workspace = space.repo === null
    ? 'Dispatcher 默认工作区'
    : `从 ${space.repo.path} 创建的托管 worktree`;
  const enWorkspace = space.repo === null
    ? 'dispatcher default workspace'
    : `managed worktree from ${space.repo.path}`;
  return buildFeishuStatusCard({
    template: 'green',
    title: 'Dreamux 协作空间已绑定',
    enTitle: 'Dreamux collaboration space bound',
    fields: [
      line('协作空间', 'Space', space.space_name),
      line('群聊', 'Group', space.display ?? space.container_chat_id),
      line('TeamLeader 运行时', 'TeamLeader runtime', space.leader_agent_runtime),
      line('工作区', 'Workspace', workspace, enWorkspace),
      line(
        '基础引用',
        'Base ref',
        space.repo?.base_ref ?? (space.repo === null ? '不适用' : '默认'),
        space.repo?.base_ref ??
          (space.repo === null ? 'not applicable' : 'default'),
      ),
      line(
        '说明',
        'Note',
        '此群下的新话题会自动创建团队。',
        'New topics in this group are provisioned with their own Team.',
      ),
    ],
  });
}

export function spaceUnboundCard(space: FeishuSpaceRecord): unknown {
  return buildFeishuStatusCard({
    template: 'grey',
    title: 'Dreamux 协作空间已解绑',
    enTitle: 'Dreamux collaboration space unbound',
    fields: [
      line('协作空间', 'Space', space.space_name),
      line('群聊', 'Group', space.display ?? space.container_chat_id),
      line(
        '状态',
        'Status',
        '不再自动创建团队；已创建的团队和绑定保持不变。',
        'Automatic provisioning stopped; existing Teams and bindings ' +
          'are unchanged.',
      ),
    ],
  });
}
