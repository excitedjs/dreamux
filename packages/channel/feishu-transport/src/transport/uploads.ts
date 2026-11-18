/** Raw Feishu uploads accept bytes; local paths and delivery policy stay above. */
import type * as lark from '@larksuiteoapi/node-sdk';
import { extname } from 'node:path';

export async function uploadImage(
  client: lark.Client,
  bytes: Buffer,
): Promise<string> {
  const result = await client.im.v1.image.create({
    data: { image_type: 'message', image: bytes },
  });
  if (!result?.image_key)
    throw new Error('Feishu image.create returned no image_key');
  return result.image_key;
}

export async function uploadFile(
  client: lark.Client,
  input: { fileName: string; bytes: Buffer },
): Promise<string> {
  const suffix = extname(input.fileName).slice(1).toLowerCase();
  const fileType =
    suffix === 'docx'
      ? 'doc'
      : suffix === 'xlsx'
        ? 'xls'
        : suffix === 'pptx'
          ? 'ppt'
          : suffix;
  // MP4 uploads must use stream for native file messages; mp4 is a media
  // upload type and Feishu rejects sending its key as file (code 230055).
  const type =
    fileType === 'pdf' ||
    fileType === 'doc' ||
    fileType === 'xls' ||
    fileType === 'ppt' ||
    fileType === 'opus'
      ? fileType
      : 'stream';
  const result = await client.im.v1.file.create({
    data: { file_type: type, file_name: input.fileName, file: input.bytes },
  });
  if (!result?.file_key)
    throw new Error('Feishu file.create returned no file_key');
  return result.file_key;
}
