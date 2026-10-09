import {
  mkdtemp,
  mkdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openActivityFile } from '../src/index.js';

const messages = {
  notFound: 'native activity missing',
  outsideRoot: 'native activity outside root',
  notRegularFile: 'native activity not a file',
  changedWhileOpening: 'native activity changed',
  unreadable: 'native activity unreadable',
};
let root: string;
beforeEach(async () => {
  root = await realpath(
    await mkdtemp(join(tmpdir(), 'dreamux-activity-open-')),
  );
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('openActivityFile', () => {
  it('returns the held readable file and identity from any allowed canonical root', async () => {
    const first = join(root, 'sessions'),
      second = join(root, 'archive');
    await mkdir(first);
    await mkdir(second);
    const path = join(second, 'activity.jsonl');
    await writeFile(path, 'native activity\n');
    const identity = await stat(path);
    const opened = await openActivityFile(path, [first, second], messages);
    try {
      expect(opened).toMatchObject({
        path,
        size: identity.size,
        dev: identity.dev,
        ino: identity.ino,
      });
      expect(await opened.handle.readFile('utf8')).toBe('native activity\n');
    } finally {
      await opened.handle.close();
    }
  });

  it('classifies an absent file with its provider-owned message and cause', async () => {
    await expect(
      openActivityFile(join(root, 'missing'), [root], messages),
    ).rejects.toMatchObject({
      detail: 'not_found',
      message: messages.notFound,
      cause: { code: 'ENOENT' },
    });
  });

  it('refuses a directory as an invalid source', async () => {
    await expect(
      openActivityFile(root, [root], messages),
    ).rejects.toMatchObject({
      detail: 'invalid',
      message: messages.notRegularFile,
    });
  });

  it('refuses a leaf symlink without following it', async () => {
    const path = join(root, 'native');
    await writeFile(path, 'native activity');
    const link = join(root, 'link');
    await symlink(path, link);
    await expect(
      openActivityFile(link, [root], messages),
    ).rejects.toMatchObject({
      detail: 'locator_outside_root',
      message: messages.outsideRoot,
      cause: { code: 'ELOOP' },
    });
  });

  it('refuses an intermediate directory symlink that escapes the allowed root', async () => {
    const allowed = join(root, 'allowed'),
      outside = join(root, 'outside');
    await mkdir(allowed);
    await mkdir(outside);
    await writeFile(join(outside, 'native'), 'native activity');
    await symlink(outside, join(allowed, 'alias'), 'dir');
    await expect(
      openActivityFile(join(allowed, 'alias', 'native'), [allowed], messages),
    ).rejects.toMatchObject({
      detail: 'locator_outside_root',
      message: messages.outsideRoot,
    });
  });
});
