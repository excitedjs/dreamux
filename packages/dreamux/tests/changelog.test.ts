import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readPackagedChangelog } from '../src/cli/changelog.js';
import {
  packagedChangelogJsonPath,
  packagedChangelogMarkdownPath,
} from '../src/platform/paths.js';

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('dreamux changelog', () => {
  it('resolves the packaged changelog paths to the package root', () => {
    expect(packagedChangelogMarkdownPath()).toBe(
      join(PACKAGE_ROOT, 'CHANGELOG.md'),
    );
    expect(packagedChangelogJsonPath()).toBe(
      join(PACKAGE_ROOT, 'CHANGELOG.json'),
    );
  });

  it('prints the markdown changelog by default', async () => {
    const text = await readPackagedChangelog();
    expect(text).toContain('# Change Log - @excitedjs/dreamux');
  });

  it('prints the raw JSON changelog with --json', async () => {
    const text = await readPackagedChangelog({ json: true });
    const parsed = JSON.parse(text) as { name: string; entries: unknown[] };
    expect(parsed.name).toBe('@excitedjs/dreamux');
    expect(Array.isArray(parsed.entries)).toBe(true);
  });

  // Packaging guard: `dreamux changelog` reads files shipped in the published
  // tarball. If either changelog is dropped from `package.json` `files`, the
  // command reads nothing after install. This test fails loud on that
  // regression so the publish shape stays correct.
  it('ships both changelog files in package.json files', async () => {
    const pkg = JSON.parse(
      await readFile(join(PACKAGE_ROOT, 'package.json'), 'utf8'),
    ) as { files: string[] };
    expect(pkg.files).toContain('CHANGELOG.md');
    expect(pkg.files).toContain('CHANGELOG.json');
  });
});
