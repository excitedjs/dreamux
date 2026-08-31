/**
 * Owner-Only Pairing Approval Card (see package CLAUDE.md).
 *
 * These are pure rendering/response-shape contracts, not gate/session
 * wiring — the gate's pairing-token state machine (who gets a token, TTL,
 * quota) is covered in feishu-gate.test.ts. What is under test here is the
 * card and callback-ACK *shape* the Feishu client actually receives, because
 * that is where the token-leak red line lives: the pairing token must never
 * become visible card/toast text, only the opaque button `value`, and a
 * successful click must ACK through the official raw-card response shape
 * rather than a bare card wrapper.
 */
import { describe, expect, it } from 'vitest';

import {
  buildPairingApprovalCard,
  buildPairingSuccessCard,
  DREAMUX_ACTION_KEY,
  DREAMUX_PAIRING_CARD_ACTION,
  DREAMUX_PAIRING_TOKEN_KEY,
  rawCardActionResponse,
} from '../src/feishu-pairing-card.js';

/** Recursively collect every string leaf in a card tree, card text included. */
function stringLeaves(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) stringLeaves(item, out);
  } else if (value !== null && typeof value === 'object') {
    for (const v of Object.values(value)) stringLeaves(v, out);
  }
  return out;
}

describe('buildPairingApprovalCard — the token never becomes visible card text', () => {
  const token = 'super-secret-pairing-token-should-not-leak';

  function card(): unknown {
    return buildPairingApprovalCard({
      token,
      botDisplayName: 'Dreamux bot',
      requesterOpenId: 'ou_requester_123',
    });
  }

  it('places the token only under the action button value, keyed by the documented constants', () => {
    const rendered = card() as {
      elements: Array<{
        tag: string;
        actions?: Array<{
          value?: Record<string, string>;
        }>;
      }>;
    };
    const actionElement = rendered.elements.find((el) => el.tag === 'action');
    expect(actionElement).toBeDefined();
    const button = actionElement?.actions?.[0];
    expect(button?.value).toEqual({
      [DREAMUX_ACTION_KEY]: DREAMUX_PAIRING_CARD_ACTION,
      [DREAMUX_PAIRING_TOKEN_KEY]: token,
    });
  });

  it('never emits the raw token as a string anywhere outside the button value field', () => {
    const rendered = card() as {
      elements: Array<{
        tag: string;
        text?: unknown;
        actions?: Array<{ text?: unknown; value?: Record<string, string> }>;
      }>;
    };
    // Strip the one legitimate carrier (the button's `value` map) before
    // scanning every remaining string leaf in the tree for a token leak.
    const withoutTokenCarrier = rendered.elements.map((el) => {
      if (el.tag !== 'action') return el;
      return {
        ...el,
        actions: el.actions?.map(({ value: _value, ...rest }) => rest),
      };
    });
    const leaves = stringLeaves(withoutTokenCarrier);
    expect(leaves.some((leaf) => leaf.includes(token))).toBe(false);
  });

  it('uses a distinct Chinese/English pair via i18n_content rather than concatenating both languages', () => {
    const rendered = card() as {
      header: { title: { content: string; i18n_content: { en_us: string } } };
      elements: Array<{
        text?: { content: string; i18n_content?: { en_us: string } };
      }>;
    };
    expect(rendered.header.title.content).toContain('用户请求访问');
    expect(rendered.header.title.content).not.toContain('User requests');
    expect(rendered.header.title.i18n_content.en_us).toContain(
      'User requests access',
    );
    expect(rendered.header.title.i18n_content.en_us).not.toContain(
      '用户请求访问',
    );

    const body = rendered.elements.find((el) => el.text !== undefined);
    expect(body?.text?.content).toContain('仅 App Owner 可以点击批准');
    expect(body?.text?.i18n_content?.en_us).toContain(
      'Only the App Owner can approve',
    );
  });

  it('@-mentions the requester with the card Markdown <at> form', () => {
    const rendered = card() as {
      elements: Array<{ text?: { content: string } }>;
    };
    const body = rendered.elements.find((el) => el.text !== undefined);
    expect(body?.text?.content).toContain(
      '<at id="ou_requester_123"></at>',
    );
  });

  it('strips markup-significant characters from a hostile requester open_id instead of forging the <at> tag', () => {
    const hostile = buildPairingApprovalCard({
      token,
      botDisplayName: 'Dreamux bot',
      requesterOpenId: 'ou"><script>x</script>',
    }) as { elements: Array<{ text?: { content: string } }> };
    const body = hostile.elements.find((el) => el.text !== undefined);
    // The malicious characters are stripped from the id, not escaped —
    // either way, no `<script>` tag survives, and the wrapping `<at ...>`
    // stays exactly one legitimate tag.
    expect(body?.text?.content).not.toContain('<script>');
    expect(body?.text?.content.match(/<at id="/g)).toHaveLength(1);
  });

  it('renders under the blue (pending-decision) template, distinct from the green success card', () => {
    const rendered = card() as { header: { template: string } };
    expect(rendered.header.template).toBe('blue');
  });
});

describe('buildPairingSuccessCard', () => {
  it('renders green and carries no token-shaped field at all', () => {
    const rendered = buildPairingSuccessCard({ duplicate: false }) as {
      header: { template: string };
    };
    expect(rendered.header.template).toBe('green');
    const leaves = stringLeaves(rendered);
    // The success card input has no token; this also guards against a future
    // change accidentally threading one through.
    expect(leaves.every((leaf) => !leaf.toLowerCase().includes('token'))).toBe(
      true,
    );
  });

  it('distinguishes a fresh approval from a duplicate (already-allowed) approval in both languages', () => {
    const fresh = buildPairingSuccessCard({ duplicate: false }) as {
      elements: Array<{ text?: { content: string; i18n_content?: { en_us: string } } }>;
    };
    const dup = buildPairingSuccessCard({ duplicate: true }) as {
      elements: Array<{ text?: { content: string; i18n_content?: { en_us: string } } }>;
    };
    const freshBody = fresh.elements.find((el) => el.text !== undefined)?.text;
    const dupBody = dup.elements.find((el) => el.text !== undefined)?.text;
    expect(freshBody?.content).not.toBe(dupBody?.content);
    expect(freshBody?.i18n_content?.en_us).not.toBe(dupBody?.i18n_content?.en_us);
  });
});

describe('rawCardActionResponse — official card-callback ACK shape', () => {
  it('wraps the card under type "raw" alongside the toast, never a bare card', () => {
    const card = { some: 'card' };
    const response = rawCardActionResponse(card, {
      type: 'success',
      content: 'ok',
    });
    expect(response).toEqual({
      toast: { type: 'success', content: 'ok' },
      card: { type: 'raw', data: card },
    });
  });
});
