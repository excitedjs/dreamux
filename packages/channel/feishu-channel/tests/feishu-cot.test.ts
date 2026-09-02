/**
 * The Feishu conversation-of-thought card contract.
 *
 * One recipient — a TeamLeader, or the Dispatcher Agent — owns one standing
 * anchor and at most one open card, whichever Feishu chat supplied that anchor.
 * These tests drive `FeishuCotAdapter` and its session seam directly against a
 * recording COT client and read the whole contract back off the cards that
 * client was asked to create, extend, and finish:
 *
 *  - single-card state and post-admission anchor replacement across any
 *    sequence of targets,
 *  - role parity: the Dispatcher runs the *same* anchor and card-transition
 *    assertions as a TeamLeader,
 *  - bind-card initialization for a TeamLeader that has no standing anchor, and
 *    no equivalent for the Dispatcher,
 *  - no-anchor suppression and the default-show policy for every message role,
 *  - the native turn end as the only terminal, and never as a reason to open a
 *    card,
 *  - a standing anchor outliving a failed card, so the next opening activity
 *    tries again there,
 *  - memory-only lifetime and stale lifecycle callbacks.
 *
 * Every identifier here is a placeholder; no real Feishu chat, message, or user
 * id appears in this file.
 */
import { describe, expect, it } from 'vitest';

import type {
  DreamuxLogger,
  TeamStateEvent,
  TeammateActivity,
  TeammateActivityEvent,
  TeammateRole,
  TeammateInputEvent,
} from '@excitedjs/dreamux-types';

import {
  FeishuCotAdapter,
  FEISHU_COT_OPENING_LABELS,
} from '../src/feishu-cot-adapter.js';
import { FEISHU_COT_EVENT_CONTENT_MAX_BYTES } from '../src/feishu-cot-events.js';
import { FeishuCotSessionSeam } from '../src/feishu-cot-session.js';
import type { VisibleMessageAnchor } from '../src/feishu-cot-state.js';
import { chatTarget, topicTarget } from '../src/routing/target.js';
import {
  cotTerminalCount,
  cotTerminal,
  cotTexts,
  cotToolNames,
  cotToolResultCount,
  createFakeCotClient,
  type FakeCotCard,
  type FakeCotClient,
} from './helpers/fake-feishu-cot.js';

function expectOpeningTexts(
  card: FakeCotCard,
  expectedAfterOpening: readonly string[],
): void {
  const texts = cotTexts(card);
  expect(FEISHU_COT_OPENING_LABELS).toContain(texts[0]);
  expect(texts.slice(1)).toEqual(expectedAfterOpening);
}

const silentLog: DreamuxLogger = {
  error: () => undefined,
  warn: () => undefined,
  info: () => undefined,
  debug: () => undefined,
  trace: () => undefined,
};

/**
 * Let the adapter's own serialized tail run to completion.
 *
 * Card creation and every append are queued behind one per-recipient promise
 * chain, so a test that has just published a fact must yield before reading the
 * client back.
 */
async function settle(ticks = 12): Promise<void> {
  for (let index = 0; index < ticks; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function anchorAt(
  chatId: string,
  messageId: string,
  target = chatTarget(chatId, 'group'),
): VisibleMessageAnchor {
  return { chatId, messageId, target };
}

interface RecipientScope {
  readonly teammate_name: string;
  readonly role: TeammateRole;
  readonly team_name: string | null;
}

/**
 * One recipient, described the way Core publishes it.
 *
 * The two kinds differ only in these three fields, which is the whole point of
 * running the same scenarios over both.
 */
interface Recipient {
  readonly label: string;
  readonly scope: RecipientScope;
}

const LEADER: Recipient = {
  label: 'TeamLeader',
  scope: {
    teammate_name: 'alpha-leader',
    role: 'team_leader',
    team_name: 'alpha',
  },
};

const DISPATCHER: Recipient = {
  label: 'Dispatcher',
  scope: { teammate_name: 'dispatcher-agent', role: 'dispatcher', team_name: null },
};

let sequence = 0;

function input(
  recipient: Recipient,
  content: string,
  source = 'feishu',
  sourceId: string | null = null,
): TeammateInputEvent {
  return {
    schema_version: 1,
    kind: 'teammate.input',
    occurred_at: 1_700_000_000_000 + (sequence += 1),
    ...recipient.scope,
    source,
    source_id: sourceId,
    content,
    content_truncated: false,
    redacted: false,
  };
}

function activity(
  recipient: Recipient,
  payload: TeammateActivity,
): TeammateActivityEvent {
  return {
    schema_version: 1,
    kind: 'teammate.activity',
    occurred_at: 1_700_000_000_000 + (sequence += 1),
    ...recipient.scope,
    activity: payload,
  };
}

function message(recipient: Recipient, content: string): TeammateActivityEvent {
  return activity(recipient, {
    kind: 'assistant.message',
    event_id: `event-${(sequence += 1)}`,
    content,
    content_truncated: false,
    redacted: false,
  });
}

function toolCall(
  recipient: Recipient,
  callId: string,
  status: 'started' | 'completed' | 'failed',
): TeammateActivityEvent {
  return activity(recipient, {
    kind: 'tool.call',
    event_id: `event-${(sequence += 1)}`,
    call_id: callId,
    tool_name: 'Read',
    tool_action: 'read',
    status,
    arguments_json: status === 'started' ? '{"file_path":"/tmp/example"}' : null,
    result_json: status === 'started' ? null : 'file contents',
    arguments_truncated: false,
    result_truncated: false,
    redacted: false,
  });
}

function nativeEnd(
  recipient: Recipient,
  status: 'completed' | 'failed' | 'interrupted',
  reason: string | null = null,
): TeammateActivityEvent {
  return activity(recipient, {
    kind: 'turn.ended',
    status,
    reason,
    reason_truncated: false,
    redacted: false,
  });
}

function teamState(
  teamName: string,
  leaderName: string,
  status: 'starting' | 'running' | 'closed',
): TeamStateEvent {
  return {
    schema_version: 1,
    kind: 'team.state',
    occurred_at: 1_700_000_000_000 + (sequence += 1),
    team_name: teamName,
    leader_name: leaderName,
    status,
    teammates: [],
  };
}

interface Harness {
  readonly adapter: FeishuCotAdapter;
  readonly cot: FakeCotClient;
}

function harness(): Harness {
  const cot = createFakeCotClient();
  const adapter = new FeishuCotAdapter({
    dispatcherId: 'disp-cot',
    channelId: 'chan-cot',
    log: silentLog,
    cotClient: () => cot,
  });
  return { adapter, cot };
}

function submitInbound(
  adapter: FeishuCotAdapter,
  recipient: Recipient,
  turnId: string,
  anchor: VisibleMessageAnchor,
): void {
  const sourceId = `message-${turnId}`;
  const lease = adapter.beginInboundSubmission({
    teamName: recipient.scope.role === 'dispatcher'
      ? null
      : recipient.scope.team_name,
    anchor,
    sourceId,
  });
  adapter.onInput(
    input(recipient, 'the already visible inbound', 'feishu', sourceId),
  );
  lease?.release();
}

/**
 * The same anchor and card-transition contract, run once per recipient.
 *
 * Requirement item 10 is literal about this: "Dispatcher passes the same anchor
 * and card-transition contract tests as TeamLeader." So these are not two
 * similar suites — they are one suite, parameterized by identity alone.
 */
describe.each([LEADER, DISPATCHER])(
  '$label COT — one recipient, one anchor, one open card',
  (recipient) => {
    it('opens under the inbound, hides its body, and displays the reply', async () => {
      const { adapter, cot } = harness();

      submitInbound(
        adapter,
        recipient,
        'turn-1',
        anchorAt('oc_home', 'om_user_1'),
      );
      adapter.onActivity(message(recipient, 'working on it'));
      await settle();

      expect(cot.cards).toHaveLength(1);
      const card = cot.cards[0]!;
      expect(card.chatId).toBe('oc_home');
      expect(card.originMessageId).toBe('om_user_1');
      expectOpeningTexts(card, ['working on it']);

      await adapter.close();
    });

    it('follows the recipient across any sequence of targets without ever opening a second card at once', async () => {
      const { adapter, cot } = harness();
      const targets: VisibleMessageAnchor[] = [
        anchorAt('oc_direct', 'om_1', chatTarget('oc_direct', 'p2p')),
        anchorAt('oc_group', 'om_2'),
        anchorAt('oc_group', 'om_3', topicTarget('oc_group', 'thread_a')),
      ];

      for (const [index, anchor] of targets.entries()) {
        submitInbound(adapter, recipient, `turn-${index}`, anchor);
        adapter.onActivity(
          message(recipient, `turn-${index}`, 'assistant', `reply ${index}`),
        );
        await settle();
      }

      // A target is a property of the anchor, never a partition: the same one
      // presentation moved three times instead of three cards accumulating.
      expect(cot.cards).toHaveLength(3);
      expect(cot.cards.map((card) => card.originMessageId)).toEqual([
        'om_1',
        'om_2',
        'om_3',
      ]);
      // Every superseded card was interrupted; exactly one is still open.
      expect(cot.cards.map(cotTerminal)).toEqual([
        'interrupted',
        'interrupted',
        null,
      ]);

      await adapter.close();
    });

    it('replaces the anchor on submit, mid native turn, and keeps writing into the successor card', async () => {
      const { adapter, cot } = harness();
      submitInbound(adapter, recipient, 'turn-a', anchorAt('oc_home', 'om_first'));
      adapter.onActivity(message(recipient, 'first thought'));
      await settle();

      // The operator writes again before anything settled or ended.
      submitInbound(adapter, recipient, 'turn-b', anchorAt('oc_other', 'om_second'));
      adapter.onActivity(
        message(recipient, 'still the same native turn'),
      );
      await settle();

      expect(cot.cards).toHaveLength(2);
      const [first, second] = cot.cards as [typeof cot.cards[0], typeof cot.cards[0]];
      expect(cotTerminal(first)).toBe('interrupted');
      expectOpeningTexts(first, ['first thought']);
      // The still-running native turn keeps producing, into the card the
      // operator is now looking at.
      expect(second.originMessageId).toBe('om_second');
      expectOpeningTexts(second, ['still the same native turn']);
      expect(cotTerminal(second)).toBeNull();

      await adapter.close();
    });

    it('closes the open card once on a completed native turn end, whatever it folded', async () => {
      const { adapter, cot } = harness();
      // Two logical submissions the provider folded into one native turn.
      submitInbound(adapter, recipient, 'turn-1', anchorAt('oc_home', 'om_1'));
      adapter.onActivity(message(recipient, 'part one'));
      adapter.onActivity(message(recipient, 'part two'));
      await settle();
      expect(cot.cards).toHaveLength(1);

      adapter.onActivity(nativeEnd(recipient, 'completed'));
      await settle();

      const card = cot.cards[0]!;
      expect(cotTerminal(card)).toBe('done');
      expect(cotTerminalCount(card)).toBe(1);
      // A second end is not a second terminal, and opens nothing.
      adapter.onActivity(nativeEnd(recipient, 'completed'));
      await settle();
      expect(cot.cards).toHaveLength(1);
      expect(cotTerminalCount(card)).toBe(1);

      await adapter.close();
    });

    it('ignores a native turn end while no card is open, and leaves the anchor able to open one', async () => {
      const { adapter, cot } = harness();
      submitInbound(adapter, recipient, 'turn-1', anchorAt('oc_home', 'om_1'));
      adapter.onActivity(nativeEnd(recipient, 'completed'));
      await settle();
      expect(cot.cards).toHaveLength(1);
      expect(cotTerminal(cot.cards[0]!)).toBe('done');

      // The anchor still stands, but nothing is open. A terminal has nothing to
      // finish, so it produces no card at all — not even one opened to close.
      adapter.onActivity(nativeEnd(recipient, 'interrupted'));
      adapter.onActivity(nativeEnd(recipient, 'completed'));
      await settle();
      expect(cot.cards).toHaveLength(1);

      // An opening activity, by contrast, does open one at that same anchor.
      adapter.onActivity(message(recipient, 'still talking'));
      await settle();
      expect(cot.cards).toHaveLength(2);
      expect(cot.cards[1]!.originMessageId).toBe('om_1');
      expect(cotTexts(cot.cards[1]!)).toEqual(['still talking']);

      await adapter.close();
    });

    it('closes the card as interrupted on an interrupted native turn end', async () => {
      const { adapter, cot } = harness();
      submitInbound(adapter, recipient, 'turn-1', anchorAt('oc_home', 'om_1'));
      await settle();

      adapter.onActivity(nativeEnd(recipient, 'interrupted'));
      await settle();

      expect(cotTerminal(cot.cards[0]!)).toBe('interrupted');
      await adapter.close();
    });

    it('ends the card as a failure on a failed native turn end', async () => {
      const { adapter, cot } = harness();
      submitInbound(adapter, recipient, 'turn-1', anchorAt('oc_home', 'om_1'));
      await settle();

      adapter.onActivity(nativeEnd(recipient, 'failed'));
      await settle();

      // AG-UI puts the failure terminal in its own event: a `RUN_FINISHED`
      // carrying `failed` renders as completed in the Feishu client, exactly
      // like a nonsense status, so a failed turn must not use one.
      const card = cot.cards[0]!;
      expect(cotTerminal(card)).toBe('error');
      expect(card.events.at(-1)?.eventType).toBe('RUN_ERROR');
      expect(cotTerminalCount(card)).toBe(1);
      // The documented content is `{ message, code }` and nothing else, so a
      // terminal that carried the run ids as well would be inventing fields.
      expect(Object.keys(card.events.at(-1)?.content ?? {}).sort())
        .toEqual(['code', 'message']);
      // A native end with no reason still needs a message: it is required.
      expect(card.events.at(-1)?.content['message']).toBe('任务失败');

      // Already ended: the session close that follows adds no second terminal.
      await adapter.close();
      expect(cotTerminalCount(card)).toBe(1);
    });

    it('shows a tool row and its result on the open card', async () => {
      const { adapter, cot } = harness();
      submitInbound(adapter, recipient, 'turn-1', anchorAt('oc_home', 'om_1'));
      adapter.onActivity(toolCall(recipient, 'call-1', 'started'));
      adapter.onActivity(toolCall(recipient, 'call-1', 'completed'));
      await settle();

      const card = cot.cards[0]!;
      expect(cotToolNames(card)).toEqual(['Read']);
      expect(cotToolResultCount(card)).toBe(1);

      await adapter.close();
    });

    it('shows nothing at all until the recipient has an anchor', async () => {
      const { adapter, cot } = harness();

      // A task brief, a runtime answer, a tool row, and a native end, all
      // before any anchor exists. Nothing is filtered by source or kind —
      // there is simply nowhere to put a card.
      adapter.onInput(input(recipient, 'a task brief', 'task'));
      adapter.onActivity(message(recipient, 'an answer'));
      adapter.onActivity(toolCall(recipient, 'call-0', 'started'));
      adapter.onActivity(nativeEnd(recipient, 'completed'));
      await settle();

      expect(cot.cards).toHaveLength(0);

      // And the moment an anchor exists, the very next fact is shown.
      submitInbound(adapter, recipient, 'turn-1', anchorAt('oc_home', 'om_1'));
      adapter.onActivity(message(recipient, 'now visible'));
      await settle();
      expectOpeningTexts(cot.cards[0]!, ['now visible']);

      await adapter.close();
    });

    it('bounds a long failure reason so the terminal still fits one event', async () => {
      const { adapter, cot } = harness();
      submitInbound(adapter, recipient, 'turn-1', anchorAt('oc_home', 'om_1'));
      // Core bounds a reason at 100_000 characters, an order of magnitude over
      // what one COT event's content may carry, so the terminal bounds it again
      // or the projector throws mid-flush and the card never ends.
      adapter.onActivity(nativeEnd(recipient, 'failed', '长'.repeat(100_000)));
      await settle();

      const card = cot.cards[0]!;
      expect(cotTerminal(card)).toBe('error');
      expect(
        Buffer.byteLength(JSON.stringify(card.events.at(-1)?.content), 'utf8'),
      ).toBeLessThanOrEqual(FEISHU_COT_EVENT_CONTENT_MAX_BYTES);

      await adapter.close();
    });

    it('prints an end reason on the card before ending it as a failure', async () => {
      const { adapter, cot } = harness();
      submitInbound(adapter, recipient, 'turn-1', anchorAt('oc_home', 'om_1'));
      // An input Core admitted but no runtime accepted ends its own card and
      // says why, because nothing else will ever close it.
      adapter.onActivity(
        nativeEnd(recipient, 'failed', 'the agent runtime is not running'),
      );
      await settle();

      const card = cot.cards[0]!;
      expect(cotTerminal(card)).toBe('error');
      expectOpeningTexts(card, ['the agent runtime is not running']);
      // The reason rides the terminal too, in the field the reference gives it.
      // Printing it is what makes it visible; whether the client renders this
      // field is unknown, so the card carries it both ways.
      expect(card.events.at(-1)?.content['message'])
        .toBe('the agent runtime is not running');

      await adapter.close();
    });

    it('is memory-only: closing the session interrupts the card and loses every anchor', async () => {
      const { adapter, cot } = harness();
      submitInbound(adapter, recipient, 'turn-1', anchorAt('oc_home', 'om_1'));
      await settle();

      await adapter.close();
      expect(cotTerminal(cot.cards[0]!)).toBe('interrupted');

      // A restarted session is a new adapter with an empty memory: there is no
      // restore, replay, or backfill, so the same recipient starts anchorless.
      const restarted = new FeishuCotAdapter({
        dispatcherId: 'disp-cot',
        channelId: 'chan-cot',
        log: silentLog,
        cotClient: () => cot,
      });
      restarted.onActivity(
        message(recipient, 'after the restart'),
      );
      restarted.onActivity(nativeEnd(recipient, 'completed'));
      await settle();

      expect(cot.cards).toHaveLength(1);
      await restarted.close();
    });
  },
);

describe('Feishu COT — the two recipients are independent presentations', () => {
  it('a TeamLeader and the Dispatcher each own their own anchor and card', async () => {
    const { adapter, cot } = harness();

    submitInbound(adapter, LEADER, 'turn-leader', anchorAt('oc_team', 'om_team_1'));
    submitInbound(
      adapter,
      DISPATCHER,
      'turn-dispatcher',
      anchorAt('oc_dm', 'om_dm_1'),
    );
    adapter.onActivity(message(LEADER, 'leader says'));
    adapter.onActivity(
      message(DISPATCHER, 'dispatcher says'),
    );
    await settle();

    expect(cot.cards).toHaveLength(2);
    expectOpeningTexts(cot.cards[0]!, ['leader says']);
    expectOpeningTexts(cot.cards[1]!, ['dispatcher says']);

    // One recipient's native turn ending closes only that recipient's card.
    adapter.onActivity(nativeEnd(LEADER, 'completed'));
    await settle();
    expect(cotTerminal(cot.cards[0]!)).toBe('done');
    expect(cotTerminal(cot.cards[1]!)).toBeNull();

    await adapter.close();
  });

  it('renders no card for a Team member, whose facts Core may still publish', async () => {
    const { adapter, cot } = harness();
    const member: Recipient = {
      label: 'member',
      scope: { teammate_name: 'alpha-worker', role: 'teammate', team_name: 'alpha' },
    };

    adapter.onInput(input(member, 'member brief', 'task', 'other-source'));
    adapter.onActivity(message(member, 'member output'));
    await settle();

    expect(cot.cards).toHaveLength(0);
    await adapter.close();
  });
});

describe('Feishu COT — anchor initialization', () => {
  it('an anchorless Team may use its visible bind card as the leader’s first anchor', async () => {
    const { adapter, cot } = harness();

    adapter.setFallbackAnchorIfAbsent(
      'alpha',
      anchorAt('oc_team', 'om_bind_card'),
    );
    // No card yet: an anchor is a place, not a presentation.
    await settle();
    expect(cot.cards).toHaveLength(0);

    adapter.onActivity(
      message(LEADER, 'the Team speaks first'),
    );
    await settle();

    expect(cot.cards).toHaveLength(1);
    expect(cot.cards[0]!.originMessageId).toBe('om_bind_card');
    expect(cotTexts(cot.cards[0]!)).toEqual(['the Team speaks first']);

    await adapter.close();
  });

  it('never displaces an anchor a Channel user message already established', async () => {
    const { adapter, cot } = harness();
    submitInbound(adapter, LEADER, 'turn-1', anchorAt('oc_team', 'om_user'));
    adapter.setFallbackAnchorIfAbsent(
      'alpha',
      anchorAt('oc_team', 'om_bind_card'),
    );
    adapter.onActivity(nativeEnd(LEADER, 'completed'));
    await settle();

    // The next card still hangs under the user's message, not the bind card.
    adapter.onActivity(message(LEADER, 'later output'));
    await settle();

    expect(cot.cards.map((card) => card.originMessageId)).toEqual([
      'om_user',
      'om_user',
    ]);
    await adapter.close();
  });

  it('gives the Dispatcher no installation or restart anchor: only a user message starts it', async () => {
    const { adapter, cot } = harness();

    // There is no Dispatcher equivalent of the bind card — the bind-card entry
    // point names a Team and a leader, and nothing else may seed an anchor.
    adapter.setFallbackAnchorIfAbsent(
      'alpha',
      anchorAt('oc_team', 'om_bind_card'),
    );
    // A restart notice reaching the Dispatcher before any user message is an
    // ordinary system input with nowhere to go.
    adapter.onInput(input(DISPATCHER, 'the server restarted', 'system'));
    adapter.onActivity(
      message(DISPATCHER, 'acknowledged'),
    );
    await settle();
    expect(cot.cards).toHaveLength(0);

    submitInbound(adapter, DISPATCHER, 'turn-user', anchorAt('oc_dm', 'om_dm_1'));
    await settle();
    expect(cot.cards).toHaveLength(1);
    expect(cot.cards[0]!.originMessageId).toBe('om_dm_1');

    await adapter.close();
  });
});

describe('Feishu COT — narrow Channel-body suppression', () => {
  it('hides this Channel\'s recognized turn body once and displays another turn', async () => {
    const { adapter, cot } = harness();
    submitInbound(adapter, LEADER, 'turn-channel', anchorAt('oc_team', 'om_1'));
    adapter.onInput(input(LEADER, 'another producer body', 'task'));
    adapter.onActivity(
      message(LEADER, 'the projected answer'),
    );
    await settle();

    expectOpeningTexts(cot.cards[0]!, [
      'another producer body',
      'the projected answer',
    ]);
    await adapter.close();
  });
});

describe('Feishu COT — stale lifecycle callbacks', () => {
  it('a closed Team interrupts its leader’s card and retires the anchor', async () => {
    const { adapter, cot } = harness();
    submitInbound(adapter, LEADER, 'turn-1', anchorAt('oc_team', 'om_1'));
    await settle();

    adapter.onTeamState(teamState('alpha', 'alpha-leader', 'closed'));
    await settle();
    expect(cotTerminal(cot.cards[0]!)).toBe('interrupted');

    // Fenced: later facts, and even a fresh anchor, present nothing.
    adapter.onActivity(message(LEADER, 'too late'));
    submitInbound(adapter, LEADER, 'turn-2', anchorAt('oc_team', 'om_2'));
    await settle();
    expect(cot.cards).toHaveLength(1);

    await adapter.close();
  });

  it('leaves the Dispatcher untouched when a Team closes: it has no Team fence', async () => {
    const { adapter, cot } = harness();
    submitInbound(adapter, DISPATCHER, 'turn-1', anchorAt('oc_dm', 'om_1'));
    await settle();

    adapter.onTeamState(teamState('alpha', 'alpha-leader', 'closed'));
    adapter.onActivity(message(DISPATCHER, 'still going'));
    await settle();

    expect(cot.cards).toHaveLength(1);
    expect(cotTerminal(cot.cards[0]!)).toBeNull();
    expectOpeningTexts(cot.cards[0]!, ['still going']);

    await adapter.close();
  });

  it('a removed route interrupts the card anchored in it, and a re-claimed route restores presentation', async () => {
    const { adapter, cot } = harness();
    const target = chatTarget('oc_team', 'group');
    submitInbound(adapter, LEADER, 'turn-1', anchorAt('oc_team', 'om_1', target));
    await settle();

    adapter.onRouteReleased({ teamName: 'alpha', target });
    await settle();
    expect(cotTerminal(cot.cards[0]!)).toBe('interrupted');

    // While unbound, that target may not anchor this Team again.
    submitInbound(adapter, LEADER, 'turn-2', anchorAt('oc_team', 'om_2', target));
    await settle();
    expect(cot.cards).toHaveLength(1);

    adapter.onRouteClaimed({ teamName: 'alpha', target });
    submitInbound(adapter, LEADER, 'turn-3', anchorAt('oc_team', 'om_3', target));
    await settle();
    expect(cot.cards).toHaveLength(2);
    expect(cot.cards[1]!.originMessageId).toBe('om_3');

    await adapter.close();
  });

  it('drops a presentation whose card could not be created, without failing anything', async () => {
    const { adapter, cot } = harness();
    cot.createError = new Error('platform refused');

    submitInbound(adapter, LEADER, 'turn-1', anchorAt('oc_team', 'om_1'));
    adapter.onActivity(message(LEADER, 'never displayed'));
    await settle();
    expect(cot.cards).toHaveLength(0);

    await adapter.close();
  });
});

/**
 * A card can fail; the place it hung from does not.
 *
 * The anchor is standing state a Channel user message established, and the card
 * is one attempt to present at it. So a create or append that the platform
 * refuses costs exactly that attempt: the recipient keeps its anchor, and the
 * next activity that can open a card opens one there — without waiting for a
 * new inbound message to arrive.
 */
describe('Feishu COT — a failed card leaves the standing anchor alone', () => {
  it('opens a card at the same anchor on the next activity after a create failed', async () => {
    const { adapter, cot } = harness();
    cot.createError = new Error('platform refused');

    submitInbound(adapter, LEADER, 'turn-1', anchorAt('oc_team', 'om_1'));
    await settle();
    expect(cot.cards).toHaveLength(0);

    // No new inbound, no new anchor — just the next thing the runtime says.
    cot.createError = null;
    adapter.onActivity(message(LEADER, 'after the failure'));
    await settle();

    expect(cot.cards).toHaveLength(1);
    expect(cot.cards[0]!.originMessageId).toBe('om_1');
    expect(cotTexts(cot.cards[0]!)).toEqual(['after the failure']);

    await adapter.close();
  });

  it('opens a card at the same anchor on the next activity after an append failed', async () => {
    const { adapter, cot } = harness();
    cot.appendError = new Error('append refused');

    submitInbound(adapter, LEADER, 'turn-1', anchorAt('oc_team', 'om_1'));
    await settle();
    // The card was created, then abandoned when its first append failed.
    expect(cot.cards).toHaveLength(1);
    expect(cotTexts(cot.cards[0]!)).toEqual([]);

    cot.appendError = null;
    adapter.onActivity(message(LEADER, 'after the failure'));
    await settle();

    expect(cot.cards).toHaveLength(2);
    expect(cot.cards[1]!.originMessageId).toBe('om_1');
    expect(cotTexts(cot.cards[1]!)).toEqual(['after the failure']);

    await adapter.close();
  });

  it('still opens nothing for a native end, which is a terminal and not an opening activity', async () => {
    const { adapter, cot } = harness();
    cot.createError = new Error('platform refused');

    submitInbound(adapter, LEADER, 'turn-1', anchorAt('oc_team', 'om_1'));
    await settle();
    expect(cot.cards).toHaveLength(0);

    cot.createError = null;
    adapter.onActivity(nativeEnd(LEADER, 'completed'));
    await settle();
    expect(cot.cards).toHaveLength(0);

    await adapter.close();
  });
});

/** The seam is the only thing that decides which Core facts reach a card. */
describe('FeishuCotSessionSeam — default-show, without a source whitelist', () => {
  function seamHarness(): {
    seam: FeishuCotSessionSeam;
    cot: FakeCotClient;
    setCurrent(value: boolean): void;
  } {
    const cot = createFakeCotClient();
    let current = true;
    const seam = new FeishuCotSessionSeam({
      dispatcherId: 'disp-cot',
      channelId: 'chan-cot',
      log: silentLog,
      cotClient: () => cot,
    });
    seam.start(() => current);
    return { seam, cot, setCurrent: (value) => { current = value; } };
  }

  function submitThroughSeam(
    seam: FeishuCotSessionSeam,
    recipient: Recipient,
    turnId: string,
    anchor: VisibleMessageAnchor,
  ): void {
    const sourceId = `message-${turnId}`;
    const lease = seam.beginInboundSubmission(
      recipient.scope.role === 'dispatcher' ? null : recipient.scope.team_name,
      anchor,
      sourceId,
    );
    seam.handle(input(recipient, 'the already visible inbound', 'feishu', sourceId));
    lease?.release();
  }

  it.each(['task', 'task-notification', 'cron', 'system', 'a-future-source'])(
    'shows a %s input once the recipient has an anchor',
    async (source) => {
      const { seam, cot } = seamHarness();
      submitThroughSeam(
        seam,
        LEADER,
        'turn-channel',
        anchorAt('oc_team', 'om_1'),
      );
      await settle();

      // Another producer submits to the same recipient, and no source whitelist
      // stands between either input and the card.
      seam.handle(input(LEADER, `${source} input`, source));
      seam.handle(message(LEADER, `${source} answer`));
      await settle();

      expectOpeningTexts(cot.cards[0]!, [
        `${source} input`,
        `${source} answer`,
      ]);
      await seam.close();
    },
  );

  it('forwards the turn end, which is the only terminal a card has', async () => {
    const { seam, cot } = seamHarness();
    submitThroughSeam(seam, LEADER, 'turn-1', anchorAt('oc_team', 'om_1'));
    await settle();

    seam.handle(message(LEADER, 'still working'));
    await settle();
    expect(cotTerminal(cot.cards[0]!)).toBeNull();

    seam.handle(nativeEnd(LEADER, 'completed'));
    await settle();
    expect(cotTerminal(cot.cards[0]!)).toBe('done');

    await seam.close();
  });

  it('shows an input body whose source_id this session did not send', async () => {
    const { seam, cot } = seamHarness();
    const lease = seam.beginInboundSubmission(
      'alpha',
      anchorAt('oc_team', 'om_1'),
      'message-own',
    );
    seam.handle(input(LEADER, 'another producer body', 'task', 'message-other'));
    lease?.release();
    await settle();
    expect(cot.cards).toHaveLength(1);
    expectOpeningTexts(cot.cards[0]!, ['another producer body']);

    await seam.close();
  });

  it('presents nothing once the session fence is no longer current', async () => {
    const { seam, cot, setCurrent } = seamHarness();
    submitThroughSeam(seam, LEADER, 'turn-1', anchorAt('oc_team', 'om_1'));
    await settle();

    setCurrent(false);
    seam.handle(message(LEADER, 'after the fence'));
    seam.handle(nativeEnd(LEADER, 'completed'));
    await settle();

    expectOpeningTexts(cot.cards[0]!, []);
    await seam.close();
  });

  it('is inert before start and after close', async () => {
    const cot = createFakeCotClient();
    const seam = new FeishuCotSessionSeam({
      dispatcherId: 'disp-cot',
      channelId: 'chan-cot',
      log: silentLog,
      cotClient: () => cot,
    });

    submitThroughSeam(seam, LEADER, 'turn-1', anchorAt('oc_team', 'om_1'));
    await settle();
    expect(cot.cards).toHaveLength(0);

    seam.start(() => true);
    submitThroughSeam(seam, LEADER, 'turn-2', anchorAt('oc_team', 'om_2'));
    await settle();
    expect(cot.cards).toHaveLength(1);

    await seam.close();
    expect(cotTerminal(cot.cards[0]!)).toBe('interrupted');
    submitThroughSeam(seam, LEADER, 'turn-3', anchorAt('oc_team', 'om_3'));
    seam.handle(message(LEADER, 'after close'));
    await settle();
    expect(cot.cards).toHaveLength(1);
  });
});
