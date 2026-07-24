import type {
  ChannelBindingCollaborationSpaceEvent,
  ChannelBindingRouteEvent,
} from '@excitedjs/dreamux-types';
import {
  buildFeishuStatusCard,
  feishuCardField as line,
} from './feishu-card.js';

export function routeBindingNotification(
  event: ChannelBindingRouteEvent,
): unknown {
  const bindingKind = event.endpoint.endpoint_type === 'topic'
    ? 'topic'
    : 'group';
  if (event.action === 'unbound') {
    return buildFeishuStatusCard({
      template: 'grey',
      title: bindingKind === 'topic'
        ? 'Dreamux 话题已解绑'
        : 'Dreamux 群聊已解绑',
      enTitle: bindingKind === 'topic'
        ? 'Dreamux topic unbound'
        : 'Dreamux group unbound',
      fields: [
        line(
          '目标',
          'Target',
          event.endpoint.display ?? event.endpoint.endpoint_key,
        ),
        line(
          '状态',
          'Status',
          bindingKind === 'topic'
            ? '该话题已不再路由到团队。'
            : '该群聊已不再路由到团队。',
          bindingKind === 'topic'
            ? 'This topic is no longer routed to a Team.'
            : 'This group is no longer routed to a Team.',
        ),
      ],
    });
  }

  const team = event.current_team;
  return buildFeishuStatusCard({
    template: 'green',
    title: bindingKind === 'topic'
      ? 'Dreamux 话题已绑定'
      : 'Dreamux 群聊已绑定',
    enTitle: bindingKind === 'topic'
      ? 'Dreamux topic bound'
      : 'Dreamux group bound',
    fields: [
      line(
        '目标',
        'Target',
        event.endpoint.display ?? event.endpoint.endpoint_key,
      ),
      line('绑定类型', 'Binding', bindingKind === 'topic' ? '话题' : '群聊', bindingKind),
      line('团队', 'Team', team.team_name),
      line('TeamLeader', 'TeamLeader', team.leader_name),
      line(
        'TeamLeader 运行时',
        'TeamLeader runtime',
        team.leader_agent_runtime,
      ),
      line(
        '运行工作目录',
        'Runtime cwd',
        team.runtime_cwd,
      ),
    ],
  });
}

export function collaborationSpaceNotification(
  event: ChannelBindingCollaborationSpaceEvent,
): unknown {
  if (event.action === 'unbound') {
    return buildFeishuStatusCard({
      template: 'grey',
      title: 'Dreamux 协作空间已解绑',
      enTitle: 'Dreamux collaboration space unbound',
      fields: [
        line('协作空间', 'Space', event.space_name),
        line(
          '目标',
          'Target',
          event.container.display ?? event.container.endpoint_key,
        ),
        line(
          '状态',
          'Status',
          '该协作空间已解绑。',
          'This collaboration space is no longer bound.',
        ),
      ],
    });
  }

  const binding = event.current_binding;
  const workspace = binding.worktree.mode === 'managed'
    ? `从 ${binding.repo_cwd ?? '已配置仓库'} 创建的托管 worktree`
    : 'Dispatcher 默认工作区';
  const enWorkspace = binding.worktree.mode === 'managed'
    ? `managed worktree from ${binding.repo_cwd ?? 'configured repository'}`
    : 'dispatcher default workspace';
  return buildFeishuStatusCard({
    template: 'green',
    title: 'Dreamux 协作空间已绑定',
    enTitle: 'Dreamux collaboration space bound',
    fields: [
      line('协作空间', 'Space', event.space_name),
      line(
        '群聊',
        'Group',
        event.container.display ?? event.container.endpoint_key,
      ),
      line(
        'TeamLeader 运行时',
        'TeamLeader runtime',
        binding.leader_agent_runtime,
      ),
      line(
        '仓库目录',
        'Repository cwd',
        binding.repo_cwd ?? 'Dispatcher 默认',
        binding.repo_cwd ?? 'dispatcher default',
      ),
      line('工作区', 'Workspace', workspace, enWorkspace),
      line(
        '基础引用',
        'Base ref',
        binding.worktree.mode === 'managed'
          ? binding.worktree.base_ref ?? '默认'
          : '不适用',
        binding.worktree.mode === 'managed'
          ? binding.worktree.base_ref ?? 'default'
          : 'not applicable',
      ),
    ],
  });
}
