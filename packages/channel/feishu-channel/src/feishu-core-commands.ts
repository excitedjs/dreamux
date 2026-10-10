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
  type FeishuCommandSubmitOutcome,
  type FeishuSubmissionPayload,
} from './feishu-submit.js';

/**
 * The wire payload one submit Command shares: attrs, faithful text, an
 * optional trailing reminder (an empty string is exactly an omitted one), and
 * the source id Core deduplicates on. `teamSubmit` spreads `team_name` onto
 * this; `dispatcherSubmit` sends it as-is.
 */
function submitCommandPayload(
  submission: FeishuSubmissionPayload,
): SubmitCommand {
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
  invoker: JsonInvoker,
  command: 'team.submit' | 'dispatcher.submit',
  payload: SubmitCommand & { team_name?: string },
): Promise<FeishuCommandSubmitOutcome> {
  try {
    const raw = await invoker.invoke(command, payload as unknown as JsonValue);
    return submitOutcome(raw as unknown as TeamSubmitResult);
  } catch (err) {
    const code = commandErrorCode(err);
    return code === 'TEAM_NOT_FOUND' || code === 'TEAM_CLOSED'
      ? { status: 'rejected', code, message: errorMessage(err) }
      : { status: 'error', message: errorMessage(err) };
  }
}

export class FeishuCoreCommands implements JsonInvoker {
  private invoker: JsonInvoker | undefined;

  initialize(invoker: JsonInvoker): void {
    this.invoker = invoker;
  }

  invoke(command: string, payload: JsonValue): Promise<JsonValue> {
    if (this.invoker === undefined) {
      return Promise.reject(
        new Error('Feishu channel session has no Core port'),
      );
    }
    return this.invoker.invoke(command, payload);
  }

  async teamCreate(command: TeamCreateCommand): Promise<TeamSummary> {
    return (await this.invoke(
      'team.create',
      command as unknown as JsonValue,
    )) as unknown as TeamSummary;
  }
  async teamStatus(teamName: string): Promise<TeamSummary> {
    return (await this.invoke('team.status', {
      team_name: teamName,
    })) as unknown as TeamSummary;
  }
  teamSubmit(
    teamName: string,
    submission: FeishuSubmissionPayload,
  ): Promise<FeishuCommandSubmitOutcome> {
    return submitOutcomeFor(this, 'team.submit', {
      team_name: teamName,
      ...submitCommandPayload(submission),
    });
  }
  dispatcherSubmit(
    submission: FeishuSubmissionPayload,
  ): Promise<FeishuCommandSubmitOutcome> {
    return submitOutcomeFor(
      this,
      'dispatcher.submit',
      submitCommandPayload(submission),
    );
  }
  async teamDissolve(input: { teamName: string; note: string }): Promise<void> {
    await this.invoke('team.dissolve', {
      team_name: input.teamName,
      note: input.note,
    });
  }
  async teamInterrupt(teamName: string): Promise<AgentRuntimeInterruptOutcome> {
    return (await this.invoke('team.interrupt', {
      team_name: teamName,
    })) as unknown as AgentRuntimeInterruptOutcome;
  }
  async dispatcherInterrupt(): Promise<AgentRuntimeInterruptOutcome> {
    return (await this.invoke(
      'dispatcher.interrupt',
      {},
    )) as unknown as AgentRuntimeInterruptOutcome;
  }
  async teamList(): Promise<readonly RunningTeamRow[]> {
    const raw = (await this.invoke('team.list', {})) as unknown as {
      teams: RunningTeamRow[];
    };
    return raw.teams;
  }
}
