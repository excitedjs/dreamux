/**
 * The durable shape of one Feishu session's routing authority.
 *
 * Core supplies a per-dispatcher state root and nothing else: the filename,
 * the schema, and what counts as a valid document are this Channel's to
 * decide. What it holds is final product fact only — the Collaboration Space
 * policies an operator registered, the target bindings that were actually
 * installed, and the documents a recipient asked to follow. Work in flight is
 * deliberately absent: automatic provisioning is
 * process-local and may be lost outright, and after a restart a target no
 * binding claims is simply an unmatched target, which reaches the Dispatcher
 * Agent like any other.
 *
 * The three sections share one file because they are one consistency domain — a
 * space policy is what entitles a binding to be installed, and a Team closing
 * removes the bindings that named it and the documents it followed in the same
 * commit. Splitting them would only invent a cross-file transaction.
 *
 * There is no migration path. A document from an incompatible version fails
 * loud and the operator recreates the bindings through the Channel's own MCP
 * tools, exactly as the cutover requires.
 */
import type { FeishuTargetKind } from './target.js';

export const FEISHU_ROUTING_DOCUMENT_VERSION = 1;

export interface FeishuTargetRecord {
  kind: FeishuTargetKind;
  chat_id: string;
  thread_id?: string;
}

/**
 * `root_message_id` is the visible message a topic-kind binding's own
 * conversation replies under. A Channel-authored card for a topic (a binding
 * notice, a route-removal notice) replies to it instead of guessing a landing
 * place. Automatic provisioning sets it at bind time; a topic bound through a
 * path with no message id to hand (an MCP `bind_channel` naming a topic this
 * session never saw, an extension's `bindTeam`) or written before roots were
 * persisted starts with `null` and is filled once, by the first message
 * accepted in the topic or by a notice that had to ask the platform. It is
 * always `null` for a `group`/`p2p` binding, which has no single "root"
 * message.
 */
export interface FeishuBindingRecord {
  target: FeishuTargetRecord;
  display: string | null;
  team_name: string;
  space_id: string | null;
  root_message_id: string | null;
  created_at: number;
  updated_at: number;
}

export interface FeishuSpaceRepoPolicy {
  path: string;
  base_ref: string | null;
}

/**
 * A registered Feishu container whose child targets are provisioned
 * automatically.
 */
export interface FeishuSpaceRecord {
  space_id: string;
  space_name: string;
  container_chat_id: string;
  display: string | null;
  leader_agent_runtime: string;
  identity: string | null;
  repo: FeishuSpaceRepoPolicy | null;
  created_at: number;
  updated_at: number;
}

/**
 * One recipient following one document's comments.
 *
 * `team_name` is `null` for the Dispatcher Agent, the same way a submission
 * omits the target to reach it. The pair `(file_token, team_name)` is the key:
 * it is what makes "a recipient only ever writes its own row" structural rather
 * than a check, and two recipients following one document hold two rows.
 *
 * No title is stored. What the metadata read at subscribe time establishes is
 * permission, and the document's own name is something the agent reads with the
 * same lark-cli call that gets it the comment.
 */
export interface FeishuDocSubscriptionRecord {
  file_token: string;
  file_type: string;
  /** The Team that receives it, or null for the Dispatcher Agent. */
  team_name: string | null;
  created_at: number;
}

/**
 * The one rule the binding and space sections owe each other.
 *
 * **A chat that a Collaboration Space is registered on carries no `group`
 * binding row, and a chat carrying a `group` binding row has no Collaboration
 * Space registered on it.** A `group` row answers resolution for every topic
 * under that chat — a topic falls back to its parent group before anything is
 * provisioned — so the two together mean the Space silently stops giving new
 * topics their own Team, and nothing reports it.
 *
 * Only `group` rows do this. A `topic` row answers for its own topic and
 * nothing else, which is exactly the row automatic provisioning installs, so
 * a Space and its provisioned topics coexist by design.
 *
 * Both writes that could break the rule refuse instead, each inside its own
 * commit: `FeishuRouting.bind` for the binding side, `FeishuRouting.bindSpace`
 * for the space side. Neither can be reached without passing the other's
 * check, which is why the invariant is stated here once rather than in either
 * of them.
 */
export interface FeishuRoutingDocument {
  version: typeof FEISHU_ROUTING_DOCUMENT_VERSION;
  dispatcher_id: string;
  channel_id: string;
  bindings: FeishuBindingRecord[];
  spaces: FeishuSpaceRecord[];
  subscriptions: FeishuDocSubscriptionRecord[];
  updated_at: number;
}

export function emptyRoutingDocument(input: {
  dispatcherId: string;
  channelId: string;
  now: number;
}): FeishuRoutingDocument {
  return {
    version: FEISHU_ROUTING_DOCUMENT_VERSION,
    dispatcher_id: input.dispatcherId,
    channel_id: input.channelId,
    bindings: [],
    spaces: [],
    subscriptions: [],
    updated_at: input.now,
  };
}
