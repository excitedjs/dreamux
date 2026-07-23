import type {
  ChannelBindingCollaborationSpaceEvent,
  ChannelBindingEndpointSnapshot,
  ChannelBindingRouteEvent,
} from '@excitedjs/dreamux-types';

export interface FeishuBindingNotificationTarget {
  chatId: string;
  messageId?: string;
}

export interface FeishuBindingNotification {
  target: FeishuBindingNotificationTarget;
  card: unknown;
}

export function routeBindingNotification(
  event: ChannelBindingRouteEvent,
): FeishuBindingNotification | null {
  const address = feishuTarget(event.endpoint);
  if (address === null) return null;
  const bindingKind = event.endpoint.endpoint_type === 'topic'
    ? 'topic'
    : 'group';
  if (event.action === 'unbound') {
    return {
      target: address,
      card: card({
        template: 'grey',
        title: bindingKind === 'topic'
          ? 'Dreamux 话题已解绑'
          : 'Dreamux 群聊已解绑',
        enTitle: bindingKind === 'topic'
          ? 'Dreamux topic unbound'
          : 'Dreamux group unbound',
        lines: [
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
      }),
    };
  }

  const team = event.current_team;
  if (team === null) return null;
  return {
    target: address,
    card: card({
      template: 'green',
      title: bindingKind === 'topic'
        ? 'Dreamux 话题已绑定'
        : 'Dreamux 群聊已绑定',
      enTitle: bindingKind === 'topic'
        ? 'Dreamux topic bound'
        : 'Dreamux group bound',
      lines: [
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
          team.leader_agent_runtime ?? '未知',
          team.leader_agent_runtime ?? 'unknown',
        ),
        line(
          '运行工作目录',
          'Runtime cwd',
          team.runtime_cwd ?? '未知',
          team.runtime_cwd ?? 'unknown',
        ),
      ],
    }),
  };
}

export function collaborationSpaceNotification(
  event: ChannelBindingCollaborationSpaceEvent,
): FeishuBindingNotification | null {
  const address = feishuContainer(event.container);
  if (address === null) return null;
  if (event.action === 'unbound') {
    return {
      target: address,
      card: card({
        template: 'grey',
        title: 'Dreamux 协作空间已解绑',
        enTitle: 'Dreamux collaboration space unbound',
        lines: [
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
      }),
    };
  }

  const binding = event.current_binding;
  if (binding === null) return null;
  const workspace = binding.worktree.mode === 'managed'
    ? `从 ${binding.repo_cwd ?? '已配置仓库'} 创建的托管 worktree`
    : 'Dispatcher 默认工作区';
  const enWorkspace = binding.worktree.mode === 'managed'
    ? `managed worktree from ${binding.repo_cwd ?? 'configured repository'}`
    : 'dispatcher default workspace';
  return {
    target: address,
    card: card({
      template: 'green',
      title: 'Dreamux 协作空间已绑定',
      enTitle: 'Dreamux collaboration space bound',
      lines: [
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
    }),
  };
}

function feishuContainer(
  endpoint: ChannelBindingEndpointSnapshot,
): FeishuBindingNotificationTarget | null {
  const chatId = stringMeta(endpoint, 'chat_id') ?? endpoint.endpoint_key;
  return chatId === '' ? null : { chatId };
}

function feishuTarget(
  endpoint: ChannelBindingEndpointSnapshot,
): FeishuBindingNotificationTarget | null {
  const chatId = stringMeta(endpoint, 'chat_id') ??
    (endpoint.endpoint_type === 'group' ? endpoint.endpoint_key : undefined);
  if (chatId === undefined || chatId === '') return null;
  if (endpoint.endpoint_type !== 'topic') return { chatId };
  const messageId = stringMeta(endpoint, 'message_id');
  return messageId === undefined ? null : { chatId, messageId };
}

function stringMeta(
  endpoint: ChannelBindingEndpointSnapshot,
  key: string,
): string | undefined {
  const value = endpoint.meta[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function card(input: {
  template: 'green' | 'grey';
  title: string;
  enTitle: string;
  lines: CardLine[];
}): unknown {
  return {
    config: { wide_screen_mode: true, enable_forward: false },
    header: {
      template: input.template,
      title: {
        tag: 'plain_text',
        content: input.title,
        i18n_content: { en_us: input.enTitle },
      },
    },
    elements: input.lines.map((item) => ({
      tag: 'div',
      fields: [
        {
          is_short: false,
          text: {
            tag: 'plain_text',
            content: `${item.label}：${item.value}`,
            i18n_content: {
              en_us: `${item.enLabel}: ${item.enValue}`,
            },
          },
        },
      ],
    })),
  };
}

interface CardLine {
  label: string;
  enLabel: string;
  value: string;
  enValue: string;
}

function line(
  label: string,
  enLabel: string,
  value: string,
  enValue = value,
): CardLine {
  return { label, enLabel, value, enValue };
}
