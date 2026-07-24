import type * as lark from '@larksuiteoapi/node-sdk'

import type { OutboundTarget } from '../contract/outbound.js'

type MessageSendResponse = { data?: { message_id?: string } }

type MessageApiWithReply = {
  reply(args: {
    path: { message_id: string }
    data: { msg_type: string; content: string }
  }): Promise<MessageSendResponse>
}

export async function sendInteractiveCard(
  client: lark.Client,
  target: OutboundTarget,
  content: string,
  signal?: AbortSignal,
): Promise<MessageSendResponse> {
  const data = { msg_type: 'interactive', content }
  if (signal !== undefined) {
    if (target.replyToMessageId !== undefined) {
      return client.request<MessageSendResponse>({
        url:
          `/open-apis/im/v1/messages/${encodeURIComponent(target.replyToMessageId)}/reply`,
        method: 'POST',
        data,
        signal,
      })
    }
    return client.request<MessageSendResponse>({
      url: '/open-apis/im/v1/messages',
      method: 'POST',
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: target.chatId,
        ...data,
      },
      signal,
    })
  }
  if (target.replyToMessageId !== undefined) {
    const messageApi = client.im.message as unknown as MessageApiWithReply
    return messageApi.reply({
      path: { message_id: target.replyToMessageId },
      data,
    })
  }
  return client.im.message.create({
    params: { receive_id_type: 'chat_id' },
    data: {
      receive_id: target.chatId,
      ...data,
    },
  })
}
