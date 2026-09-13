/** Historical pre-PR probe for baseline 3cac2f7; not a current-contract check. */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { stripTypeScriptTypes } from 'node:module';

const captureDir = process.argv[2];
if (!captureDir) throw new Error('Pass the private probe capture directory');
const snapshotDir = join(captureDir, 'source-replay');
const files = [
  ...['parts', 'card', 'post', 'content'].map((name) => `packages/channel/feishu-transport/src/parse/${name}.ts`),
  'packages/channel/feishu-transport/src/transport/message-read.ts',
  'packages/channel/feishu-channel/src/feishu-message-render.ts',
  'packages/channel/feishu-channel/src/feishu-reply-ancestry.ts',
];
for (const file of files) {
  const output = join(snapshotDir, file.replace(/\.ts$/, '.js'));
  await mkdir(dirname(output), { recursive: true, mode: 0o700 });
  const source = await readFile(file, 'utf8');
  await writeFile(output, stripTypeScriptTypes(source, { mode: 'strip' }), { mode: 0o600 });
}
await writeFile(join(snapshotDir, 'package.json'), '{"type":"module"}', { mode: 0o600 });
const load = (file) => import(pathToFileURL(join(snapshotDir, file)).href);
const { parseInbound } = await load('packages/channel/feishu-transport/src/parse/content.js');
const { normalizeMessageReadItem } = await load('packages/channel/feishu-transport/src/transport/message-read.js');
const { renderFeishuStructuredBody } = await load('packages/channel/feishu-channel/src/feishu-message-render.js');

const receipts = JSON.parse(await readFile(join(captureDir, 'receipts.json'), 'utf8'));
const summaries = [];
for (const receipt of receipts) {
  const response = JSON.parse(await readFile(join(captureDir, `${receipt.probe}.get.json`), 'utf8'));
  const item = normalizeMessageReadItem(response.data.items[0]);
  const post = JSON.parse(item.content);
  const parse = (content) => parseInbound({ message_type: item.messageType, content, mentions: item.mentions });
  const parsed = parse(item.content);
  const event = {
    messageId: item.messageId,
    messageType: item.messageType,
    rawContent: item.content,
    mentions: item.mentions,
    parsedText: parsed.text,
    contentParts: parsed.parts,
    resources: parsed.resources,
  };
  const render = (event) => renderFeishuStructuredBody(event, [], (resource) => ({ ...resource, status: 'not_downloaded' })).body;
  const body = render(event);
  // This second input isolates the consequence of merely selecting content_v2.
  // It is not a patched parser, live event, or complete proposed implementation.
  const selected = parse(JSON.stringify({ ...post, content: post.content_v2 }));
  const selectionOnlyBody = render({ ...event, parsedText: selected.text, contentParts: selected.parts, resources: selected.resources });
  const details = { current: { parsed, body }, selectionOnly: { parsed: selected, body: selectionOnlyBody } };
  await writeFile(join(captureDir, `${receipt.probe}.inbound-replay.json`), JSON.stringify(details, null, 2), { mode: 0o600 });
  const summary = {
    probe: receipt.probe,
    nestedContentV2: Array.isArray(post.content_v2),
    currentRetainsHeadingSyntax: parsed.text.startsWith('#'),
    selectionRetainsHeadingSyntax: selected.text.startsWith('#'),
    currentRendersStructuredMention: body.includes('<at id='),
    selectionEscapesMentionXml: selectionOnlyBody.includes('&lt;at user_id='),
    currentCodeLengths: parsed.parts.filter((part) => part.kind === 'code').map((part) => part.code.length),
    currentIncomplete: parsed.incomplete ?? false,
  };
  summaries.push(summary);
  console.log(JSON.stringify(summary));
}
await writeFile(join(captureDir, 'inbound-replay-summary.json'), JSON.stringify(summaries, null, 2), { mode: 0o600 });
