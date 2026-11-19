/**
 * Feishu message `content`: how an authored body becomes one, and how big one
 * may be.
 *
 * A reply holds authored Markdown in an interactive card or a native post.
 * Cards show compact text; native posts show larger text. Mentions retain
 * their authored syntax. The local-image helpers replace image destinations
 * before envelope selection and splitting.
 *
 * The only reason a body is ever cut is size. The budget is measured on the
 * serialized `content` string, JSON escaping included, because that is what
 * the platform receives.
 */

import { isAbsolute } from 'node:path';
import { marked, type Token, type Tokens } from 'marked';

/**
 * The serialized-content budget for one message, under the platform's
 * documented 30 KB ceiling. One budget covers rendered and raw cards alike:
 * cards and posts use the same `content` field.
 */
export const FEISHU_MESSAGE_CONTENT_SAFE_BYTES = 28 * 1024;

/** The platform message types that carry a Markdown body. */
export type FeishuTextMessageType = 'interactive' | 'post';

function messageContent(
  markdown: string,
  messageType: FeishuTextMessageType,
): string {
  if (messageType === 'post') {
    return JSON.stringify({
      zh_cn: { content: [[{ tag: 'md', text: markdown }]] },
    });
  }
  return JSON.stringify({
    schema: '2.0',
    config: { update_multi: true },
    body: { elements: [{ tag: 'markdown', content: markdown }] },
  });
}

/**
 * Serialize one authored body into the message contents to send, in order. The
 * whole body is tried first: a body that fits is one message no matter how
 * many Markdown blocks it holds.
 */
export function cardContents(
  body: string,
  messageType: FeishuTextMessageType = 'interactive',
): string[] {
  const whole = messageContent(body, messageType);
  if (Buffer.byteLength(whole, 'utf8') <= FEISHU_MESSAGE_CONTENT_SAFE_BYTES) {
    return [whole];
  }
  const budget =
    FEISHU_MESSAGE_CONTENT_SAFE_BYTES -
    Buffer.byteLength(messageContent('', messageType), 'utf8');
  return splitMarkdownBody(body, budget).map((piece) => {
    const content = messageContent(piece, messageType);
    assertMessageContentFits(content);
    return content;
  });
}

export function assertMessageContentFits(content: string): void {
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > FEISHU_MESSAGE_CONTENT_SAFE_BYTES) {
    throw new Error(contentTooLarge(bytes));
  }
}

function contentTooLarge(bytes: number): string {
  return (
    `Feishu message content is ${bytes} bytes, over the ` +
    `${FEISHU_MESSAGE_CONTENT_SAFE_BYTES}-byte budget for one message.`
  );
}

/** What one Markdown fragment would cost as a selected envelope `content`. */
function contentBytes(markdown: string, budget: number): number {
  return escapedBytes(markdown) + FEISHU_MESSAGE_CONTENT_SAFE_BYTES - budget;
}

/**
 * Split an oversized body into pieces that each fit `budget` escaped bytes.
 *
 * Blocks are the unit: `marked`'s block tokens tile the source through their
 * `raw` fields, so packing whole blocks reproduces the authored text exactly
 * while keeping block boundaries wherever they fit. Only a block that is
 * itself oversized is opened up, and then along the seams that keep it
 * readable — fence lines, table rows, ordinary lines, grapheme clusters.
 */
function splitMarkdownBody(body: string, budget: number): string[] {
  const pieces: string[] = [];
  let current = '';
  let bytes = 0;
  for (const block of marked.lexer(body)) {
    const raw = block.raw;
    if (raw === '') continue;
    const rawBytes = escapedBytes(raw);
    if (bytes + rawBytes <= budget) {
      current += raw;
      bytes += rawBytes;
      continue;
    }
    if (current !== '') {
      pieces.push(current);
      current = '';
      bytes = 0;
    }
    if (rawBytes <= budget) {
      current = raw;
      bytes = rawBytes;
      continue;
    }
    for (const piece of splitBlock(block, budget)) pieces.push(piece);
  }
  if (current !== '') pieces.push(current);
  // The blank lines between two blocks are a separator, not content. When a
  // run of them lands in a piece of its own — a body ending in an oversized
  // code block and a trailing blank line does exactly that — there is nothing
  // to send.
  return pieces.filter((piece) => piece.trim() !== '');
}

function splitBlock(block: Token, budget: number): string[] {
  if (block.type === 'code') return splitFencedCode(block.raw, budget);
  if (block.type === 'table') return splitTableRows(block.raw, budget);
  return packSegments(lineSegments(block.raw), budget);
}

/**
 * Split a fenced code block by line, repeating its opening (with language) and
 * closing fence on every piece, so each piece is a well-formed fenced block.
 */
function splitFencedCode(raw: string, budget: number): string[] {
  const lines = lineSegments(raw);
  const open = lines[0];
  const close = lines.at(-1);
  if (
    lines.length < 3 ||
    open === undefined ||
    close === undefined ||
    !/^ {0,3}[`~]{3,}/.test(open) ||
    !/^ {0,3}[`~]{3,}[ \t]*\r?\n?$/.test(close)
  ) {
    return packSegments(lines, budget);
  }
  // Every piece pays for both fence lines, and for the newline that puts the
  // closing fence on its own line when a split lands mid-line.
  const frame = `${open}\n${close}`;
  const inner = budget - escapedBytes(frame);
  if (inner <= 0) {
    throw new Error(contentTooLarge(contentBytes(frame, budget)));
  }
  return packSegments(lines.slice(1, -1), inner).map(
    (piece) => `${open}${piece.endsWith('\n') ? piece : `${piece}\n`}${close}`,
  );
}

/**
 * Split a table by whole data rows, repeating its header and delimiter rows so
 * every piece still reads as a table. The header is taken as the block's first
 * two source lines rather than re-parsed, so optional outer pipes and
 * alignment markers survive exactly as authored.
 */
function splitTableRows(raw: string, budget: number): string[] {
  const header = /^(?:[^\r\n]*\r?\n){2}/.exec(raw)?.[0];
  if (header === undefined) return packSegments(lineSegments(raw), budget);
  const rowBudget = budget - escapedBytes(header);
  const rows = lineSegments(raw.slice(header.length));
  const oversized =
    rowBudget <= 0 ? '' : rows.find((row) => escapedBytes(row) > rowBudget);
  if (oversized !== undefined) {
    throw new Error(
      `${contentTooLarge(contentBytes(`${header}${oversized}`, budget))} A table ` +
        'header plus a single data row already exceeds it, so the table ' +
        'cannot be split by row. Shorten the row, or send the data as a ' +
        'fenced code block.',
    );
  }
  return packSegments(rows, rowBudget).map((piece) => `${header}${piece}`);
}

/** Pack source segments into pieces that each fit `budget` escaped bytes. */
function packSegments(segments: string[], budget: number): string[] {
  const pieces: string[] = [];
  let current = '';
  let bytes = 0;
  for (const segment of segments) {
    const segmentBytes = escapedBytes(segment);
    if (bytes + segmentBytes <= budget) {
      current += segment;
      bytes += segmentBytes;
      continue;
    }
    if (current !== '') {
      pieces.push(current);
      current = '';
      bytes = 0;
    }
    if (segmentBytes <= budget) {
      current = segment;
      bytes = segmentBytes;
      continue;
    }
    for (const sub of splitByGraphemeBytes(segment, budget)) pieces.push(sub);
  }
  if (current !== '') pieces.push(current);
  return pieces;
}

/** Split one oversized line at grapheme boundaries, never mid-cluster. */
function splitByGraphemeBytes(text: string, budget: number): string[] {
  const segmenter = new Intl.Segmenter('und', { granularity: 'grapheme' });
  const pieces: string[] = [];
  let current = '';
  let bytes = 0;
  for (const { segment } of segmenter.segment(text)) {
    const segmentBytes = escapedBytes(segment);
    if (bytes + segmentBytes > budget) {
      if (current !== '') pieces.push(current);
      current = segment;
      bytes = segmentBytes;
      continue;
    }
    current += segment;
    bytes += segmentBytes;
  }
  if (current !== '') pieces.push(current);
  return pieces;
}

/** Cut a string into lines, each keeping its own newline. */
function lineSegments(text: string): string[] {
  const segments: string[] = [];
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== '\n') continue;
    segments.push(text.slice(start, index + 1));
    start = index + 1;
  }
  if (start < text.length) segments.push(text.slice(start));
  return segments;
}

/**
 * The bytes a string costs inside the serialized `content`: its JSON encoding
 * without the surrounding quotes. A raw UTF-8 count would under-measure every
 * quote, backslash, and newline the platform actually receives escaped.
 */
function escapedBytes(text: string): number {
  return Buffer.byteLength(JSON.stringify(text), 'utf8') - 2;
}

/** One actual Markdown image and the source range of its destination. */
export interface LocalMarkdownImage {
  readonly path: string;
  readonly start: number;
  readonly end: number;
  readonly prefix: string;
  readonly suffix: string;
}

/** Find local image nodes, consuming sibling raw tokens so code stays opaque. */
export function localMarkdownImages(body: string): LocalMarkdownImage[] {
  // marked normalizes CRLF. Project its offsets back into the authored source;
  // only destination slices are replaced, so even short CRLF bodies stay intact.
  const source = body.replace(/\r\n?/g, '\n');
  const offsets: number[] = [];
  for (let i = 0; i < body.length; i += 1) {
    offsets.push(i);
    if (body[i] === '\r' && body[i + 1] === '\n') i += 1;
  }
  offsets.push(body.length);
  const images: LocalMarkdownImage[] = [];
  function visit(tokens: Token[], start: number, end: number): void {
    let cursor = start;
    for (const token of tokens) {
      const location = locateTokenSource(source, token.raw, cursor, end);
      const located = location !== undefined;
      const from = location?.[0] ?? cursor;
      const to = location?.at(-1) ?? end;
      if (token.type === 'image') {
        if (isAbsolute(token.href) && !token.href.startsWith('//')) {
          if (!located)
            throw new Error(
              `Cannot locate Markdown image source: ${token.href}`,
            );
          const destination = imageDestination(token.raw, token.title);
          images.push({
            path: token.href,
            start: offsets[location![destination.start]!]!,
            end: offsets[location![destination.end]!]!,
            prefix: destination.prefix,
            suffix: destination.suffix,
          });
        }
      } else if (token.type === 'table') {
        const table = token as Tokens.Table;
        visit(
          [
            ...table.header.flatMap((cell) => cell.tokens),
            ...table.rows.flatMap((row) => row.flatMap((cell) => cell.tokens)),
          ],
          from,
          to,
        );
      } else if (token.type === 'list') {
        visit(token.items, from, to);
      } else if ('tokens' in token && Array.isArray(token.tokens)) {
        visit(token.tokens, from, to);
      }
      if (located) cursor = to;
    }
  }
  visit(marked.lexer(source), 0, source.length);
  return images;
}

/** Locate the inline destination within an image token, respecting escapes. */
function imageDestination(
  raw: string,
  title: string | null,
): { start: number; end: number; prefix: string; suffix: string } {
  let depth = 1;
  let i = 2;
  for (; i < raw.length; i += 1) {
    if (raw[i] === '\\') {
      i += 1;
      continue;
    }
    if (raw[i] === '[') depth += 1;
    if (raw[i] === ']' && --depth === 0) break;
  }
  i += 1;
  if (raw[i] !== '(') {
    return {
      start: i,
      end: raw.length,
      prefix: '(',
      suffix: `${title === null ? '' : ` "${title.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`})`,
    };
  }
  i += 1;
  while (/\s/.test(raw[i] ?? '') && i < raw.length) i += 1;
  const angle = raw[i] === '<';
  if (angle) i += 1;
  const start = i;
  depth = 0;
  for (; i < raw.length; i += 1) {
    if (raw[i] === '\\') {
      i += 1;
      continue;
    }
    if (
      angle
        ? raw[i] === '>'
        : depth === 0 && (raw[i] === ')' || /\s/.test(raw[i]!))
    )
      break;
    if (raw[i] === '(') depth += 1;
    if (raw[i] === ')') depth -= 1;
  }
  return { start, end: i, prefix: '', suffix: '' };
}

/** Rewrite only the selected image destinations, retaining all other source. */
export function replaceLocalMarkdownImages(
  body: string,
  images: readonly LocalMarkdownImage[],
  keys: readonly string[],
): string {
  let rewritten = body;
  for (let i = images.length - 1; i >= 0; i -= 1) {
    const image = images[i]!;
    rewritten =
      rewritten.slice(0, image.start) +
      image.prefix +
      keys[i]! +
      image.suffix +
      rewritten.slice(image.end);
  }
  return rewritten;
}

/** Match a child raw token through the prefixes/escapes its parent removed. */
function locateTokenSource(
  source: string,
  raw: string,
  start: number,
  end: number,
): number[] | undefined {
  if (raw === '') return [start];
  let candidate = source.indexOf(raw[0]!, start);
  while (candidate !== -1 && candidate < end) {
    const positions: number[] = [];
    let cursor = candidate;
    let index = 0;
    for (; index < raw.length && cursor < end; index += 1) {
      if (index > 0 && raw[index - 1] === '\n') {
        // Match the complete next raw line, including retained code indent.
        // Only quote/list prefixes may stand between it and the source line.
        const rawBreak = raw.indexOf('\n', index);
        const rawLine = raw.slice(
          index,
          rawBreak === -1 ? raw.length : rawBreak,
        );
        const sourceBreak = source.indexOf('\n', cursor);
        const lineEnd = sourceBreak === -1 ? end : Math.min(sourceBreak, end);
        const lineStart =
          rawLine === ''
            ? lineEnd
            : locateTokenSource(source, rawLine, cursor, lineEnd)?.[0];
        if (
          lineStart !== undefined &&
          /^[> \t]*$/.test(source.slice(cursor, lineStart))
        )
          cursor = lineStart;
      }
      if (
        source[cursor] === '\\' &&
        source[cursor + 1] === '|' &&
        raw[index] === '|'
      )
        cursor += 1;
      if (source[cursor] !== raw[index]) break;
      positions.push(cursor);
      cursor += 1;
    }
    if (index === raw.length) {
      positions.push(cursor);
      return positions;
    }
    candidate = source.indexOf(raw[0]!, candidate + 1);
  }
  return undefined;
}
