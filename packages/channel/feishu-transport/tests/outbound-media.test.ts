/** Public transport over the SDK boundary; uploads never access local paths. */
import { describe, expect, it, vi } from 'vitest';
import {
  createFeishuTransport,
  type FeishuTransportOptions,
} from '@excitedjs/feishu-transport';

function fixture() {
  const image = vi.fn(async (_input: unknown) => ({
    image_key: 'img_uploaded',
  }));
  const file = vi.fn(async (_input: unknown) => ({
    file_key: 'file_uploaded',
  }));
  const request = vi.fn(async (_input: unknown) => ({
    code: 0,
    data: {
      message_id: 'sent',
      chat_id: 'actual-chat',
      thread_id: 'actual-topic',
    },
  }));
  const transport = createFeishuTransport(
    { appId: 'app', appSecret: 'fake' },
    {
      client: {
        request,
        im: { v1: { image: { create: image }, file: { create: file } } },
      } as unknown as NonNullable<FeishuTransportOptions['client']>,
    },
  );
  return { transport, image, file, request };
}

it('uploads exact image bytes and returns the SDK direct image key', async () => {
  const { transport, image } = fixture();
  const bytes = Buffer.from([0, 1, 255]);
  await expect(transport.uploadImage(bytes)).resolves.toBe('img_uploaded');
  expect(image).toHaveBeenCalledWith({
    data: { image_type: 'message', image: bytes },
  });
});

it.each([
  ['video.MP4', 'stream'],
  ['bundle.zip', 'stream'],
  ['sound.opus', 'opus'],
  ['report.pdf', 'pdf'],
  ['report.docx', 'doc'],
  ['report.xlsx', 'xls'],
  ['report.pptx', 'ppt'],
])('uploads %s using file_type %s', async (fileName, fileType) => {
  const { transport, file } = fixture();
  const bytes = Buffer.from('file bytes');
  await expect(transport.uploadFile({ fileName, bytes })).resolves.toBe(
    'file_uploaded',
  );
  expect(file).toHaveBeenCalledWith({
    data: { file_name: fileName, file_type: fileType, file: bytes },
  });
});

it('propagates upload failures and never accepts a missing SDK key', async () => {
  const { transport, image, file } = fixture();
  const failure = new Error('upload denied');
  image.mockRejectedValueOnce(failure);
  await expect(transport.uploadImage(Buffer.from('x'))).rejects.toBe(failure);
  file.mockResolvedValueOnce({} as { file_key: string });
  await expect(
    transport.uploadFile({ fileName: 'a.zip', bytes: Buffer.from('x') }),
  ).rejects.toThrow(/no file_key/);
});

describe.each([undefined, 'source/id'])(
  'public create/reply boundary (%s)',
  (replyToMessageId) => {
    it.each([undefined, 'interactive', 'post'] as const)(
      'sends Markdown with mode %s and retains actual receipts',
      async (messageType) => {
        const { transport, request } = fixture();
        const target = {
          chatId: 'chat',
          ...(replyToMessageId ? { replyToMessageId } : {}),
        };
        const body =
          '<at user_id="ou_example">Example</at> ![alt](img_uploaded)';
        const result = await transport.send(
          target,
          body,
          messageType === undefined ? undefined : { messageType },
        );
        const mode = messageType ?? 'interactive';
        const content =
          mode === 'post'
            ? { zh_cn: { content: [[{ tag: 'md', text: body }]] } }
            : {
                schema: '2.0',
                config: { update_multi: true },
                body: { elements: [{ tag: 'markdown', content: body }] },
              };
        expect(request).toHaveBeenCalledWith(
          expect.objectContaining({
            url: replyToMessageId
              ? '/open-apis/im/v1/messages/source%2Fid/reply'
              : '/open-apis/im/v1/messages',
            data: {
              ...(replyToMessageId ? {} : { receive_id: 'chat' }),
              msg_type: mode,
              content: JSON.stringify(content),
            },
          }),
        );
        expect(result.messages).toEqual([
          {
            messageId: 'sent',
            chatId: 'actual-chat',
            threadId: 'actual-topic',
          },
        ]);
      },
    );
    it('sends every artifact as file and explicit cards as interactive', async () => {
      const { transport, request } = fixture();
      const target = {
        chatId: 'chat',
        ...(replyToMessageId ? { replyToMessageId } : {}),
      };
      await transport.sendFile(target, 'file_uploaded');
      expect(request).toHaveBeenLastCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            msg_type: 'file',
            content: '{"file_key":"file_uploaded"}',
          }),
        }),
      );
      await transport.sendCard(
        target,
        { schema: '2.0' },
        { messageType: 'post' },
      );
      expect(request).toHaveBeenLastCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ msg_type: 'interactive' }),
        }),
      );
    });
    it('describes file platform failures with operation/code/reason/log id', async () => {
      const { transport, request } = fixture();
      request.mockResolvedValueOnce({
        code: 230028,
        msg: 'denied',
        error: { log_id: 'log_example' },
      } as unknown as Awaited<ReturnType<typeof request>>);
      await expect(
        transport.sendFile(
          { chatId: 'chat', ...(replyToMessageId ? { replyToMessageId } : {}) },
          'file_uploaded',
        ),
      ).rejects.toThrow(
        `Feishu message.${replyToMessageId ? 'reply' : 'create'} failed (code 230028, log_id=log_example): denied`,
      );
    });
  },
);
