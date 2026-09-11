/**
 * Operator-authorized native Feishu Markdown rendering probes.
 * Uses Node fetch directly: no CLI, SDK, Markdown normalization, or card renderer.
 * Credentials and real recipient identifiers are runtime inputs, never fixtures.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

const { values } = parseArgs({
  options: {
    config: { type: 'string' },
    dispatcher: { type: 'string' },
    channel: { type: 'string' },
    'expected-bot-open-id': { type: 'string' },
    'recipient-open-id': { type: 'string' },
    output: { type: 'string' },
    'mention-probes-only': { type: 'boolean', default: false },
  },
});
for (const name of ['config', 'dispatcher', 'channel', 'expected-bot-open-id', 'recipient-open-id', 'output']) {
  if (!values[name]) throw new Error(`Missing --${name}`);
}

const config = JSON.parse(await readFile(values.config, 'utf8'));
const channel = config.dispatchers
  .find((entry) => entry.id === values.dispatcher)?.channels
  .find((entry) => entry.id === values.channel);
if (channel?.provider !== 'builtin:feishu') throw new Error('Selected channel is not builtin:feishu');

const origin = 'https://open.feishu.cn';
const authResponse = await fetch(`${origin}/open-apis/auth/v3/tenant_access_token/internal`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json; charset=utf-8' },
  body: JSON.stringify(channel.config),
});
const auth = await authResponse.json();
if (!authResponse.ok || auth.code !== 0 || !auth.tenant_access_token) {
  throw new Error(`Authentication failed: HTTP ${authResponse.status}, code ${auth.code}`);
}

const headers = {
  Authorization: `Bearer ${auth.tenant_access_token}`,
  'Content-Type': 'application/json; charset=utf-8',
};
const identityResponse = await fetch(`${origin}/open-apis/bot/v3/info`, { headers });
const identity = await identityResponse.json();
if (!identityResponse.ok || identity.code !== 0 || identity.bot?.open_id !== values['expected-bot-open-id']) {
  throw new Error('Configured bot does not match the explicitly selected sender');
}

const recipient = values['recipient-open-id'];
const mention = `<at user_id="${recipient}">你</at>`;
const probes = values['mention-probes-only'] ? [
  {
    name: '06-empty-and-bot-mentions',
    markdown: [
      '## 追加探针 · 空名称与机器人 @',
      '继续使用直连飞书 HTTP API；这条用于补齐 review 的 @ 身份检查。',
      `A. 空名称 @ 你：<at user_id="${recipient}"></at>`,
      `B. 空名称 @ 当前机器人：<at user_id="${identity.bot.open_id}"></at>`,
      `C. 带名称 @ 当前机器人：<at user_id="${identity.bot.open_id}">机器人</at>`,
      '下面是代码样例，应显示标签本身：',
      `\`<at user_id="${recipient}"></at>\``,
      ['```xml', `<at user_id="${identity.bot.open_id}"></at>`, '```'].join('\n'),
      '追加探针结束。',
    ].join('\n\n'),
  },
] : [
  {
    name: '01-typography',
    markdown: [
      '# 原生富文本探针 1/5 · 标题与排版',
      '这组样例由机器人直接调用飞书 HTTP API 发送，正文使用原生 post + md。',
      '## 二级标题',
      '### 三级标题',
      '#### 四级标题',
      '##### 五级标题',
      '###### 六级标题',
      '**加粗**、*斜体*、~~删除线~~、`inline_code`。',
      '中文与 English 混排：你好，Feishu 👋。',
      '第一行（软换行）\n第二行。',
      '独立的新段落。',
      '> 这是一段引用。\n> 第二行引用。',
      '- 无序列表 A\n- 无序列表 B\n  - 嵌套项目',
      '1. 有序列表第一项\n2. 有序列表第二项',
      '- [x] 已完成\n- [ ] 待检查',
      '---',
      '[飞书开放平台](https://open.feishu.cn) · https://open.feishu.cn',
      '探针 1 结束。',
    ].join('\n\n'),
  },
  {
    name: '02-inline-mentions',
    markdown: [
      '## 原生富文本探针 2/5 · 正文 XML @',
      `请 ${mention} 看一下这里。@ 应出现在句子中间，并显示为可点击的用户。`,
      '下面的 XML 放在行内代码中，应显示字面文本：',
      `\`${mention}\``,
      '下面的 XML 放在代码块中，也应显示字面文本：',
      ['```xml', mention, '```'].join('\n'),
      '探针 2 结束。',
    ].join('\n\n'),
  },
  {
    name: '03-tables',
    markdown: [
      '## 原生富文本探针 3/5 · 表格',
      '下面应显示原生表格，保留中文、数字、加粗和行内代码。',
      [
        '| 检查项 | 示例 | 状态 |',
        '| :--- | ---: | :---: |',
        '| 中文内容 | 123.45 | ✅ |',
        '| **加粗内容** | 0 | 待确认 |',
        '| `inline_code` | -8 | 🧪 |',
        '| [链接](https://open.feishu.cn) | 9999 | 正常 |',
        '| 包含转义分隔符 A \\| B | 42 | 检查 |',
      ].join('\n'),
      '表格之后的独立段落，应出现在表格外。',
      '探针 3 结束。',
    ].join('\n\n'),
  },
  {
    name: '04-code-and-escaping',
    markdown: [
      '## 原生富文本探针 4/5 · 代码与转义',
      '下面是 TypeScript 代码，检查缩进、换行和高亮：',
      [
        '```typescript',
        'interface Reply {',
        '  text: string;',
        '}',
        '',
        'const reply: Reply = { text: "你好，Feishu 👋" };',
        'console.log(JSON.stringify(reply));',
        '```',
      ].join('\n'),
      'JSON 字符串中的反斜杠、双引号和换行字面量应保持：',
      ['```json', JSON.stringify({ quote: 'say "hello"', path: 'demo\\file.txt', newline: 'line1\nline2' }, null, 2), '```'].join('\n'),
      '普通正文：A & B、1 < 2、3 > 2。',
      'Unicode：汉字 / é / 👨‍👩‍👧‍👦 / 🇨🇳 / 👍🏽。',
      '探针 4 结束。',
    ].join('\n\n'),
  },
  {
    name: '05-long-content',
    markdown: [
      '## 原生富文本探针 5/5 · 长内容与尾部完整性',
      '这条仍是单个原生 post，用于检查长内容的展示、折叠和尾部完整性。',
      Array.from({ length: 48 }, (_, index) => `${String(index + 1).padStart(2, '0')}. 这是连续内容第 ${index + 1} 行：中文与 English、**重点**、\`value_${index + 1}\`，以及 emoji 🧪。`).join('\n'),
      '### 长表格',
      ['| 序号 | 项目 | 值 |', '| --- | --- | --- |', ...Array.from({ length: 20 }, (_, index) => `| ${index + 1} | 检查项目 ${index + 1} | native_md_${index + 1} |`)].join('\n'),
      '### 尾部标记',
      '**NATIVE_POST_PROBE_END_5_OF_5**',
      '看到这行表示本条样例的最后一段已显示。',
    ].join('\n\n'),
  },
];

await mkdir(values.output, { recursive: true, mode: 0o700 });
const receipts = [];
for (const probe of probes) {
  const body = JSON.stringify({
    receive_id: recipient,
    msg_type: 'post',
    content: JSON.stringify({ zh_cn: { content: [[{ tag: 'md', text: probe.markdown }]] } }),
  });
  const requestBytes = Buffer.byteLength(body, 'utf8');
  if (requestBytes > 30 * 1024) throw new Error(`Probe ${probe.name} exceeds the documented request limit`);
  await writeFile(join(values.output, `${probe.name}.request.json`), body, { mode: 0o600 });
  const response = await fetch(`${origin}/open-apis/im/v1/messages?receive_id_type=open_id`, {
    method: 'POST', headers, body,
  });
  const result = await response.json();
  await writeFile(join(values.output, `${probe.name}.response.json`), JSON.stringify(result, null, 2), { mode: 0o600 });
  if (!response.ok || result.code !== 0 || !result.data?.message_id) {
    throw new Error(`Probe ${probe.name} failed: HTTP ${response.status}, code ${result.code}, message ${result.msg}`);
  }
  const receipt = {
    probe: probe.name,
    requestBytes,
    messageId: result.data.message_id,
    messageType: result.data.msg_type,
    mentionCount: result.data.mentions?.length ?? 0,
    recipientMentioned: result.data.mentions?.some((entry) => entry.id === recipient) ?? false,
  };
  receipts.push(receipt);
  await writeFile(join(values.output, 'receipts.json'), JSON.stringify(receipts, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(receipt));
  await delay(350);
}
