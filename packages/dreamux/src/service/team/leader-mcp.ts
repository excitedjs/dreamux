import { mustNonBlankString } from '../../command/payload.js';
import { runDelegateTool } from '../mcp/projection.js';
import { DESTRUCTIVE_ANNOTATIONS, tool } from '../mcp/tool-metadata.js';
import type { McpServerDelegate } from '../mcp/types.js';
import { dissolveReceiptSchema } from './requests.js';
import type { TeamDissolveCommand, TeamDissolveReceipt } from './types.js';

/** This Team owns access to its leader's dissolve tool and the full request. */
export function createLeaderTeamMcpDelegate(team: {
  admitLeaderTools<T>(operation: () => Promise<T>): Promise<T>;
  dissolve(input: TeamDissolveCommand): Promise<TeamDissolveReceipt>;
}): McpServerDelegate {
  const descriptor = tool(
    'dissolve',
    "Call this only when the Team's work is complete. Your system prompt names the Team's workspace and its cleanup mode. Under cleanup: delete-on-close Dreamux removes the managed worktree when the Team dissolves, so first check it for uncommitted, untracked, or unmerged work; if there is any, or you cannot tell, do not dissolve: report it and ask the user. Under cleanup: keep, and in a reused directory, nothing is removed and nothing blocks the dissolve. Submit a dissolve of this descriptor-bound Team. It returns a receipt as soon as the request is accepted ({ accepted, team_name, status: submitted }) and never reports how the dissolve went: the Team's Workflow, TeamMates, and this TeamLeader are stopped behind that receipt, so expect this call to lose its response. note is required and records why the Team stopped. A non-forced request checks the managed delete-on-close worktree before it accepts: uncommitted, untracked, or unmerged work is refused with the blocking reason, and the Team stays open and running. force: true only overrides a delete-on-close removal blocked by uncommitted, untracked, or unmerged work, by discarding that work; under cleanup: keep the checkout and its changes are retained; never the branch, its commits, a reused directory, or the source repository; deleting them is a separate decision that is the user's.",
    {
      note: {
        type: 'string',
        minLength: 1,
        maxLength: 2000,
        pattern: '\\S',
        description: 'Why the Team stops; recorded on it.',
      },
      force: {
        type: 'boolean',
        description:
          "Only with the user's explicit confirmation in this conversation. " +
          'It only overrides a delete-on-close removal blocked by ' +
          'uncommitted, untracked, or unmerged work, by discarding that ' +
          'work; under cleanup: keep the checkout and its changes are ' +
          'retained; never the branch, its commits, a reused directory, or ' +
          'the source repository.',
      },
    },
    ['note'],
    {
      title: 'Dissolve this Team',
      output: dissolveReceiptSchema(),
      annotations: DESTRUCTIVE_ANNOTATIONS,
    },
  );
  return {
    name: 'team',
    describe: () => ({ tools: [descriptor] }),
    call: (call) =>
      runDelegateTool(async () => {
        const note = mustNonBlankString(call.arguments, 'note');
        const force = call.arguments['force'] === true;
        const dissolved = await team.admitLeaderTools(() =>
          team.dissolve({ note, force }),
        );
        return { structured: dissolved };
      }),
  };
}
