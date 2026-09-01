/**
 * What this Channel hands Core, and what it does with the answer.
 *
 * One flat submission and one small outcome, both owned here, because the
 * Command is generic: Core is given display attributes, faithful body text, a
 * standing reminder, and a stable source id, and it renders the provenance
 * envelope itself. Nothing about Feishu crosses.
 */
import type {
  ChannelCommandError,
  TeamSubmitResult,
} from '@excitedjs/dreamux-types';

import type { VisibleMessageAnchor } from './feishu-cot-state.js';
import type { FeishuTarget } from './routing/target.js';

/**
 * The standing instruction appended once after the envelope Core assembles.
 *
 * It is the caller's own note to the model, not part of the message, so it is
 * passed as `reminder` and Core renders it as the final `<reminder>` sibling.
 * The Channel no longer spells the tag itself.
 */
export const CHANNEL_REMINDER =
  'Reply through the channel reply tool, never as plain assistant text.';

export interface FeishuSubmission {
  readonly attrs: Readonly<Record<string, string>>;
  readonly text: string;
  readonly reminder: string;
  /** The Feishu message id: the identity Core deduplicates a repeat on. */
  readonly sourceId: string;
  readonly anchor: VisibleMessageAnchor;
}

export type FeishuSubmitOutcome =
  | { readonly status: 'submitted'; readonly turnId: string | null }
  | { readonly status: 'duplicate' | 'stopped' }
  | {
      readonly status: 'failed' | 'ambiguous';
      readonly error: ChannelCommandError | null;
    }
  /**
   * A proven pre-admission rejection: Core resolved the Team and refused
   * before creating anything. Because it proves no turn was accepted, it lets
   * the Channel drop the stale row and deliver the message once to the
   * Dispatcher Agent instead.
   */
  | {
      readonly status: 'rejected';
      readonly code: 'TEAM_NOT_FOUND' | 'TEAM_CLOSED';
      readonly message: string;
    }
  /**
   * Automatic provisioning produced no recipient, and `team.submit` was never
   * invoked for this message.
   *
   * It proves Core admitted nothing exactly as a typed rejection does, so it
   * earns the same single delivery to the Dispatcher Agent. The proof is what
   * matters, not the failure: it exists only while no Command has been sent.
   */
  | { readonly status: 'unsubmitted'; readonly message: string }
  /**
   * Any other failure, including an unknown boundary. Never retried and never
   * re-routed: once Core has been called, a failure proves nothing about
   * whether a turn exists, and this Channel does not deliver a message a
   * second time on a guess.
   */
  | { readonly status: 'error'; readonly message: string };

export interface FeishuTeamSubmitter {
  submit(
    teamName: string,
    submission: FeishuSubmission,
  ): Promise<FeishuSubmitOutcome>;
}

/**
 * Read Core's answer to `team.submit` as one of this Channel's outcomes.
 *
 * The mapping is the whole of what a submission result means here: only
 * `submitted` carries a turn to anchor a card on, and every other status is
 * either a proven non-admission or a fact that proves nothing.
 */
export function submitOutcome(result: TeamSubmitResult): FeishuSubmitOutcome {
  switch (result.status) {
    case 'submitted':
      return { status: 'submitted', turnId: result.turn_id ?? null };
    case 'duplicate':
    case 'stopped':
      return { status: result.status };
    default:
      return { status: result.status, error: result.error ?? null };
  }
}

/** Read a rejected Command's code without assuming an error class. */
export function commandErrorCode(error: unknown): string | null {
  if (error === null || typeof error !== 'object') return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && code !== '' ? code : null;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface FeishuInboundDelivery {
  /**
   * Route one built submission and answer with what Core said.
   *
   * There is no "not delivered" answer: every accepted message reaches a
   * recipient, and a target no binding or Collaboration Space claims is the
   * Dispatcher Agent's conversation — as is one whose route turned out to be
   * stale or whose provisioning never produced a Team. `containerChatId` is
   * the parent chat a topic belongs to, which is what a Collaboration Space is
   * keyed by.
   */
  deliver(input: {
    target: FeishuTarget;
    containerChatId: string | null;
    submission: FeishuSubmission;
  }): Promise<FeishuSubmitOutcome>;
}
