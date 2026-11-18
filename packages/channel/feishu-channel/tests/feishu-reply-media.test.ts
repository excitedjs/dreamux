/** Real tool/session/outbound/transport with only SDK IO replaced. */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DreamuxLogger, JsonValue } from '@excitedjs/dreamux-types';
import {
  createFeishuTransport,
  type FeishuTransportOptions,
} from '@excitedjs/feishu-transport';
import { createFeishuBot } from '../src/bot.js';
import { FeishuChannelSession } from '../src/session/session.js';
import { createFeishuSessionMcp } from '../src/tools/session-mcp.js';
import { replyDef } from '../src/tools/messaging-tools.js';
import { CHANNEL_SENDER } from '../src/outbound/index.js';
import { createFakeFeishuBot } from './helpers/fake-feishu-bot.js';
vi.mock('../src/bot.js', () => ({ createFeishuBot: vi.fn() }));

const log: DreamuxLogger = {
  info() {},
  error() {},
  warn() {},
  debug() {},
  trace() {},
  child: () => log,
};
const held: Array<{ root: string; session: FeishuChannelSession }> = [];
afterEach(async () => {
  for (const { root, session } of held.splice(0)) {
    await session.close();
    await rm(root, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

async function fixture(cardMode: 'interactive' | 'post' = 'interactive') {
  const root = await mkdtemp(join(tmpdir(), 'feishu-reply-media-'));
  const imagePath = join(root, 'shot.png');
  const videoPath = join(root, 'video.mp4');
  const archivePath = join(root, 'bundle.zip');
  await writeFile(imagePath, Buffer.from([0, 17, 255]));
  await writeFile(videoPath, Buffer.from('MP4 bytes'));
  await writeFile(archivePath, Buffer.from('ZIP bytes'));
  const events: string[] = [];
  const image = vi.fn(async (_input: unknown) => {
    events.push('upload:image');
    return { image_key: 'img_uploaded' };
  });
  const file = vi.fn(async (input: unknown) => {
    const { data } = input as { data: { file_name: string } };
    events.push(`upload:${data.file_name}`);
    return { file_key: `file_${data.file_name}` };
  });
  let serial = 0;
  const request = vi.fn(async (input: unknown): Promise<unknown> => {
    const { data } = input as { data: { msg_type: string; content: string } };
    events.push(`send:${data.msg_type}`);
    return {
      code: 0,
      data: {
        message_id: `sent-${++serial}`,
        chat_id: 'actual-chat',
        thread_id: 'actual-topic',
      },
    };
  });
  const transport = createFeishuTransport(
    { appId: 'app', appSecret: 'fake' },
    {
      client: {
        request,
        im: { v1: { image: { create: image }, file: { create: file } } },
      } as unknown as NonNullable<FeishuTransportOptions['client']>,
    },
  );
  vi.mocked(createFeishuBot).mockReturnValueOnce({
    ...createFakeFeishuBot(),
    send: transport.send,
    sendCard: transport.sendCard,
    sendFile: transport.sendFile,
    uploadImage: transport.uploadImage,
    uploadFile: transport.uploadFile,
  });
  const session = new FeishuChannelSession({
    dispatcherId: 'disp',
    channelId: 'primary',
    appId: 'app',
    appSecret: 'fake',
    stateDir: root,
    attachmentCacheDir: root,
    log,
    cardMode,
  });
  held.push({ root, session });
  await session.initialize({
    invoke: { invoke: async () => null },
    events: { subscribe: () => ({ unsubscribe() {} }) },
  });
  const mcp = createFeishuSessionMcp(
    session.tools,
    session.extensions,
    session.lifecycle,
    log,
  );
  const reply = (args: Record<string, JsonValue>) =>
    mcp.invoke(
      { name: 'reply', arguments: args },
      {
        dispatcher_id: 'disp',
        channel_id: 'primary',
        caller: {
          kind: 'team_leader',
          team_name: 'team',
          leader_name: 'leader',
        },
      },
    );
  return {
    root,
    session,
    reply,
    request,
    image,
    file,
    events,
    imagePath,
    videoPath,
    archivePath,
  };
}

it('documents optional non-image artifacts and inline local images without an image argument', () => {
  const schema = replyDef.inputSchema as {
    properties: Record<string, unknown>;
    required: string[];
  };
  expect(schema.properties['artifacts']).toMatchObject({
    type: 'array',
    items: { type: 'string', minLength: 1, pattern: '^/(?!/)' },
  });
  expect(schema.properties).not.toHaveProperty('image');
  expect(schema.required).toEqual(['chat_id', 'text']);
  expect(replyDef.description).toContain('![alt](/absolute/path)');
  expect(
    replyDef.parse({ chat_id: 'chat', text: 'text', artifacts: [] }),
  ).toEqual({ chatId: 'chat', text: 'text', artifacts: [] });
});

it.each([
  null,
  'a.zip',
  [null],
  [''],
  ['  '],
  ['a.zip'],
  ['https://example.test/a.zip'],
  ['//example.test/a.zip'],
])('refuses invalid artifacts %s before any send', async (artifacts) => {
  const f = await fixture();
  const result = await f.reply({ chat_id: 'chat', text: 'text', artifacts });
  expect(result).toMatchObject({
    ok: false,
    message: expect.stringContaining('artifacts'),
  });
  expect(f.events).toEqual([]);
});

describe.each(['interactive', 'post'] as const)('reply media (%s)', (mode) => {
  it.each([undefined, 'source'])(
    'uploads exact bytes before create/reply, then text and ordered native files (%s)',
    async (messageId) => {
      const f = await fixture(mode);
      const body = `![alt](${f.imagePath} "title") <at user_id="ou_example">Example</at>`;
      const result = await f.reply({
        chat_id: 'chat',
        text: body,
        artifacts: [f.videoPath, f.archivePath],
        ...(messageId ? { message_id: messageId } : {}),
      });
      expect(result).toMatchObject({
        ok: true,
        value: { message_ids: ['sent-1', 'sent-2', 'sent-3'] },
      });
      expect(f.events).toEqual([
        'upload:image',
        'upload:video.mp4',
        'upload:bundle.zip',
        `send:${mode}`,
        'send:file',
        'send:file',
      ]);
      expect(f.image).toHaveBeenCalledWith({
        data: { image_type: 'message', image: await readFile(f.imagePath) },
      });
      expect(f.file).toHaveBeenNthCalledWith(1, {
        data: {
          file_name: 'video.mp4',
          file_type: 'stream',
          file: await readFile(f.videoPath),
        },
      });
      expect(f.file).toHaveBeenNthCalledWith(2, {
        data: {
          file_name: 'bundle.zip',
          file_type: 'stream',
          file: await readFile(f.archivePath),
        },
      });
      const calls = f.request.mock.calls.map(
        ([input]) =>
          input as {
            url: string;
            data: { content: string; receive_id?: string };
          },
      );
      for (const call of calls) {
        expect(call.url).toBe(
          messageId
            ? '/open-apis/im/v1/messages/source/reply'
            : '/open-apis/im/v1/messages',
        );
        expect(call.data.receive_id).toBe(messageId ? undefined : 'chat');
      }
      const rewritten =
        '![alt](img_uploaded "title") <at user_id="ou_example">Example</at>';
      expect(JSON.parse(calls[0]!.data.content)).toEqual(
        mode === 'post'
          ? { zh_cn: { content: [[{ tag: 'md', text: rewritten }]] } }
          : {
              schema: '2.0',
              config: { update_multi: true },
              body: { elements: [{ tag: 'markdown', content: rewritten }] },
            },
      );
      expect(JSON.parse(calls[1]!.data.content)).toEqual({
        file_key: 'file_video.mp4',
      });
      expect(JSON.parse(calls[2]!.data.content)).toEqual({
        file_key: 'file_bundle.zip',
      });
    },
  );
  it('resolves a collaboration-space topic once for text and all files', async () => {
    const f = await fixture(mode);
    const registered = await f.session.routing.bindSpace({
      spaceName: 'space',
      containerChatId: 'chat',
      display: null,
      leaderAgentRuntime: 'codex',
      identity: null,
      repo: null,
    });
    await f.session.routing.bind({
      target: { kind: 'topic', chatId: 'chat', threadId: 'topic' },
      teamName: 'team',
      display: null,
      rootMessageId: 'topic-root',
      spaceId: registered.space_id,
    });
    const space = vi.spyOn(f.session.routing, 'spaceForContainer');
    const topics = vi.spyOn(f.session.routing, 'topicBindingsFor');
    await f.reply({
      chat_id: 'chat',
      text: 'text',
      artifacts: [f.videoPath, f.archivePath],
    });
    expect(space).toHaveBeenCalledTimes(1);
    expect(topics).toHaveBeenCalledTimes(1);
    for (const [call] of f.request.mock.calls)
      expect(call).toMatchObject({
        url: '/open-apis/im/v1/messages/topic-root/reply',
      });
  });
  it('splits rewritten Markdown first, then files, preserving aggregate receipts', async () => {
    const f = await fixture(mode);
    const result = await f.reply({
      chat_id: 'chat',
      text: `![alt](${f.imagePath})\n\n${'汉'.repeat(30_000)}`,
      artifacts: [f.archivePath],
    });
    expect(result).toMatchObject({
      ok: true,
      value: {
        message_ids: [
          'sent-1',
          'sent-2',
          'sent-3',
          'sent-4',
          'sent-5',
          'sent-6',
        ],
      },
    });
    expect(f.events.slice(0, 2)).toEqual(['upload:image', 'upload:bundle.zip']);
    expect(f.events.at(-1)).toBe('send:file');
    expect(
      f.events.slice(2, -1).every((event) => event === `send:${mode}`),
    ).toBe(true);
  });
  it.each(['image-read', 'image-upload', 'artifact-read', 'artifact-upload'])(
    'sends nothing on %s failure and reports the path',
    async (failure) => {
      const f = await fixture(mode);
      const missing = join(f.root, 'missing');
      if (failure === 'image-upload')
        f.image.mockRejectedValueOnce(new Error('image denied'));
      if (failure === 'artifact-upload')
        f.file.mockRejectedValueOnce(new Error('file denied'));
      const path =
        failure === 'image-read' || failure === 'artifact-read'
          ? missing
          : failure === 'image-upload'
            ? f.imagePath
            : f.videoPath;
      const result = await f.reply({
        chat_id: 'chat',
        text: `![alt](${failure === 'image-read' ? missing : f.imagePath})`,
        artifacts: [failure === 'artifact-read' ? missing : f.videoPath],
      });
      expect(result).toMatchObject({
        ok: false,
        message: expect.stringContaining(path),
      });
      expect(f.request).not.toHaveBeenCalled();
    },
  );
  it('stops after a later file failure and reports earlier text/file ids and failed artifact', async () => {
    const f = await fixture(mode);
    f.request
      .mockResolvedValueOnce({
        code: 0,
        data: { message_id: 'text-id', chat_id: 'chat' },
      })
      .mockResolvedValueOnce({
        code: 0,
        data: { message_id: 'video-id', chat_id: 'chat' },
      })
      .mockResolvedValueOnce({
        code: 230028,
        msg: 'denied',
        error: { log_id: 'log_example' },
      });
    const result = await f.reply({
      chat_id: 'chat',
      text: 'text',
      artifacts: [f.videoPath, f.archivePath, f.videoPath],
    });
    expect(result).toMatchObject({
      ok: false,
      message: expect.stringContaining(f.archivePath),
    });
    if (!result.ok) {
      expect(result.message).toContain('text-id, video-id');
      expect(result.message).toContain('code 230028');
      expect(result.message).toContain('log_id=log_example');
    }
    expect(f.request).toHaveBeenCalledTimes(3);
  });
  it('retains earlier chunk receipts if text sending fails and sends no file', async () => {
    const f = await fixture(mode);
    f.request
      .mockResolvedValueOnce({
        code: 0,
        data: { message_id: 'chunk-id', chat_id: 'chat' },
      })
      .mockRejectedValueOnce(new Error('text denied'));
    await expect(
      f.reply({
        chat_id: 'chat',
        text: 'x'.repeat(90_000),
        artifacts: [f.videoPath],
      }),
    ).rejects.toThrow('already sent message_ids: chunk-id');
    expect(f.events).toEqual(['upload:video.mp4']);
    expect(f.request).toHaveBeenCalledTimes(2);
    for (const [call] of f.request.mock.calls)
      expect(call).toMatchObject({ data: { msg_type: mode } });
  });
});

it('channel-authored notices remain interactive on a post-configured session', async () => {
  const f = await fixture('post');
  await f.session.tools.outbound.sendText({
    chatId: 'chat',
    text: 'notice',
    sender: CHANNEL_SENDER,
  });
  expect(f.events).toEqual(['send:interactive']);
});
