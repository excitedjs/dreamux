export const DREAMUX_PAIRING_CARD_ACTION = 'approve_pairing';
export const DREAMUX_ACTION_KEY = 'dreamux_action';
export const DREAMUX_PAIRING_TOKEN_KEY = 'dreamux_pairing_token';

export interface PairingApprovalCardInput {
  token: string;
  botDisplayName: string;
  requesterOpenId: string;
}

export interface PairingSuccessCardInput {
  duplicate: boolean;
}

export interface FeishuCardActionResponse {
  toast?: {
    type: 'info' | 'success' | 'error' | 'warning';
    content: string;
  };
  card?: {
    type: 'raw';
    data: unknown;
  };
}

export function buildPairingApprovalCard(input: PairingApprovalCardInput): unknown {
  const requesterAt = `<at id="${escapeAtId(input.requesterOpenId)}"></at>`;
  return {
    config: { wide_screen_mode: true, enable_forward: false, update_multi: true },
    header: {
      template: 'blue',
      title: {
        tag: 'plain_text',
        content: `用户请求访问 ${input.botDisplayName}`,
        i18n_content: {
          en_us: `User requests access to ${input.botDisplayName}`,
        },
      },
    },
    elements: [
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: `申请人：${requesterAt}\n\n仅 App Owner 可以点击批准。非 Owner 点击只会收到拒绝提示。`,
          i18n_content: {
            en_us: `Requester: ${requesterAt}\n\nOnly the App Owner can approve this request. Non-Owner clicks only receive a rejection toast.`,
          },
        },
      },
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: {
              tag: 'plain_text',
              content: '批准授权',
              i18n_content: {
                en_us: 'Approve',
              },
            },
            type: 'primary',
            value: {
              [DREAMUX_ACTION_KEY]: DREAMUX_PAIRING_CARD_ACTION,
              [DREAMUX_PAIRING_TOKEN_KEY]: input.token,
            },
          },
        ],
      },
    ],
  };
}

export function buildPairingSuccessCard(input: PairingSuccessCardInput): unknown {
  const content = input.duplicate
    ? '目标已经在允许列表中，授权请求已关闭。'
    : 'Owner 校验通过，访问权限已写入允许列表。';
  const enContent = input.duplicate
    ? 'The target is already allowed. The authorization request is now closed.'
    : 'Owner verification passed. Access has been added to the allowlist.';
  return {
    config: { wide_screen_mode: true, enable_forward: false, update_multi: true },
    header: {
      template: 'green',
      title: {
        tag: 'plain_text',
        content: '授权成功',
        i18n_content: {
          en_us: 'Authorized',
        },
      },
    },
    elements: [
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content,
          i18n_content: {
            en_us: enContent,
          },
        },
      },
    ],
  };
}

function escapeAtId(value: string): string {
  return value.replace(/[&"<>]/g, '');
}

export function rawCardActionResponse(
  card: unknown,
  toast: NonNullable<FeishuCardActionResponse['toast']>,
): FeishuCardActionResponse {
  return {
    toast,
    card: {
      type: 'raw',
      data: card,
    },
  };
}
