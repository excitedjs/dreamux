/**
 * The adapter from one inbound Channel turn to Core's submission input.
 *
 * A Channel hands Core the pieces of an external message it already
 * interpreted. This turns those into the generic {@link TeammateSubmitInput}
 * every Core producer states, so Channel ingress and `team.submit` reach the
 * runtime through exactly the same seam.
 *
 * The parameter is stated structurally, as the three facts Core actually
 * consumes, rather than as the wider Channel-port shape. Core reads none of
 * them: the provenance name is fixed here instead of taken from the payload —
 * a Channel cannot name itself into another producer's dedupe window — and the
 * attributes are passed through untouched for the model.
 */
import { CHANNEL_SOURCE } from './submission-sources.js';
import type { TeammateSubmitInput } from './teammate-service/submission.js';

export interface ChannelInboundTurn {
  /** The Channel's model-facing body, delivered exactly as supplied. */
  readonly text: string;
  /** The Channel's dedupe hint. An empty string disables deduplication. */
  readonly sourceId: string;
  /** Opaque display attributes the Channel wants the model to see. */
  readonly attrs?: readonly (readonly [string, string])[];
}

export function channelSubmission(turn: ChannelInboundTurn): TeammateSubmitInput {
  // The Channel port still carries ordered pairs. Attributes have no semantic
  // order and cannot repeat a name, so the last value for a name wins — the
  // same collapse the object shape guarantees everywhere downstream.
  const attrs = Object.fromEntries(turn.attrs ?? []);
  return {
    source: CHANNEL_SOURCE,
    ...(Object.keys(attrs).length > 0 ? { attrs } : {}),
    text: turn.text,
    ...(turn.sourceId !== '' ? { sourceId: turn.sourceId } : {}),
  };
}
