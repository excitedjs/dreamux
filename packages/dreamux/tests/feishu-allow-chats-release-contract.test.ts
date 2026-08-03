import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const marker = 'before deploying, inspect every existing non-empty group.allow_chats';

interface ChangeDeclaration {
  changes: Array<{ packageName: string; comment: string; type: string }>;
  packageName: string;
}

function pendingChange(relativePath: string): ChangeDeclaration | null {
  const path = join(repoRoot, relativePath);
  return existsSync(path)
    ? JSON.parse(readFileSync(path, 'utf8')) as ChangeDeclaration
    : null;
}

function publishedChange(
  relativePath: string,
  packageName: string,
): ChangeDeclaration['changes'][number] | null {
  const raw = JSON.parse(readFileSync(join(repoRoot, relativePath), 'utf8')) as {
    entries: Array<{ comments: Record<string, Array<{ comment: string }>> }>;
  };
  for (const entry of raw.entries) {
    for (const [type, comments] of Object.entries(entry.comments)) {
      const match = comments.find((candidate) => candidate.comment.includes(marker));
      if (match !== undefined) return { packageName, type, comment: match.comment };
    }
  }
  return null;
}

function currentOrPublishedChange(input: {
  pending: string;
  changelog: string;
  packageName: string;
}): ChangeDeclaration['changes'][number] {
  const pending = pendingChange(input.pending);
  const change = pending?.changes[0] ?? publishedChange(input.changelog, input.packageName);
  expect(change, `${input.packageName} trusted-chat change declaration`).not.toBeNull();
  return change!;
}

describe('trusted allow_chats release contract', () => {
  it.each([
    {
      packageName: '@excitedjs/feishu-channel',
      type: 'major',
      pending: 'common/changes/@excitedjs/feishu-channel/feishu-trusted-allow-chats_2026-07-31-15-22.json',
      changelog: 'packages/channel/feishu-channel/CHANGELOG.json',
    },
    {
      packageName: '@excitedjs/dreamux',
      type: 'minor',
      pending: 'common/changes/@excitedjs/dreamux/feishu-trusted-allow-chats_2026-07-31-15-22.json',
      changelog: 'packages/dreamux/CHANGELOG.json',
    },
  ])('$packageName declares the required breaking release note', (input) => {
    const change = currentOrPublishedChange(input);
    expect(change.packageName).toBe(input.packageName);
    expect(change.type).toBe(input.type);
    expect(change.comment).toMatch(/^BREAKING: Review:/);
    expect(change.comment).toContain('group.policy=allowlist');
    expect(change.comment).toContain('group.policy=follow-user');
    expect(change.comment).toContain('Previously, follow-user ignored allow_chats');
    expect(change.comment).toContain('allowlist still applied dm_policy and allow_users');
    expect(change.comment).toContain('access.json remains V3 and needs no rebuild');
    expect(change.comment).not.toContain('Rebuild:');
  });

  it('declares the Codex comment correction as type none while pending', () => {
    const change = pendingChange(
      'common/changes/@excitedjs/agent-runtime-codex/feishu-trusted-allow-chats_2026-07-31-15-22.json',
    );
    if (change === null) {
      const source = readFileSync(
        join(repoRoot, 'packages/agent-runtime/codex/src/config.ts'),
        'utf8',
      );
      expect(source).toMatch(/turn_timeout_ms[\s\S]{0,180}does not consume it/);
      return;
    }
    expect(change.packageName).toBe('@excitedjs/agent-runtime-codex');
    expect(change.changes).toEqual([
      expect.objectContaining({
        packageName: '@excitedjs/agent-runtime-codex',
        type: 'none',
      }),
    ]);
    expect(change.changes[0]?.comment).toMatch(/Documentation-only/);
    expect(change.changes[0]?.comment).toMatch(/no package behavior or version change/);
  });

  it('publishes both old-to-new authorization expansions and the V3 review warning', () => {
    const feishuReadme = readFileSync(
      join(repoRoot, 'packages/channel/feishu-channel/README.md'),
      'utf8',
    );
    const dreamuxReadme = readFileSync(join(repoRoot, 'packages/dreamux/README.md'), 'utf8');
    const domain = readFileSync(
      join(repoRoot, '.agents/domains/feishu-pairing-access.md'),
      'utf8',
    );
    for (const text of [feishuReadme, dreamuxReadme, domain]) {
      expect(text).toMatch(/version 3|V3/);
      expect(text).toMatch(/needs no rebuild|no rebuild/);
      expect(text).toMatch(/review every non-empty[\s\S]{0,100}allow_chats/i);
      expect(text).toMatch(/allowlist/);
      expect(text).toMatch(/follow-user/);
      expect(text).toMatch(/human membership/);
      expect(text).toMatch(/passive known-bot observation/);
    }
    expect(domain).toMatch(/retained `follow-user` `allow_chats` entry[\s\S]{0,180}ignored/);
    expect(domain).toMatch(/retained `allowlist` entry[\s\S]{0,180}`dm_policy`/);
    expect(feishuReadme).toMatch(/exact[\s\S]{0,220}is_bot_sender: false/);
    expect(feishuReadme).not.toContain('sender_kind` input');
  });

  it('publishes the complete secure V3 default and ownership boundary', () => {
    const readme = readFileSync(join(repoRoot, 'packages/dreamux/README.md'), 'utf8');
    const defaultStart = readme.indexOf('The complete secure V3');
    const defaultEnd = readme.indexOf('`access.json` remains version 3', defaultStart);
    expect(defaultStart).toBeGreaterThanOrEqual(0);
    expect(defaultEnd).toBeGreaterThan(defaultStart);
    const secureDefault = readme.slice(defaultStart, defaultEnd);
    for (const field of [
      '"version": 3',
      '"dm_policy": "pairing"',
      '"policy": "follow-user"',
      '"allow_chats": []',
      '"require_mention": true',
      '"allow_users": []',
      '"pending": {}',
      '"observed_chats": []',
      '"warnings": []',
      '"last_gate"',
      '"at": 0',
    ]) {
      expect(secureDefault).toContain(field);
    }
    expect(secureDefault).not.toMatch(/<CHAT_ID>|<USER_ID>/);
    expect(readme).toMatch(/secure default grants neither[\s\S]{0,80}authority/);
    expect(readme).toMatch(/`version` is Channel\/schema-owned/);
    expect(readme).toMatch(/`allow_users` is shared authority/);
    expect(readme).toMatch(/`pending`[\s\S]{0,180}Channel-owned\s+runtime ledger fields/);
    expect(readme).toMatch(
      /DREAMUX_CONFIG_DIR[\s\S]{0,100}dreamux config path` affect `config\.json` only/,
    );
    expect(readme).toMatch(/missing state directory at `0700`/);
    expect(readme).toMatch(/first `0600` file/);
    expect(readme).toMatch(/dreamux doctor` is not an access-state validator/);
  });

  it('documents every built-in Codex field and the parsed-but-unused timeout', () => {
    const readme = readFileSync(join(repoRoot, 'packages/dreamux/README.md'), 'utf8');
    const start = readme.indexOf('For `builtin:codex`, every config field');
    const end = readme.indexOf('Claude Code agents use a different', start);
    const codex = readme.slice(start, end);
    for (const field of [
      'bin',
      'approval_policy',
      'sandbox_mode',
      'extra_args',
      'extra_env',
      'initialize_timeout_ms',
      'turn_timeout_ms',
    ]) {
      expect(codex).toContain(`\`${field}\``);
    }
    expect(codex).toContain('`600000`');
    expect(codex).toMatch(/not passed into `CodexRuntime`/);
    expect(codex).toMatch(/currently has no runtime effect/);
  });

  it('locks the root maintenance synchronization and release-policy carve-out', () => {
    const rootRules = readFileSync(join(repoRoot, 'CLAUDE.md'), 'utf8');
    const stateDomain = readFileSync(
      join(repoRoot, '.agents/domains/state-config-and-files.md'),
      'utf8',
    );
    const releaseDomain = readFileSync(
      join(repoRoot, '.agents/domains/repository-operations-and-release.md'),
      'utf8',
    );
    expect(rootRules).toMatch(/every change to the shape,[\s\S]{0,180}ownership, or meaning/);
    expect(rootRules).toContain('/packages/dreamux/skills/dispatcher/dreamux-maintenance/');
    expect(rootRules).toMatch(/single owning reference/);
    expect(rootRules).toContain('references/self-upgrade.md');
    expect(rootRules).toMatch(/current-state-only/);
    expect(rootRules).toMatch(/incompatible shape, version, or path[\s\S]{0,160}`Rebuild:`/);
    expect(rootRules).toMatch(/same-shape[\s\S]{0,220}`Review:`/);
    for (const domain of [stateDomain, releaseDomain]) {
      expect(domain).toMatch(/incompatible shape, version, or path[\s\S]{0,180}`Rebuild:`/i);
      expect(domain).toMatch(/same-shape semantic change[\s\S]{0,220}`Review:`/);
      expect(domain).toMatch(/no rebuild|no `Rebuild:`/);
    }
  });
});
