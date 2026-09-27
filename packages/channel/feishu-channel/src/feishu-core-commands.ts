/**
 * A typed façade over the Core Commands this package calls.
 *
 * `port.invoke` hands and returns untyped JSON; every caller used to build its
 * own payload and cast its own answer, which is how a Team's shape ended up
 * re-cast in four different files. This is a leaf over `port.invoke` — no
 * lifecycle, no COT, no routing state — with one method per Command this
 * package actually calls, so the payload shape and the result cast for a
 * given Command live in exactly one place.
 */
import type {
  AgentRuntimeInterruptOutcome,
  JsonInvoker,
  JsonValue,
  SubmitCommand,
  TeamCreateCommand,
  TeamSubmitResult,
  TeamSummary,
} from '@excitedjs/dreamux-types';

import type { RunningTeamRow } from './cards/running-teams.js';
import {
  commandErrorCode,
  errorMessage,
  submitOutcome,
  type FeishuSubmission,
  type FeishuSubmitOutcome,
} from './feishu-submit.js';

export interface FeishuCoreCommands {
  teamCreate(command: TeamCreateCommand): Promise<TeamSummary>;
  teamStatus(teamName: string): Promise<TeamSummary>;
  /**
   * Submit to a Team's TeamLeader. Both submit Commands share one wire shape
   * and one outcome — including a thrown pre-admission rejection — so one
   * function reads Core's answer into the `FeishuSubmitOutcome` every
   * delivery path already branches on.
   */
  teamSubmit(
    teamName: string,
    submission: FeishuSubmission,
  ): Promise<FeishuSubmitOutcome>;
  /** Submit to the addressed Dispatcher's own Agent; no Team is named. */
  dispatcherSubmit(submission: FeishuSubmission): Promise<FeishuSubmitOutcome>;
  /** The submitted dissolve receipt is never read; nothing is returned. */
  teamDissolve(input: { teamName: string; note: string }): Promise<void>;
  teamInterrupt(teamName: string): Promise<AgentRuntimeInterruptOutcome>;
  dispatcherInterrupt(): Promise<AgentRuntimeInterruptOutcome>;
  teamList(): Promise<readonly RunningTeamRow[]>;
}

/**
 * The wire payload one submit Command shares: attrs, faithful text, an
 * optional trailing reminder (an empty string is exactly an omitted one), and
 * the source id Core deduplicates on. `teamSubmit` spreads `team_name` onto
 * this; `dispatcherSubmit` sends it as-is.
 */
function chatSubmission(submission: FeishuSubmission): SubmitCommand {
  return {
    attrs: submission.attrs,
    text: submission.text,
    ...(submission.reminder !== '' ? { reminder: submission.reminder } : {}),
    source_id: submission.sourceId,
  };
}

/**
 * Both submit Commands answer the same receipt, or fail with the same
 * pre-admission rejection thrown as an error. Reading either into one outcome
 * is what "a typed Core client" means for a submission: the cast happens
 * once, here, not once per delivery path.
 */
async function submitOutcomeFor(
  invoke: JsonInvoker['invoke'],
  command: 'team.submit' | 'dispatcher.submit',
  payload: SubmitCommand & { team_name?: string },
): Promise<FeishuSubmitOutcome> {
  try {
    const raw = await invoke(command, payload as unknown as JsonValue);
    return submitOutcome(raw as unknown as TeamSubmitResult);
  } catch (err) {
    const code = commandErrorCode(err);
    return code === 'TEAM_NOT_FOUND' || code === 'TEAM_CLOSED'
      ? { status: 'rejected', code, message: errorMessage(err) }
      : { status: 'error', message: errorMessage(err) };
  }
}

export function createFeishuCoreCommands(
  invoke: JsonInvoker['invoke'],
): FeishuCoreCommands {
  return {
    async teamCreate(command) {
      return (await invoke(
        'team.create',
        command as unknown as JsonValue,
      )) as unknown as TeamSummary;
    },
    async teamStatus(teamName) {
      return (await invoke('team.status', {
        team_name: teamName,
      })) as unknown as TeamSummary;
    },
    teamSubmit(teamName, submission) {
      return submitOutcomeFor(invoke, 'team.submit', {
        team_name: teamName,
        ...chatSubmission(submission),
      });
    },
    dispatcherSubmit(submission) {
      return submitOutcomeFor(
        invoke,
        'dispatcher.submit',
        chatSubmission(submission),
      );
    },
    async teamDissolve(input) {
      await invoke('team.dissolve', {
        team_name: input.teamName,
        note: input.note,
      });
    },
    async teamInterrupt(teamName) {
      return (await invoke('team.interrupt', {
        team_name: teamName,
      })) as unknown as AgentRuntimeInterruptOutcome;
    },
    async dispatcherInterrupt() {
      return (await invoke(
        'dispatcher.interrupt',
        {},
      )) as unknown as AgentRuntimeInterruptOutcome;
    },
    async teamList() {
      const raw = (await invoke('team.list', {})) as unknown as {
        teams: RunningTeamRow[];
      };
      return raw.teams;
    },
  };
}
