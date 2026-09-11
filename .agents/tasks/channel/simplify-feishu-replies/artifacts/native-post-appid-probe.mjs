/** Direct-HTTP probe: mention a peer bot by application ID in native post Markdown. */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: { ...Object.fromEntries([
    'config', 'dispatcher', 'channel', 'expected-bot-open-id',
    'reference-message-id', 'expected-peer-open-id', 'reply-to-message-id', 'output',
  ].map((name) => [name, { type: 'string' }])),
  'structured-at': { type: 'boolean', default: false } },
});
for (const name of [
  'config', 'dispatcher', 'channel', 'expected-bot-open-id',
  'reference-message-id', 'expected-peer-open-id', 'reply-to-message-id', 'output',
]) {
  if (!values[name]) throw new Error(`Missing --${name}`);
}

const config = JSON.parse(await readFile(values.config, 'utf8'));
const channel = config.dispatchers.find((entry) => entry.id === values.dispatcher)
  ?.channels.find((entry) => entry.id === values.channel);
if (channel?.provider !== 'builtin:feishu') throw new Error('Selected channel is not builtin:feishu');
const origin = 'https://open.feishu.cn';
const auth = await fetch(`${origin}/open-apis/auth/v3/tenant_access_token/internal`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(channel.config),
}).then((response) => response.json());
if (auth.code !== 0 || !auth.tenant_access_token) throw new Error('Authentication failed');
const headers = {
  Authorization: `Bearer ${auth.tenant_access_token}`,
  'Content-Type': 'application/json',
};
const identity = await fetch(`${origin}/open-apis/bot/v3/info`, { headers })
  .then((response) => response.json());
if (identity.bot?.open_id !== values['expected-bot-open-id']) throw new Error('Unexpected sender bot');
await mkdir(values.output, { recursive: true, mode: 0o700 });
const capture = (name, data) => writeFile(
  join(values.output, `${name}.json`), JSON.stringify(data, null, 2), { mode: 0o600 },
);
const readMessage = async (messageId, query, label) => {
  const result = await fetch(`${origin}/open-apis/im/v1/messages/${messageId}${query}`, { headers })
    .then((response) => response.json());
  await capture(label, result);
  if (result.code !== 0) throw new Error(`Read ${label} failed: ${result.code}`);
  return result.data.items.find((item) => item.message_id === messageId);
};

const original = await readMessage(values['reference-message-id'], '', 'reference-default');
const explicit = await readMessage(values['reference-message-id'], '?user_id_type=open_id', 'reference-explicit');
const peer = original.mentions?.find((mention) => mention.id === values['expected-peer-open-id']);
const application = explicit.mentions?.find((mention) => mention.key === peer?.key);
if (!peer || application?.id_type !== 'app_id' || !application.id?.startsWith('cli_')) {
  throw new Error('The reference does not prove an application ID for the selected peer');
}

const marker = values['structured-at']
  ? 'APP_ID_STRUCTURED_POST_PROBE_410'
  : 'APP_ID_NATIVE_POST_PROBE_410';
const text = [
  `<at user_id="${application.id}">Devbox</at>`,
  `原生 post 的 appId @ 探针：${marker}`,
  '本条仅通过 appId @ 你，没有混入 open_id、@all 或卡片。使用 Node fetch 直接调用飞书 reply API。',
  '请核验这条探针自身是否在你侧产生实时入站提交，以及原始事件 mentions 的身份；若只能证明 GET 返回，请单独说明。无需重复技术方案 review，也不要把其他消息的唤醒算到本条。',
].join('\n\n');
const rows = values['structured-at']
  ? [[{ tag: 'at', user_id: application.id }], [{ tag: 'md', text: text.split('\n\n').slice(1).join('\n\n') }]]
  : [[{ tag: 'md', text }]];
const request = {
  msg_type: 'post',
  content: JSON.stringify({ zh_cn: { content: rows } }),
};
if (request.content.includes('ou_')) throw new Error('An open ID entered the probe content');
await capture('probe-request', request);
const response = await fetch(
  `${origin}/open-apis/im/v1/messages/${values['reply-to-message-id']}/reply`,
  { method: 'POST', headers, body: JSON.stringify(request) },
).then((result) => result.json());
await capture('probe-response', response);
const summary = {
  marker,
  format: values['structured-at'] ? 'at-node' : 'md',
  code: response.code,
  messageId: response.data?.message_id,
  messageType: response.data?.msg_type,
  mentionCount: response.data?.mentions?.length ?? 0,
  mentionTypes: response.data?.mentions?.map((mention) => mention.id_type) ?? [],
  peerOpenIdReturned: response.data?.mentions?.some((mention) => mention.id === peer.id) ?? false,
  peerAppIdReturned: response.data?.mentions?.some((mention) => mention.id === application.id) ?? false,
};
if (response.code === 0 && response.data?.message_id) {
  const read = await readMessage(response.data.message_id, '', 'probe-read-default');
  summary.readMentionCount = read.mentions?.length ?? 0;
  summary.readPeerOpenIdReturned = read.mentions?.some((mention) => mention.id === peer.id) ?? false;
  summary.readPeerAppIdReturned = read.mentions?.some((mention) => mention.id === application.id) ?? false;
  summary.readMentionTypes = read.mentions?.map((mention) => mention.id_type) ?? [];
}
await capture('summary', summary);
console.log(JSON.stringify(summary));
