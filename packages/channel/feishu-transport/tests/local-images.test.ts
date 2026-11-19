import { describe, expect, it } from 'vitest';
import {
  localMarkdownImages,
  replaceLocalMarkdownImages,
} from '../src/transport/message-content.js';

function rewrite(body: string) {
  const images = localMarkdownImages(body);
  return {
    paths: images.map((image) => image.path),
    text: replaceLocalMarkdownImages(
      body,
      images,
      images.map((_image, i) => `img_${i}`),
    ),
  };
}

describe('actual local Markdown image sources', () => {
  it('keeps code, ordinary links, remote images, keys and protocol-relative URLs intact', () => {
    const examples =
      '`![alt](/a.png)`\n\n```md\n![alt](/a.png)\n```\n\n    ![alt](/a.png)\n\n[link](/a.png) ![web](https://example.test/a.png) ![key](img_key) ![cdn](//example.test/a.png) ![relative](images/a.png) ![drive-relative](C:a.png) ![url](file:///a.png)';
    expect(rewrite(`${examples}\n\n![alt](/a.png "title")`)).toEqual({
      paths: ['/a.png'],
      text: `${examples}\n\n![alt](img_0 "title")`,
    });
  });
  it.each([
    'C:/images/shot.png',
    String.raw`C:\images\shot.png`,
    String.raw`C:\images with spaces\shot (1).png`,
    String.raw`\\server\share\shot.png`,
  ])(
    'recognizes native Windows image paths without changing surrounding source: %s',
    (path) => {
      // Markdown escapes are decoded by marked before filesystem classification.
      const destination = path.replaceAll('\\', '\\\\');
      const body = `before\r\n![alt](<${destination}> "title")\r\nafter`;
      expect(rewrite(body)).toEqual(
        process.platform === 'win32'
          ? {
              paths: [path],
              text: 'before\r\n![alt](<img_0> "title")\r\nafter',
            }
          : { paths: [], text: body },
      );
    },
  );
  it('preserves nested links, alt/title text, escaped parentheses and CRLF', () => {
    const body =
      "[**![a [b]](</a b.png> 'title')**](https://example.test)\r\n![x](/a\\(b\\).png)\r\n";
    expect(rewrite(body)).toEqual({
      paths: ['/a b.png', '/a(b).png'],
      text: "[**![a [b]](<img_0> 'title')**](https://example.test)\r\n![x](img_1)\r\n",
    });
  });
  it('rewrites repeated images in quote/list/table without touching their code examples', () => {
    const body =
      '> ```md\n> ![a](/a.png)\n> ```\n>\n> ![a](/a.png)\n\n- `![a](/a.png)` **![a](/a.png)**\n\n| col |\n| --- |\n| `![a](/a.png)` ![a\\|b](</a b.png> "t") |\n';
    expect(rewrite(body)).toEqual({
      paths: ['/a.png', '/a.png', '/a b.png'],
      text: '> ```md\n> ![a](/a.png)\n> ```\n>\n> ![a](img_0)\n\n- `![a](/a.png)` **![a](img_1)**\n\n| col |\n| --- |\n| `![a](/a.png)` ![a\\|b](<img_2> "t") |\n',
    });
  });
  it('rewrites a reference image without changing a link using the same definition', () => {
    expect(
      rewrite('![alt][ref] [link][ref]\n\n[ref]: /a.png "title"\n'),
    ).toEqual({
      paths: ['/a.png'],
      text: '![alt](img_0 "title") [link][ref]\n\n[ref]: /a.png "title"\n',
    });
  });
});

it.each([
  [
    '>     ![a](/a.png)\n>     ![b](/b.png)\n>\n> ![a](/a.png)\n',
    '>     ![a](/a.png)\n>     ![b](/b.png)\n>\n> ![a](img_0)\n',
  ],
  [
    '- item\n\n      ![a](/a.png)\n      ![b](/b.png)\n\n  ![a](/a.png)\n',
    '- item\n\n      ![a](/a.png)\n      ![b](/b.png)\n\n  ![a](img_0)\n',
  ],
  [
    '>     ![a][ref]\n>     x\n>\n> ![a][ref]\n\n[ref]: /a.png\n',
    '>     ![a][ref]\n>     x\n>\n> ![a](img_0)\n\n[ref]: /a.png\n',
  ],
])(
  'keeps multiline indented code opaque before a repeated real image',
  (body, expected) => {
    expect(rewrite(body)).toEqual({ paths: ['/a.png'], text: expected });
    expect(rewrite(body.replace(/\n/g, '\r\n'))).toEqual({
      paths: ['/a.png'],
      text: expected.replace(/\n/g, '\r\n'),
    });
  },
);
