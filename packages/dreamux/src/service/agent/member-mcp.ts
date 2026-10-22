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
import {
  mustNonEmptyString,
  type CommandPayload,
} from '../../command/payload.js';
import { ValidationError } from '../../platform/errors.js';
import { STRING, arrayOf, objectSchema } from '../../command/schema.js';
import { AGENT_TASK_SOURCE } from '../submission-sources.js';
import { runDelegateTool, type McpToolSuccess } from '../mcp/projection.js';
import {
  MUTATING_ANNOTATIONS,
  READ_ONLY_ANNOTATIONS,
  tool,
  type McpToolDescriptor,
} from '../mcp/tool-metadata.js';
import type {
  McpDelegateCall,
  McpDelegateDescription,
  McpDelegateResult,
  McpServerDelegate,
} from '../mcp/types.js';
import { toSubmissionResult } from './admission.js';
import { agentEntityNameParam } from './requests.js';
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

/** One peer row: the same compact roster shape the owner scan publishes. */
const MEMBER_ROSTER_ROW_SCHEMA = objectSchema(
  {
    name: STRING,
    status: STRING,
    agent_runtime: STRING,
    intent: { type: ['string', 'null'] },
  },
  ['name', 'status', 'agent_runtime', 'intent'],
);

/** One tool this delegate advertises, paired with the handler that serves it. */
interface MemberMcpToolRecord {
  readonly descriptor: McpToolDescriptor;
  readonly execute: (args: CommandPayload) => Promise<McpToolSuccess>;
}

export function createMemberMcpDelegate(
  scope: MemberMcpScope,
  serverName: string,
): McpServerDelegate {
  const records = memberToolRecords(scope);
  const tools = records.map((record) => record.descriptor);
  return {
    name: serverName,
    describe(): McpDelegateDescription {
      return { tools };
    },
    call(call: McpDelegateCall): Promise<McpDelegateResult> {
      return runDelegateTool(() => serve(records, call));
    },
  };
}

async function serve(
  records: readonly MemberMcpToolRecord[],
  call: McpDelegateCall,
): Promise<McpToolSuccess> {
  const record = records.find(
    (candidate) => candidate.descriptor.name === call.name,
  );
  return record!.execute(call.arguments as CommandPayload);
}

const MEMBER_RECEIPT_REMINDER =
  "This is an admission receipt, not a response or completion. A reply arrives only if the recipient explicitly sends one. The recipient's applicable turn results are reported to its owner.";

function memberToolRecords(scope: MemberMcpScope): MemberMcpToolRecord[] {
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
        return {
          structured: {
            status: result.status,
            ...(result.error !== undefined ? { error: result.error } : {}),
          },
          ...(result.status === 'submitted'
            ? { text: MEMBER_RECEIPT_REMINDER }
            : {}),
        };
      },
    },
    {
      descriptor: tool(
        'list',
        'Discover your owner address and same-collection peers, including closed peers. You are excluded from the peer rows.',
        {},
        [],
        {
          title: 'List your owner and peers',
          output: objectSchema(
            {
              owner: objectSchema({ name: STRING, status: STRING }, [
                'name',
                'status',
              ]),
              teammates: arrayOf(MEMBER_ROSTER_ROW_SCHEMA),
            },
            ['owner', 'teammates'],
          ),
          annotations: READ_ONLY_ANNOTATIONS,
        },
      ),
      execute: async () => {
        const peers = await scope.owner.teammates.list();
        const { name, status } = scope.owner.memberOwner();
        return {
          structured: {
            owner: { name, status },
            teammates: peers
              .filter((peer) => peer.name !== scope.name)
              .map(({ name, status, agent_runtime, intent }) => ({
                name,
                status,
                agent_runtime,
                intent,
              })),
          },
        };
      },
    },
  ];
}
