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
import type {
  FeishuSlashCommandInvocation,
  FeishuSlashCommandReply,
} from './feishu-slash-commands.js';
import type { FeishuTarget } from './routing/target.js';

/**
 * The standing note appended once after the envelope Core assembles.
 *
 * It states the consequence this Channel owns and the model cannot see: in a
 * Feishu chat, assistant text never reaches the human, so only a `reply` call
 * does. Every channel words its own, so it is passed as `reminder` and Core
 * renders it as the final `<reminder>` sibling. The Channel no longer spells
 * the tag itself.
 */
export const CHANNEL_REMINDER =
  'The user in this chat sees only what you send through the reply tool; your assistant text is not shown to them.';

/**
 * The standing note for a turn a document comment woke.
 *
 * The chat reminder would be false here: the `reply` tool has no target in a
 * document, and no tool on this Channel writes a comment. That consequence is
 * the whole of it. Everything else about the comment is already on the
 * envelope Core renders, and what to do with it is the receiving agent's
 * decision, not a procedure this Channel teaches.
 */
export const DOC_COMMENT_REMINDER =
  'This turn came from a comment on a Feishu document, not from a chat. ' +
  'The reply tool does not reach that document; lark-cli reads and writes document comments.';

/**
 * The same note for a comment no subscription claims.
 *
 * It adds the one fact a cold open has and a subscribed delivery does not:
 * nothing here follows this document, so the recipient has no standing reason
 * to be reading it and the mention is the whole of why it was delivered here.
 * The sentence is only true on the path that checks `mentionedBot`, which is
 * the only path that carries it.
 */
export const DOC_COMMENT_COLD_OPEN_REMINDER =
  `${DOC_COMMENT_REMINDER} ` +
  'No recipient is subscribed to this document; it reached you because the comment @-mentioned this bot.';

interface FeishuSubmissionBase {
  readonly attrs: Readonly<Record<string, string>>;
  readonly text: string;
  readonly reminder: string;
  /** The identity Core deduplicates a repeat on. */
  readonly sourceId: string;
}

/**
 * One submission, in one of the two shapes this Channel can produce.
 *
 * It is a union rather than one shape with a nullable anchor because the anchor
 * is not optional information — it is what separates a turn the operator can
 * already see in a chat from one that happened in a document. A nullable field
 * would let a later caller forget the branch and open a chain-of-thought card
 * with nowhere to hang it; a union does not compile.
 */
export type FeishuSubmission =
  | (FeishuSubmissionBase & {
      readonly kind: 'chat';
      /** The visible Feishu message this turn's presentation hangs under. */
      readonly anchor: VisibleMessageAnchor;
    })
  | (FeishuSubmissionBase & { readonly kind: 'doc_comment' });

/** A submission that came from a chat, and therefore carries a visible anchor. */
export type FeishuChatSubmission = Extract<FeishuSubmission, { kind: 'chat' }>;

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
 * The mapping is the whole of what a submission result means here: some
 * outcomes prove the optimistic Channel anchor must be retired, while an
 * ambiguous result proves nothing and leaves it unchanged.
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

export function submissionProvesNoAdmission(outcome: FeishuSubmitOutcome): boolean {
  return outcome.status === 'rejected' ||
    outcome.status === 'failed' ||
    outcome.status === 'stopped';
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
  command(input: {
    command: FeishuSlashCommandInvocation;
    target: FeishuTarget;
    containerChatId: string | null;
  }): Promise<FeishuSlashCommandReply>;
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
    submission: FeishuChatSubmission;
  }): Promise<FeishuSubmitOutcome>;
}
