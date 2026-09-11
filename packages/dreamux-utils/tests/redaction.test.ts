/**
 * The redaction capability's own tests: `redactText` called directly, with no
 * projection, no Channel, and no event harness around it.
 *
 * What is asserted here is the rule set — secret shapes destroyed, host paths
 * renamed to the form the operator's own shell prints, and a path that merely
 * resembles this host's home left entirely alone. How a conversation event uses
 * the rules is `dreamux`'s `tests/cot-projection-privacy.test.ts`; that file
 * keeps every projection-level assertion and none of these.
 */
import { describe, expect, it } from 'vitest';

import { redactJson, redactText } from '../src/redaction.js';

const CWD = '/workspace/repo';

describe('redactText: secret shapes and host paths', () => {
  it('stops a bare secret at the quote and bracket that close its JSON string', () => {
    const envelope = JSON.stringify({
      content: [{ type: 'text', text: 'token: xyz' }],
      structuredContent: { ok: true },
    });
    const { value } = redactText(envelope, '/workspace/repo', ['/home/me']);
    expect(JSON.parse(value)).toEqual({
      content: [{ type: 'text', text: 'token: <redacted>' }],
      structuredContent: { ok: true },
    });
  });

  it('renders the bare workspace itself as a dot', () => {
    expect(redactText(`ran in ${CWD} today`, CWD, []).value).toBe('ran in . today');
  });

  it('renames this host home to ~, keeping the rest of the path legible', () => {
    expect(redactText('key at /home/me/.ssh/id_rsa now', '', ['/home/me']).value)
      .toBe('key at ~/.ssh/id_rsa now');
  });

  it('renames a Windows home the same way', () => {
    const home = 'C:\\Users\\me';
    expect(redactText(`backup at ${home}\\notes.txt now`, '', [home]).value)
      .toBe('backup at ~\\notes.txt now');
  });

  it('renames the bare home with no path after it', () => {
    expect(redactText('cd /home/me and stop', '', ['/home/me']).value)
      .toBe('cd ~ and stop');
  });

  it('renames a home prefix at the head of a file URL', () => {
    expect(redactText('open file:///home/me/x', '', ['/home/me']).value)
      .toBe('open file://~/x');
  });

  it('renames a bare home before ordinary closing punctuation', () => {
    const value =
      'paths /home/me. /home/me, /home/me; /home/me: (/home/me) [/home/me] "/home/me"';
    expect(redactText(value, '', ['/home/me']).value).toBe(
      'paths ~. ~, ~; ~: (~) [~] "~"',
    );
  });

  it('treats a trailing period as prose punctuation for home and workspace paths', () => {
    const home = '/home/me';
    const cwd = `${home}/work/repo`;
    expect(
      redactText(`see ${home}. edit ${cwd}/a.ts.`, cwd, [home]).value,
    ).toBe('see ~. edit a.ts.');
  });

  it('distinguishes dot-suffixed home siblings from workspace-adjacent siblings', () => {
    const home = '/home/me';
    const cwd = `${home}/work/repo`;
    const value = [
      `${home}.bak/notes.md`,
      `${home}.git/config`,
      `${cwd}.bak/notes.md`,
      `${cwd}.git/config`,
    ].join(' ');
    expect(redactText(value, cwd, [home]).value).toBe([
      `${home}.bak/notes.md`,
      `${home}.git/config`,
      '~/work/repo.bak/notes.md',
      '~/work/repo.git/config',
    ].join(' '));
  });

  it('renames workspace-adjacent siblings through the containing home prefix', () => {
    const home = '/home/me';
    const cwd = `${home}/work/repo`;
    expect(
      redactText(`${cwd}.git/config ${cwd}-old/x`, cwd, [home]).value,
    ).toBe('~/work/repo.git/config ~/work/repo-old/x');
  });

  it('does not treat a doubled filesystem separator as a URL scheme boundary', () => {
    const home = '/home/me';
    const cwd = `${home}/work/repo`;
    const value = `/mnt/backup/${home}/x /mnt/backup/${cwd}/x`;
    expect(redactText(value, cwd, [home]).value).toBe(value);
  });

  it('leaves a path that merely starts with the same characters alone', () => {
    const value =
      'compare /home/mexyz and /home/me-old/notes.txt with /home/meredith/notes.txt';
    expect(redactText(value, '', ['/home/me']).value).toBe(value);
  });

  it('leaves a home-shaped fragment that is not rooted alone', () => {
    const value = 'the string not/home/me/x is not a path here';
    expect(redactText(value, '', ['/home/me']).value).toBe(value);
  });

  it('does not treat a foreign home-shaped path as this host home', () => {
    const value = 'their build ran in /home/someoneelse/repo';
    expect(redactText(value, '', ['/home/me']).value).toBe(value);
  });

  it('prefers the longest matching home prefix', () => {
    expect(
      redactText('at /home/me/nested/file.ts', '', ['/home/me/nested', '/home/me']).value,
    ).toBe('at ~/file.ts');
  });

  it('relativizes the workspace before renaming the home it sits under', () => {
    const home = '/home/me';
    const cwd = `${home}/work/repo`;
    expect(
      redactText(`edited ${cwd}/src/a.ts and ${home}/.config/x`, cwd, [home]).value,
    ).toBe('edited src/a.ts and ~/.config/x');
  });

  it('keeps workspace renaming when no host home prefix was resolved', () => {
    const cwd = '/workspace/repo';
    expect(
      redactText(`work in ${cwd}; leave /home/me/x alone`, cwd, []).value,
    ).toBe('work in .; leave /home/me/x alone');
  });

  it('reports redacted:false when a path rule found nothing to rename', () => {
    expect(redactText('nothing to rename here', '/workspace/repo', ['/home/me']).redacted)
      .toBe(false);
  });
});

describe('redactJson: structure walked, not serialization read', () => {
  const walk = (value: Parameters<typeof redactJson>[0]) => redactJson(value, CWD, ['/home/me']);

  it('redacts a nested JSON object that text redaction cannot see', () => {
    // Serialized, this argument reads `{\"client_secret\":\"shh\"}` — the key
    // no longer sits beside its separator, so no text pattern finds it. The
    // walk hands the leaf over as ordinary text instead.
    const nested = '{"client_secret":"shhSECRET","api_key":"kSECRET"}';
    const { value, redacted } = walk({ content: nested });
    expect(value).toEqual({
      content: '{"client_secret":"<redacted>","api_key":"<redacted>"}',
    });
    expect(redacted).toBe(true);
  });

  it('redacts a nested value that contains an escaped quote', () => {
    const { value } = walk({ content: 'TOKEN="ab\\"cdSECRET"' });
    expect(value).toEqual({ content: 'TOKEN="<redacted>"' });
  });

  it('redacts every line of a multi-line .env, and no line takes the next with it', () => {
    const content = 'NODE_ENV="production"\nTOKEN="t1"\nPORT=3000\nAPI_KEY=k2\nDEBUG=false';
    const { value } = walk({ file_path: '.env', content });
    expect(value).toEqual({
      file_path: '.env',
      content: 'NODE_ENV="production"\nTOKEN="<redacted>"\nPORT=3000\nAPI_KEY=<redacted>\nDEBUG=false',
    });
  });

  it('covers a value whose own text contains a backslash, tail included', () => {
    const { value } = walk({ command: 'password=C:\\keys\\id and then continue' });
    expect(value).toEqual({ command: 'password=<redacted> and then continue' });
  });

  it('answers a secret-named field by its name, whatever the value looks like', () => {
    // Nothing here is secret-*shaped*: a short low-entropy word, a number, a
    // nested object. The key is the whole reason each is destroyed.
    const { value, redacted } = walk({
      api_key: 'x',
      credential: 42,
      nested: { client_secret: { region: 'eu' } },
      port: 8080,
    });
    expect(value).toEqual({
      api_key: '<redacted>',
      credential: '<redacted>',
      nested: { client_secret: '<redacted>' },
      port: 8080,
    });
    expect(redacted).toBe(true);
  });

  it('walks into arrays', () => {
    const { value } = walk([{ token: 'a' }, 'plain', { note: 'password=p1' }]);
    expect(value).toEqual([{ token: '<redacted>' }, 'plain', { note: 'password=<redacted>' }]);
  });

  it('renames host paths in a string leaf the way redactText does', () => {
    const { value } = walk({ file: `${CWD}/src/a.ts`, home: '/home/me/keys' });
    expect(value).toEqual({ file: 'src/a.ts', home: '~/keys' });
  });

  it('leaves a payload with nothing secret- or path-shaped exactly as it came', () => {
    const input = { id: 7, ok: true, name: 'build', tags: ['a', 'b'], deep: { n: null } };
    const { value, redacted } = walk(input);
    expect(value).toEqual(input);
    expect(redacted).toBe(false);
  });

  it('keeps a member named __proto__, which is ordinary data off the wire', () => {
    // A Provider's events arrive as JSON text, and `JSON.parse` builds a
    // `__proto__` key as an own data property rather than touching any
    // prototype. So it reaches here as a plain member, and the result must
    // still carry it — writing it back with a plain assignment would not.
    const fromWire = JSON.parse('{"__proto__":"keep-me","a":1,"token":"t"}') as
      Parameters<typeof redactJson>[0];
    const { value } = walk(fromWire);
    expect(JSON.stringify(value)).toBe('{"__proto__":"keep-me","a":1,"token":"<redacted>"}');
    expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
  });

  it('keeps an object-valued __proto__ member as a member, not as a prototype', () => {
    const fromWire = JSON.parse('{"__proto__":{"nested":"keep"}}') as
      Parameters<typeof redactJson>[0];
    const { value } = walk(fromWire);
    expect(JSON.stringify(value)).toBe('{"__proto__":{"nested":"keep"}}');
    expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
  });

  it('carries a null payload through as null', () => {
    expect(walk(null)).toEqual({ value: null, redacted: false });
  });

  it('redacts a bare string payload, since a string is a JSON value too', () => {
    const { value, redacted } = walk('failed with token: dummy');
    expect(value).toBe('failed with token: <redacted>');
    expect(redacted).toBe(true);
  });

  it('leaves a redacted payload serializable as valid JSON', () => {
    const { value } = walk({ content: 'TOKEN="abc"', other: 'password=abc\\' });
    expect(() => JSON.parse(JSON.stringify(value))).not.toThrow();
  });
});

