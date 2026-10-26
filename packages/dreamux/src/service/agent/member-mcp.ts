/**
 * The ordinary-member MCP surface.
 *
 * A member has a different authority object from a Dispatcher or TeamLeader
 * delegate: it can only message its actual owner and the peers in its own
 * collection, so its tools and its receipt wording belong together here rather
 * than in the owner roster catalog. The server name is supplied by the entry
 * point in `mcp.ts`, which remains the one owner of the `teammate` identity.
 *
 * The member receipt reminder is deliberately not a dispatch reminder: a
 * member sender is never sent a completion push, so the text says only that
 * admission proves neither receipt nor execution.
 */
import { mustNonEmptyString } from '../../command/payload.js';
import { ValidationError } from '../../platform/errors.js';
import { STRING, arrayOf, objectSchema } from '../../command/schema.js';
import { AGENT_TASK_SOURCE } from '../submission-sources.js';
import {
  createToolRecordDelegate,
  submissionReceipt,
  type McpToolRecord,
} from '../mcp/projection.js';
import {
  MUTATING_ANNOTATIONS,
  READ_ONLY_ANNOTATIONS,
  tool,
} from '../mcp/tool-metadata.js';
import type { McpServerDelegate } from '../mcp/types.js';
import { toSubmissionResult } from './admission.js';
import { agentEntityNameParam } from './requests.js';
import {
  TEAMMATE_LIST_STATUSES,
  TEAMMATE_ROSTER_ROW_SCHEMA,
  teammateRosterPage,
} from './mcp-roster.js';
import { LIST_PAGE_PROPERTIES, listInputProperties } from '../mcp/list-page.js';
import type { TeammateSubmitInput } from './submission.js';
import type { TurnAdmission } from './turn.js';
import type { TeammateOps } from './types.js';

/** The actual conversational owner; no concrete Team/Dispatcher import. */
export interface TeamMateMessagingOwner {
  readonly teammates: Pick<TeammateOps, 'send' | 'list'>;
  memberOwner(): {
    name: string;
    role: string;
    status: string;
  };
  submitInput(
    input: Omit<TeammateSubmitInput, 'completionRecipient'>,
  ): Promise<TurnAdmission>;
}

/** The member-scoped view of one TeamMate server. */
export interface MemberMcpScope {
  readonly kind: 'member';
  readonly name: string;
  readonly owner: TeamMateMessagingOwner;
}

export function createMemberMcpDelegate(
  scope: MemberMcpScope,
  serverName: string,
): McpServerDelegate {
  return createToolRecordDelegate(serverName, memberToolRecords(scope));
}

const MEMBER_RECEIPT_REMINDER =
  "This is an admission receipt, not a response or completion. A reply arrives only if the recipient explicitly sends one. The recipient's applicable turn results are reported to its owner.";

function memberToolRecords(scope: MemberMcpScope): McpToolRecord[] {
  return [
    {
      descriptor: tool(
        'send',
        'Send a message to your owner or a same-collection peer by concrete name. A closed peer reopens its recorded session; idle input wakes the recipient and busy input follows its runtime admission. ' +
          MEMBER_RECEIPT_REMINDER,
        {
          name: { type: 'string', minLength: 1, maxLength: 64 },
          prompt: { type: 'string', minLength: 1, maxLength: 20000 },
        },
        ['name', 'prompt'],
        {
          title: 'Message your owner or a peer',
          annotations: MUTATING_ANNOTATIONS,
        },
      ),
      execute: async (args) => {
        const name = mustNonEmptyString(args, 'name');
        const prompt = mustNonEmptyString(args, 'prompt');
        if (name === scope.name)
          throw new ValidationError('A member cannot send to itself');
        const attrs = { from: scope.name };
        const owner = scope.owner.memberOwner();
        const result =
          name === owner.name
            ? toSubmissionResult(
                await scope.owner.submitInput({
                  source: AGENT_TASK_SOURCE,
                  text: prompt,
                  attrs,
                  notice: {
                    kind: 'teammate_message',
                    producer: scope.name,
                  },
                }),
              )
            : await scope.owner.teammates.send({
                name: agentEntityNameParam(args, 'name'),
                prompt,
                attrs,
              });
        return submissionReceipt(
          result,
          'Message submitted.\n\n' + MEMBER_RECEIPT_REMINDER,
        );
      },
    },
    {
      descriptor: tool(
        'list',
        'Discover your owner address and a page of same-collection peers. Defaults to non-closed peers; use status all or closed for recovery. You are excluded from peers and totals; the owner is always returned separately.',
        listInputProperties(TEAMMATE_LIST_STATUSES),
        [],
        {
          title: 'List your owner and peers',
          output: objectSchema(
            {
              owner: objectSchema({ name: STRING, status: STRING }, [
                'name',
                'status',
              ]),
              teammates: arrayOf(TEAMMATE_ROSTER_ROW_SCHEMA),
              ...LIST_PAGE_PROPERTIES,
            },
            ['owner', 'teammates', 'total', 'next_cursor'],
          ),
          annotations: READ_ONLY_ANNOTATIONS,
        },
      ),
      execute: async (args) => {
        const peers = await scope.owner.teammates.list();
        const { name, status } = scope.owner.memberOwner();
        return {
          structured: {
            owner: { name, status },
            ...teammateRosterPage(
              peers,
              args,
              (peer) => peer.name === scope.name,
            ),
          },
        };
      },
    },
  ];
}
