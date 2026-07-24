export type FeishuCardTemplate = 'blue' | 'green' | 'grey';

export interface FeishuCardField {
  label: string;
  enLabel: string;
  value: string;
  enValue: string;
}

export function buildFeishuCard(input: {
  template: FeishuCardTemplate;
  title: string;
  enTitle: string;
  elements: unknown[];
  updateMulti?: boolean;
}): unknown {
  return {
    config: {
      wide_screen_mode: true,
      enable_forward: false,
      ...(input.updateMulti === true ? { update_multi: true } : {}),
    },
    header: {
      template: input.template,
      title: {
        tag: 'plain_text',
        content: input.title,
        i18n_content: { en_us: input.enTitle },
      },
    },
    elements: input.elements,
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
      fields: [
        {
          is_short: false,
          text: {
            tag: 'plain_text',
            content: `${field.label}：${field.value}`,
            i18n_content: {
              en_us: `${field.enLabel}: ${field.enValue}`,
            },
          },
        },
      ],
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
