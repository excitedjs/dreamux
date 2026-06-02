export type DispatcherStatus =
  | 'declared'
  | 'starting'
  | 'ready'
  | 'degraded'
  | 'stopping'
  | 'stopped';

export type InboundState =
  | 'queued'
  | 'running'
  | 'awaiting_outbound'
  | 'completed'
  | 'outbound_failed'
  | 'failed'
  | 'unknown';

export interface DispatcherRow {
  dispatcher_id: string;
  bot_app_id: string;
  bot_secret_ref: string;
  codex_args_json: string;
  codex_cwd: string | null;
  thread_id: string | null;
  status: DispatcherStatus;
  enabled: 0 | 1;
  created_at: number;
  updated_at: number;
  last_started_at: number | null;
  last_ready_at: number | null;
  last_error: string | null;
  last_lost_thread_id: string | null;
}

export interface InboundRow {
  id: number;
  dispatcher_id: string;
  source_chat_id: string;
  source_message_id: string | null;
  sender_id: string | null;
  feishu_event_json: string;
  parsed_text: string;
  state: InboundState;
  codex_turn_id: string | null;
  assistant_text: string | null;
  feishu_message_ids_json: string | null;
  outbound_error: string | null;
  received_at: number;
  started_at: number | null;
  completed_at: number | null;
  failed_at: number | null;
  error: string | null;
}

export interface DispatcherCreateInput {
  dispatcher_id: string;
  bot_app_id: string;
  bot_secret_ref: string;
  codex_args_json?: string;
  codex_cwd?: string | null;
}

export interface InboundCreateInput {
  dispatcher_id: string;
  source_chat_id: string;
  source_message_id: string | null;
  sender_id: string | null;
  feishu_event_json: string;
  parsed_text: string;
}
