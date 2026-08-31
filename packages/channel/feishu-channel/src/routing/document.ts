/**
 * The durable shape of one Feishu session's routing authority.
 *
 * Core supplies a per-dispatcher state root and nothing else: the filename,
 * the schema, and what counts as a valid document are this Channel's to
 * decide. What it holds is final product fact only — the Collaboration Space
 * policies an operator registered, and the target bindings that were actually
 * installed. Work in flight is deliberately absent: automatic provisioning is
 * process-local and may be lost outright, and after a restart a target no
 * binding claims is simply an unmatched target, which reaches the Dispatcher
 * Agent like any other.
 *
 * The two sections share one file because they are one consistency domain — a
 * space policy is what entitles a binding to be installed, and a Team closing
 * removes the bindings that named it. Splitting them would only invent a
 * cross-file transaction.
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
 * `origin` records who is entitled to remove this row without an operator
 * saying so: a `manual` row is an explicit decision and only an explicit
 * `unbind_channel` or a Team closing takes it away, while a `space` row is the
 * default binding automatic provisioning installed for one child target.
 */
export interface FeishuBindingRecord {
  target: FeishuTargetRecord;
  display: string | null;
  team_name: string;
  origin: 'manual' | 'space';
  space_id: string | null;
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
 *
 * `generation` names the current policy snapshot: it advances whenever the
 * policy is rebound with different creation facts, so an operator can see
 * which revision a Team was created under. It cancels nothing. A creation
 * already under way keeps the snapshot it captured; only a creation that
 * starts after the update sees the new one.
 */
export interface FeishuSpaceRecord {
  space_id: string;
  space_name: string;
  container_chat_id: string;
  display: string | null;
  generation: number;
  leader_agent_runtime: string;
  identity: string | null;
  repo: FeishuSpaceRepoPolicy | null;
  created_at: number;
  updated_at: number;
}

export interface FeishuRoutingDocument {
  version: typeof FEISHU_ROUTING_DOCUMENT_VERSION;
  dispatcher_id: string;
  channel_id: string;
  bindings: FeishuBindingRecord[];
  spaces: FeishuSpaceRecord[];
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
    updated_at: input.now,
  };
}
