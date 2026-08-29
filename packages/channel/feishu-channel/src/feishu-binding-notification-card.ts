/**
 * What the people in a Feishu conversation are told about its routing.
 *
 * These cards used to be rendered from Core binding events, which meant Core
 * had to publish a binding fact for a Channel to be able to describe its own
 * state. They are now rendered from this Channel's own records, at the moment
 * this Channel changes them, and no Core event is involved.
 */
import type { FeishuSpaceRecord } from './routing/document.js';
import { describeTarget, type FeishuTarget } from './routing/target.js';
import {
  buildFeishuStatusCard,
  feishuCardField as line,
} from './feishu-card.js';

export function bindingBoundCard(input: {
  target: FeishuTarget;
  display: string | null;
  teamName: string;
  /** Set when the binding was installed automatically for a space. */
  spaceName: string | null;
}): unknown {
  const topic = input.target.kind === 'topic';
  return buildFeishuStatusCard({
    template: 'green',
    title: topic ? 'Dreamux 话题已绑定' : 'Dreamux 群聊已绑定',
    enTitle: topic ? 'Dreamux topic bound' : 'Dreamux group bound',
    fields: [
      line('目标', 'Target', input.display ?? describeTarget(input.target)),
      line('绑定类型', 'Binding', topic ? '话题' : '群聊', topic ? 'topic' : 'group'),
      line('团队', 'Team', input.teamName),
      ...(input.spaceName !== null
        ? [line('协作空间', 'Collaboration space', input.spaceName)]
        : []),
    ],
  });
}

export function bindingUnboundCard(input: {
  target: FeishuTarget;
  display: string | null;
  teamName: string;
}): unknown {
  const topic = input.target.kind === 'topic';
  return buildFeishuStatusCard({
    template: 'grey',
    title: topic ? 'Dreamux 话题已解绑' : 'Dreamux 群聊已解绑',
    enTitle: topic ? 'Dreamux topic unbound' : 'Dreamux group unbound',
    fields: [
      line('目标', 'Target', input.display ?? describeTarget(input.target)),
      line('团队', 'Team', input.teamName),
      line(
        '状态',
        'Status',
        topic ? '该话题已不再路由到团队。' : '该群聊已不再路由到团队。',
        topic
          ? 'This topic is no longer routed to a Team.'
          : 'This group is no longer routed to a Team.',
      ),
    ],
  });
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
