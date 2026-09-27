/**
 * The generic Card 2.0 envelope kit: `schema`/`config`/`header`/`body`
 * wrapper, shared by every card in this package that does not need a bespoke
 * envelope. A card's own body vocabulary (its `elements`) stays with the
 * card that builds it; this file only assembles the parts every card needs
 * around them, so there is exactly one place that knows the envelope shape.
 */
export type FeishuCardTemplate = 'blue' | 'green' | 'grey' | 'orange';

export interface FeishuCardField {
  label: string;
  enLabel: string;
  value: string;
  enValue: string;
}

/** A header status badge (Feishu `text_tag`), e.g. "Bound" / "Unbound". */
export interface FeishuCardStatusBadge {
  text: string;
  color: string;
}

export interface FeishuCardIcon {
  token: string;
  color?: string;
}

export function buildFeishuCard(input: {
  template: FeishuCardTemplate;
  title: string;
  /** Omit for an English-only title: no `i18n_content` is added. */
  enTitle?: string;
  icon?: FeishuCardIcon;
  statusBadge?: FeishuCardStatusBadge;
  /** Chat-list preview text (Card 2.0 `config.summary`). */
  summary?: string;
  direction?: 'vertical';
  padding?: string;
  elements: unknown[];
  updateMulti?: boolean;
  /**
   * Whether the Feishu client's forward action stays on this card. Defaults
   * to off, since most cards this kit builds are approval/status notices for
   * the conversation that triggered them; a caller sets this when its card
   * carries content meant to circulate beyond that conversation.
   */
  enableForward?: boolean;
}): unknown {
  return {
    schema: '2.0',
    config: {
      enable_forward: input.enableForward === true,
      width_mode: 'default',
      ...(input.summary !== undefined
        ? { summary: { content: input.summary } }
        : {}),
      ...(input.updateMulti === true ? { update_multi: true } : {}),
    },
    header: {
      template: input.template,
      title: {
        tag: 'plain_text',
        content: input.title,
        ...(input.enTitle !== undefined
          ? { i18n_content: { en_us: input.enTitle } }
          : {}),
      },
      ...(input.icon !== undefined
        ? { icon: { tag: 'standard_icon', ...input.icon } }
        : {}),
      ...(input.statusBadge !== undefined
        ? {
            text_tag_list: [
              {
                tag: 'text_tag',
                text: { tag: 'plain_text', content: input.statusBadge.text },
                color: input.statusBadge.color,
              },
            ],
          }
        : {}),
    },
    body: {
      ...(input.direction !== undefined ? { direction: input.direction } : {}),
      ...(input.padding !== undefined ? { padding: input.padding } : {}),
      elements: input.elements,
    },
  };
}

export function buildFeishuStatusCard(input: {
  template: Extract<FeishuCardTemplate, 'green' | 'grey'>;
  title: string;
  enTitle: string;
  fields: FeishuCardField[];
}): unknown {
  return buildFeishuCard({
    template: input.template,
    title: input.title,
    enTitle: input.enTitle,
    elements: input.fields.map((field) => ({
      tag: 'div',
      text: {
        tag: 'plain_text',
        content: `${field.label}：${field.value}`,
        i18n_content: {
          en_us: `${field.enLabel}: ${field.enValue}`,
        },
      },
    })),
  });
}

export function feishuCardField(
  label: string,
  enLabel: string,
  value: string,
  enValue = value,
): FeishuCardField {
  return { label, enLabel, value, enValue };
}
