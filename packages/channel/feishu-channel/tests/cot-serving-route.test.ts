import { describe, expect, it, vi } from 'vitest';
import {
  CotState,
  LeaderLifecycleFence,
  prepareVisibleAnchor,
  cotRecipientKey,
} from '../src/cot/recipients.js';
import { chatTarget, topicTarget } from '../src/routing/target.js';
const parent = chatTarget('chat', 'group');
const topic = topicTarget('chat', 'topic');
function state(teamName: string, servingTarget = parent) {
  const state = new CotState({ kind: 'leader', teamName });
  state.anchor = prepareVisibleAnchor({
    chatId: 'chat',
    messageId: 'message',
    target: topic,
    servingTarget,
  });
  return state;
}
describe('COT serving-route retirement', () => {
  it('retires a parent-served topic while leaving independently served exact topics and other Teams alone', () => {
    const inherited = state('parent-team');
    const exact = state('exact-team', topic);
    const states = new Map(
      [inherited, exact].map((s) => [cotRecipientKey(s.identity), s]),
    );
    const interrupt = vi.fn();
    const fence = new LeaderLifecycleFence();
    fence.onRouteReleased(
      { teamName: 'parent-team', target: parent },
      states,
      interrupt,
    );
    expect(interrupt).toHaveBeenCalledWith(
      cotRecipientKey(inherited.identity),
      inherited,
    );
    interrupt.mockClear();
    fence.onRouteReleased(
      { teamName: 'exact-team', target: parent },
      states,
      interrupt,
    );
    expect(interrupt).not.toHaveBeenCalled();
  });
  it('keeps captured provenance when an exact route is later rebound and preserves visible-target fencing', () => {
    const inherited = state('old-team');
    const key = cotRecipientKey(inherited.identity);
    const fence = new LeaderLifecycleFence();
    const interrupt = vi.fn();
    const states = new Map([[key, inherited]]);
    fence.onRouteClaimed({ teamName: 'new-team', target: topic });
    fence.onRouteReleased(
      { teamName: 'old-team', target: parent },
      states,
      interrupt,
    );
    expect(interrupt).toHaveBeenCalledOnce();
    expect(fence.blocksAnchor(key, inherited.anchor!)).toBe(false);
    fence.onRouteReleased(
      { teamName: 'old-team', target: topic },
      states,
      interrupt,
    );
    expect(fence.blocksAnchor(key, inherited.anchor!)).toBe(true);
    fence.onRouteClaimed({ teamName: 'old-team', target: topic });
    expect(fence.blocksAnchor(key, inherited.anchor!)).toBe(false);
  });
  it('copies serving provenance and retains null for Dispatcher anchors', () => {
    const input = {
      chatId: 'chat',
      messageId: 'message',
      target: topic,
      servingTarget: parent,
    };
    const anchor = prepareVisibleAnchor(input)!;
    expect(anchor.servingTarget).toEqual(parent);
    expect(anchor.servingTarget).not.toBe(parent);
    expect(
      prepareVisibleAnchor({ ...input, servingTarget: null })?.servingTarget,
    ).toBeNull();
  });
});
