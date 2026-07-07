/**
 * Feishu channel provider config validation (issue #209 multi-channel config).
 *
 * The Feishu channel owns its config validation via `readConfig`; the Dreamux
 * host no longer pre-validates Feishu app credentials. These tests pin the
 * fail-loud contract the host relies on: a non-empty `app_id` and `app_secret`
 * (the bot secret is config-sourced), validated topic context controls, and no
 * unknown keys.
 */
import { describe, it, expect } from 'vitest';

import { createFeishuChannelProvider } from '../src/index.js';

const CTX = {
  dispatcher_id: 'flow',
  channel_id: 'primary',
  provider: 'builtin:feishu',
};

function readConfig(raw: unknown) {
  return createFeishuChannelProvider().readConfig!(raw, CTX);
}

describe('feishu channel readConfig', () => {
  it('parses app_id/app_secret into the camelCase provider config', () => {
    expect(readConfig({ app_id: 'app-x', app_secret: 'secret-x' })).toEqual({
      appId: 'app-x',
      appSecret: 'secret-x',
      topicContext: {
        enabled: false,
      },
    });
  });

  it('parses topicContext.enabled', () => {
    expect(
      readConfig({
        app_id: 'app-x',
        app_secret: 'secret-x',
        topicContext: {
          enabled: true,
        },
      }),
    ).toEqual({
      appId: 'app-x',
      appSecret: 'secret-x',
      topicContext: {
        enabled: true,
      },
    });
  });

  it('requires a non-empty app_id (empty and whitespace rejected)', () => {
    expect(() => readConfig({ app_id: '', app_secret: 's' })).toThrow(
      /non-empty app_id/,
    );
    expect(() => readConfig({ app_id: '   ', app_secret: 's' })).toThrow(
      /non-empty app_id/,
    );
  });

  it('requires a non-empty app_secret (empty and whitespace rejected)', () => {
    expect(() => readConfig({ app_id: 'app-x' })).toThrow(/non-empty app_secret/);
    expect(() => readConfig({ app_id: 'app-x', app_secret: '' })).toThrow(
      /non-empty app_secret/,
    );
    expect(() => readConfig({ app_id: 'app-x', app_secret: '   ' })).toThrow(
      /non-empty app_secret/,
    );
  });

  it('rejects unknown keys', () => {
    expect(() =>
      readConfig({ app_id: 'app-x', app_secret: 's', callback_secret: 'x' }),
    ).toThrow(/unknown key\(s\): 'callback_secret'/);
  });

  it('rejects invalid topicContext values', () => {
    expect(() =>
      readConfig({
        app_id: 'app-x',
        app_secret: 's',
        topicContext: false,
      }),
    ).toThrow(/topicContext must be an object/);
    expect(() =>
      readConfig({
        app_id: 'app-x',
        app_secret: 's',
        topicContext: { enabled: 'true' },
      }),
    ).toThrow(/topicContext\.enabled must be boolean/);
    expect(() =>
      readConfig({
        app_id: 'app-x',
        app_secret: 's',
        topicContext: { allowChatIds: ['oc_a'] },
      }),
    ).toThrow(/topicContext has unknown key\(s\): 'allowChatIds'/);
    expect(() =>
      readConfig({
        app_id: 'app-x',
        app_secret: 's',
        topicContext: { denyChatIds: ['oc_a'] },
      }),
    ).toThrow(/topicContext has unknown key\(s\): 'denyChatIds'/);
    expect(() =>
      readConfig({
        app_id: 'app-x',
        app_secret: 's',
        topicContext: { extra: true },
      }),
    ).toThrow(/topicContext has unknown key\(s\): 'extra'/);
  });
});
