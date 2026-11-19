import {
  mkdtemp,
  mkdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openActivityFile } from '../src/index.js';

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs/promises')>()),
}));

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
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
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

  it('refuses a leaf symlink without following it', async (context) => {
    const path = join(root, 'native');
    await writeFile(path, 'native activity');
    const link = join(root, 'link');
    try {
      await symlink(path, link);
    } catch (error) {
      if (
        process.platform === 'win32' &&
        (error as NodeJS.ErrnoException).code === 'EPERM'
      ) {
        context.skip(); // Windows file symlinks require Developer Mode or SeCreateSymbolicLinkPrivilege.
        return;
      }
      throw error;
    }
    await expect(
      openActivityFile(link, [root], messages),
    ).rejects.toMatchObject({
      detail: 'locator_outside_root',
      message: messages.outsideRoot,
      ...(process.platform === 'win32' ? {} : { cause: { code: 'ELOOP' } }),
    });
  });

  it('refuses a leaf directory link before attempting to open its target', async () => {
    vi.stubGlobal('process', { ...process, platform: 'win32' });
    const target = join(root, 'target');
    await mkdir(target);
    const link = join(root, 'link');
    await symlink(target, link, 'junction');
    const opening = vi.spyOn(fs, 'open');
    await expect(
      openActivityFile(link, [root], messages),
    ).rejects.toMatchObject({
      detail: 'locator_outside_root',
      message: messages.outsideRoot,
    });
    expect(opening).not.toHaveBeenCalled();
  });

  it.each([
    { opening: 1, phase: 'before' },
    { opening: 1, phase: 'after' },
    { opening: 2, phase: 'before' },
    { opening: 2, phase: 'after' },
  ])(
    'rejects a file replaced $phase open $opening and closes held handles',
    async ({ opening, phase }) => {
      vi.stubGlobal('process', { ...process, platform: 'win32' });
      const path = join(root, 'native');
      await writeFile(path, 'original activity');
      const handles: fs.FileHandle[] = [];
      const originalOpen = fs.open;
      let calls = 0;
      const replace = async () => {
        await fs.rename(path, join(root, 'previous'));
        await writeFile(path, 'replacement activity');
      };
      vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
        calls += 1;
        const replacing = calls === opening;
        if (replacing && phase === 'before') await replace();
        const handle = await originalOpen(...args);
        handles.push(handle);
        if (replacing && phase === 'after') await replace();
        return handle;
      });
      await expect(
        openActivityFile(path, [root], messages),
      ).rejects.toMatchObject({
        detail: 'unreadable',
        message: messages.changedWhileOpening,
      });
      expect(handles).toHaveLength(opening);
      for (const handle of handles) {
        await expect(handle.stat()).rejects.toMatchObject({ code: 'EBADF' });
      }
    },
  );

  it('rejects a leaf replaced by a directory link during open and closes its handle', async () => {
    vi.stubGlobal('process', { ...process, platform: 'win32' });
    const path = join(root, 'native');
    const target = join(root, 'target');
    await writeFile(path, 'original activity');
    await mkdir(target);
    const originalOpen = fs.open;
    let held: fs.FileHandle | undefined;
    vi.spyOn(fs, 'open').mockImplementationOnce(async (...args) => {
      held = await originalOpen(...args);
      await fs.rename(path, join(root, 'previous'));
      await symlink(target, path, 'junction');
      return held;
    });
    await expect(
      openActivityFile(path, [root], messages),
    ).rejects.toMatchObject({
      detail: 'locator_outside_root',
      message: messages.outsideRoot,
    });
    expect(held).toBeDefined();
    await expect(held!.stat()).rejects.toMatchObject({ code: 'EBADF' });
  });

  it('refuses an intermediate directory symlink that escapes the allowed root', async () => {
    const allowed = join(root, 'allowed'),
      outside = join(root, 'outside');
    await mkdir(allowed);
    await mkdir(outside);
    await writeFile(join(outside, 'native'), 'native activity');
    await symlink(
      outside,
      join(allowed, 'alias'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await expect(
      openActivityFile(join(allowed, 'alias', 'native'), [allowed], messages),
    ).rejects.toMatchObject({
      detail: 'locator_outside_root',
      message: messages.outsideRoot,
    });
  });
});
