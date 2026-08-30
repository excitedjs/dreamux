/**
 * The submission envelope: the LOCKED `TeammateSubmitInput` signature, the
 * rendering rule that turns it into model-facing text, source selection
 * across Core's own producers, and the Command-boundary admission
 * normalization that sits in front of it.
 *
 * Everything here is a pure function or a structural type-shape assertion —
 * no runtime, no filesystem, no timers — because the envelope contract is
 * deliberately owned by exactly those pure functions (`submission.ts`,
 * `submission-sources.ts`, `channel-submission.ts`,
 * `team-collection/projections.ts`).
 */
import { describe, expect, it } from 'vitest';

import type { DreamuxLogger, TeamSubmitCommand } from '@excitedjs/dreamux-types';

import type { RestartIntentConsumer } from '../src/daemon/restart-intent.js';
import {
  channelSubmission,
  type ChannelInboundTurn,
} from '../src/service/channel-submission.js';
import { injectRestartNoticeIfNeeded } from '../src/service/dispatcher-service/restart-notice.js';
import {
  AGENT_TASK_SOURCE,
  CHANNEL_SOURCE,
  COMPLETION_SOURCE,
  SCHEDULED_SOURCE,
  SYSTEM_SOURCE,
} from '../src/service/submission-sources.js';
import { teamSubmitResult } from '../src/service/team-collection/projections.js';
import type { TeammateService } from '../src/service/teammate-service/index.js';
import {
  isSafeTagName,
  renderSubmission,
  type TeammateSubmitInput,
} from '../src/service/teammate-service/submission.js';
import type { TurnAdmission } from '../src/service/teammate-service/turn-recording.js';

const silentLog: DreamuxLogger = {
  error: () => {},
  warn: () => {},
  info: () => {},
  debug: () => {},
  trace: () => {},
} as unknown as DreamuxLogger;

/**
 * A type-only sink: passing an object literal here runs TypeScript's excess
 * property check against the real `TeammateSubmitInput` contract. A field the
 * contract does not declare is a compile error at the call site, caught by
 * `tsc -p tsconfig.tests.json --noEmit` (every `@ts-expect-error` below is
 * itself an error — TS2578 "Unused '@ts-expect-error' directive" — if the
 * field it guards ever stops being rejected).
 */
function acceptSubmitInput(_input: TeammateSubmitInput): void {}

describe('TeammateSubmitInput: the locked model-facing submission signature', () => {
  it('accepts exactly source, attrs, text, reminder, sourceId, intent, deliverCompletion', () => {
    const full: TeammateSubmitInput = {
      source: 'channel',
      attrs: { chat: 'general' },
      text: 'hello',
      reminder: 'be nice',
      sourceId: 'msg-1',
      intent: 'chat',
      deliverCompletion: async () => undefined,
    };
    expect(Object.keys(full).sort()).toEqual(
      [
        'attrs',
        'deliverCompletion',
        'intent',
        'reminder',
        'source',
        'sourceId',
        'text',
      ].sort(),
    );
  });

  it('rejects a channelInput wrapper (the removed multi-shape submission surface)', () => {
    // @ts-expect-error channelInput wrapper was deleted; the four model-facing
    // fields are flat on TeammateSubmitInput, not nested under a per-producer key.
    acceptSubmitInput({ source: 'channel', text: 'x', channelInput: { chat: 'g' } });
  });

  it('rejects a scheduledInput wrapper', () => {
    // @ts-expect-error scheduledInput wrapper was deleted the same way.
    acceptSubmitInput({ source: 'cron', text: 'x', scheduledInput: { fire: 1 } });
  });

  it('rejects a controlInput wrapper', () => {
    // @ts-expect-error controlInput wrapper was deleted the same way.
    acceptSubmitInput({ source: 'task', text: 'x', controlInput: {} });
  });

  it('rejects an invocation-origin scope', () => {
    // @ts-expect-error there is no scope dimension on the submission itself;
    // the admission ledger key has no scope component either (see
    // admission-ledger.test.ts).
    acceptSubmitInput({ source: 'channel', text: 'x', scope: 'thread' });
  });

  it('rejects an opaque correlation token', () => {
    // @ts-expect-error opaque correlation was removed; sourceId is the one
    // caller-supplied identity, and it is a plain dedupe key, not a token
    // threaded through anything.
    acceptSubmitInput({ source: 'channel', text: 'x', correlationId: 'abc' });
  });

  it('rejects a caller-supplied turnOrigin', () => {
    // @ts-expect-error turnOrigin does not exist on the submission; `source` is
    // the one provenance fact Core keeps.
    acceptSubmitInput({ source: 'channel', text: 'x', turnOrigin: 'user' });
  });

  it('rejects a caller-selected reopenClosed flag', () => {
    // @ts-expect-error whether a closed target reopens is not a caller choice:
    // every ordinary admitted input reopens its target unconditionally.
    acceptSubmitInput({ source: 'channel', text: 'x', reopenClosed: true });
  });

  it('rejects a caller-supplied AbortSignal', () => {
    // @ts-expect-error there is no cancellation seam on the submission input.
    acceptSubmitInput({ source: 'channel', text: 'x', signal: new AbortController().signal });
  });

  it('rejects a caller-supplied logging label', () => {
    // @ts-expect-error logging labels are not part of the model-facing or
    // ledger-facing contract; a caller cannot annotate what gets logged.
    acceptSubmitInput({ source: 'channel', text: 'x', label: 'debug-probe' });
  });
});

describe('renderSubmission: the one paired-root envelope', () => {
  it('renders a bare source with no attrs and the body untouched', () => {
    expect(renderSubmission({ source: 'channel', text: 'hi there' })).toBe(
      '<channel>hi there</channel>',
    );
  });

  it('renders an explicit empty attrs object identically to an omitted one', () => {
    const withOmitted = renderSubmission({ source: 'channel', text: 'hi' });
    const withEmpty = renderSubmission({ source: 'channel', attrs: {}, text: 'hi' });
    expect(withEmpty).toBe(withOmitted);
    expect(withOmitted).toBe('<channel>hi</channel>');
  });

  it('renders every attribute inside the start tag, in insertion order', () => {
    expect(
      renderSubmission({
        source: 'channel',
        attrs: { chat: 'general', from: 'alice' },
        text: 'hi',
      }),
    ).toBe('<channel chat="general" from="alice">hi</channel>');
  });

  it('has no <content> child: the body sits directly between the paired tags', () => {
    const rendered = renderSubmission({ source: 'channel', text: 'hi' });
    expect(rendered).not.toContain('<content');
    expect(rendered).toBe('<channel>hi</channel>');
  });

  it('adds no pretty-print indentation or newlines around the body', () => {
    const rendered = renderSubmission({
      source: 'channel',
      attrs: { chat: 'general' },
      text: 'line one\nline two',
    });
    expect(rendered).toBe('<channel chat="general">line one\nline two</channel>');
  });

  it('never rewrites XML entities in the body', () => {
    const body = 'a < b && b > c, say "hi" & bye';
    const rendered = renderSubmission({ source: 'channel', text: body });
    expect(rendered).toBe(`<channel>${body}</channel>`);
    expect(rendered).not.toContain('&lt;');
    expect(rendered).not.toContain('&amp;');
  });

  it('never wraps the body in CDATA', () => {
    const rendered = renderSubmission({ source: 'channel', text: 'plain text' });
    expect(rendered).not.toContain('CDATA');
  });

  it('carries Markdown code fences through the body verbatim', () => {
    const body = 'before\n```ts\nconst x = 1 < 2 && "ok";\n```\nafter';
    const rendered = renderSubmission({ source: 'channel', text: body });
    expect(rendered).toBe(`<channel>${body}</channel>`);
  });

  it('escapes attribute VALUES but leaves the body untouched for the same characters', () => {
    const raw = 'a & b <c> "d"';
    const rendered = renderSubmission({
      source: 'channel',
      attrs: { title: raw },
      text: raw,
    });
    expect(rendered).toBe(
      '<channel title="a &amp; b &lt;c&gt; &quot;d&quot;">a & b <c> "d"</channel>',
    );
  });

  it('appends one reminder sibling after the closed source block, never repeated inside', () => {
    const rendered = renderSubmission({
      source: 'channel',
      text: 'hello there',
      reminder: 'stay on task',
    });
    expect(rendered).toBe(
      '<channel>hello there</channel>\n\n<reminder>stay on task</reminder>',
    );
    // Exactly one reminder tag: it is a sibling of the closed source block, not
    // a duplicate wrapped inside every message.
    expect(rendered.match(/<reminder>/g)).toHaveLength(1);
  });

  it('omits the reminder entirely when absent or empty', () => {
    expect(renderSubmission({ source: 'channel', text: 'hi' })).not.toContain('reminder');
    expect(
      renderSubmission({ source: 'channel', text: 'hi', reminder: '' }),
    ).not.toContain('reminder');
  });

  it('fails loud on an unsafe source name instead of degrading', () => {
    expect(() => renderSubmission({ source: 'bad name', text: 'x' })).toThrow(
      /not a safe tag name/,
    );
    expect(() => renderSubmission({ source: '<channel>', text: 'x' })).toThrow();
  });

  it('fails loud on an unsafe attribute name instead of degrading', () => {
    expect(() =>
      renderSubmission({ source: 'channel', attrs: { 'bad name': 'v' }, text: 'x' }),
    ).toThrow(/not a safe tag name/);
  });

  it('accepts any open, owner-chosen source name — Core does not branch on an enum', () => {
    // `feishu-thread` is not one of the five Core-producer constants below; it
    // is exactly the kind of name a new Channel form is free to invent.
    expect(renderSubmission({ source: 'feishu-thread', text: 'x' })).toBe(
      '<feishu-thread>x</feishu-thread>',
    );
  });

  it('renders none of sourceId, intent, or deliverCompletion — they are Core-only fields', () => {
    // Exact equality (not `.toContain`) is load-bearing: a `.toContain('hi')`
    // check would pass even if a leak like `sourceId` sneaked into an attr or
    // a second child. Only the paired root and the untouched body may appear.
    const rendered = renderSubmission({
      source: 'channel',
      text: 'hi',
      sourceId: 'SECRET-msg-77',
      intent: 'SECRET-intent',
      deliverCompletion: async () => {},
    });
    expect(rendered).toBe('<channel>hi</channel>');
    expect(rendered).not.toContain('SECRET');
  });
});

describe('isSafeTagName: the shared start-tag safety rule', () => {
  it('accepts open, hyphenated, dotted, and underscored names', () => {
    expect(isSafeTagName('channel')).toBe(true);
    expect(isSafeTagName('feishu-thread')).toBe(true);
    expect(isSafeTagName('x.y_z9')).toBe(true);
    expect(isSafeTagName('_leading')).toBe(true);
  });

  it('rejects a name that could break out of the start tag', () => {
    expect(isSafeTagName('bad name')).toBe(false);
    expect(isSafeTagName('<channel')).toBe(false);
    expect(isSafeTagName('channel>')).toBe(false);
    expect(isSafeTagName('a"b')).toBe(false);
    expect(isSafeTagName('')).toBe(false);
    expect(isSafeTagName('9leading')).toBe(false);
  });
});

describe("Core's own producer source names", () => {
  it('are each a safe tag name, since every one is rendered as the envelope root', () => {
    for (const source of [
      CHANNEL_SOURCE,
      SCHEDULED_SOURCE,
      AGENT_TASK_SOURCE,
      COMPLETION_SOURCE,
      SYSTEM_SOURCE,
    ]) {
      expect(isSafeTagName(source)).toBe(true);
    }
  });

  it('name the five known provenance values current source actually uses', () => {
    expect(CHANNEL_SOURCE).toBe('channel');
    expect(SCHEDULED_SOURCE).toBe('cron');
    expect(AGENT_TASK_SOURCE).toBe('task');
    expect(COMPLETION_SOURCE).toBe('task-notification');
    expect(SYSTEM_SOURCE).toBe('system');
  });
});

describe('channelSubmission: the Channel-adapter and admin.sock ingress boundary', () => {
  const base: ChannelInboundTurn = { text: 'hello team', sourceId: 'msg-1' };

  it('always submits under CHANNEL_SOURCE, never a Channel-chosen name', () => {
    expect(channelSubmission(base).source).toBe(CHANNEL_SOURCE);
    expect(channelSubmission({ ...base, sourceId: '' }).source).toBe('channel');
  });

  it('omits attrs entirely when the Channel supplies none, matching renderSubmission’s own omitted-equals-empty rule', () => {
    const result = channelSubmission(base);
    expect('attrs' in result).toBe(false);
  });

  it('collapses duplicate attribute names to the last value — duplicates are unrepresentable past this point', () => {
    const result = channelSubmission({
      ...base,
      attrs: [
        ['title', 'first'],
        ['title', 'second'],
      ],
    });
    expect(result.attrs).toEqual({ title: 'second' });
    expect(Object.keys(result.attrs ?? {})).toHaveLength(1);
  });

  it('carries an empty sourceId through as bypassing dedup, never as an empty-string key', () => {
    const result = channelSubmission({ ...base, sourceId: '' });
    expect('sourceId' in result).toBe(false);
  });

  it('carries a non-empty sourceId through unchanged', () => {
    const result = channelSubmission({ ...base, sourceId: 'msg-42' });
    expect(result.sourceId).toBe('msg-42');
  });

  it('never sets an intent: the Channel-adapter boundary does not touch the recovery subject', () => {
    const result = channelSubmission(base);
    expect('intent' in result).toBe(false);
  });
});

describe('Command-boundary admission normalization (team-collection/projections.ts)', () => {
  function submitted(): TurnAdmission {
    return { status: 'submitted', turn: { id: 'turn-1' } } as unknown as TurnAdmission;
  }

  it('reports a real turn_id only for a newly submitted turn', () => {
    expect(teamSubmitResult(submitted())).toEqual({
      status: 'submitted',
      turn_id: 'turn-1',
    });
  });

  it('a duplicate result carries no invented turn_id', () => {
    const result = teamSubmitResult({ status: 'duplicate' });
    expect(result).toEqual({ status: 'duplicate' });
    expect('turn_id' in result).toBe(false);
  });

  it('normalizes the internal `skipped` provider-seam state to the public `stopped`', () => {
    const result = teamSubmitResult({ status: 'skipped' });
    expect(result.status).toBe('stopped');
    expect(result.error?.code).toBe('TURN_SKIPPED');
    expect('turn_id' in result).toBe(false);
  });

  it('reports a plain `stopped` unchanged', () => {
    expect(teamSubmitResult({ status: 'stopped' })).toEqual({ status: 'stopped' });
  });

  it('`failed` proves pre-admission: a distinct code from `ambiguous`, no turn_id', () => {
    const error = new Error('provider refused the send before admission');
    const result = teamSubmitResult({ status: 'failed', error });
    expect(result.status).toBe('failed');
    expect(result.error).toEqual({
      code: 'TEAM_SUBMIT_FAILED',
      message: error.message,
    });
    expect('turn_id' in result).toBe(false);
  });

  it('`ambiguous` is a deterministic, single mapping — never a retry loop', () => {
    const error = new Error('crossed the provider seam; outcome unknown');
    const first = teamSubmitResult({ status: 'ambiguous', error });
    const second = teamSubmitResult({ status: 'ambiguous', error });
    // Calling the pure projection twice with the same input yields the same
    // result both times: there is no hidden counter or backoff state that
    // would make a second call behave like an automatic retry.
    expect(first).toEqual(second);
    expect(first.status).toBe('ambiguous');
    expect(first.error?.code).toBe('TEAM_SUBMIT_AMBIGUOUS');
    expect(first.error?.code).not.toBe(
      teamSubmitResult({ status: 'failed', error }).error?.code,
    );
  });
});

/**
 * A type-only sink for the caller-facing `team.submit` Command input, the same
 * excess-property-check mechanism `acceptSubmitInput` uses above.
 */
function acceptTeamSubmitCommand(_input: TeamSubmitCommand): void {}

describe('SYSTEM_SOURCE is unreachable from the one ordinary caller-facing submit surface', () => {
  it('rejects a source field on team.submit — the Command schema has none to select `system` (or anything else) with', () => {
    // @ts-expect-error `TeamSubmitCommand` (dreamux-types/src/team.ts) declares
    // team_name/attrs/text/reminder/intent/source_id and nothing else. There is
    // no `source` field for a caller to set, so `system` (Core-reserved) is
    // structurally as unreachable through this surface as any other source name
    // — Core always supplies its own source (CHANNEL_SOURCE or
    // AGENT_TASK_SOURCE) when it turns this Command into a submission.
    acceptTeamSubmitCommand({ team_name: 'flow', text: 'hi', source: 'system' });
  });
});

describe('SYSTEM_SOURCE: the one Core-reserved producer', () => {
  it('the Dispatcher restart notice is the sole producer observed submitting under SYSTEM_SOURCE', async () => {
    const submitted: TeammateSubmitInput[] = [];
    const fakeAgent = {
      startContinuity: () => 'resumed' as const,
      submitInput: async (input: TeammateSubmitInput) => {
        submitted.push(input);
        return { status: 'submitted', turn: { id: 't1' } } as unknown as TurnAdmission;
      },
    } as unknown as TeammateService;
    const restartIntent = {
      claim: () => 'the dispatcher restarted',
    } as unknown as RestartIntentConsumer;

    await injectRestartNoticeIfNeeded({
      dispatcherId: 'flow',
      agent: fakeAgent,
      restartIntent,
      now: Date.now(),
      log: silentLog,
    });

    expect(submitted).toHaveLength(1);
    expect(submitted[0]?.source).toBe(SYSTEM_SOURCE);
    // No caller-facing surface accepts `source`, so this reservation is
    // structural: `team.submit`'s own input schema (team-collection/commands.ts)
    // declares no `source` field at all, and every ordinary submit path below
    // hardcodes CHANNEL_SOURCE or AGENT_TASK_SOURCE instead of reading one from
    // a payload — there is no branch anywhere an external caller could steer
    // into `system`.
  });

  it('skips the notice entirely for a fresh (non-resumed) start — no submission at all', async () => {
    const submitted: TeammateSubmitInput[] = [];
    const fakeAgent = {
      startContinuity: () => 'fresh' as const,
      submitInput: async (input: TeammateSubmitInput) => {
        submitted.push(input);
        return { status: 'submitted', turn: { id: 't1' } } as unknown as TurnAdmission;
      },
    } as unknown as TeammateService;
    const restartIntent = {
      claim: () => 'should never be read',
    } as unknown as RestartIntentConsumer;

    await injectRestartNoticeIfNeeded({
      dispatcherId: 'flow',
      agent: fakeAgent,
      restartIntent,
      now: Date.now(),
      log: silentLog,
    });

    expect(submitted).toHaveLength(0);
  });
});
