/**
 * Agent Runtime provider-authoring contracts (declaration-only).
 *
 * The neutral subset of the Agent Runtime contract that an external runtime
 * package needs to author against. Host-coupled shapes (the runtime create
 * context that today carries dispatcher rows/stores, the diagnostic context
 * that carries a `DispatcherConfig`, the live `AgentRuntime` handle whose status
 * type is a host enum) intentionally stay in `@excitedjs/dreamux` until the
 * runtime-split slices replace their host coupling with neutral sinks. This
 * package never exposes host-private types.
 */
import type { DreamuxLogger } from './logger.js';

export interface AgentRuntimeMcpServer {
  name: string;
  command: string;
  args: string[];
}

/** The role Dreamux core assigns to a runtime instance. */
export type AgentRuntimeRole =
  | 'dispatcher'
  | 'team_leader'
  | 'teammate'
  | 'team_member';

/**
 * A bundled skill source core hands to a runtime. Core selects sources by role;
 * the runtime package owns the mechanics of applying them to its engine.
 */
export interface AgentRuntimeSkillSource {
  name: string;
  path: string;
  layout: string;
  source: 'dreamux-core' | string;
}

/**
 * An open, source-agnostic completion delivery shape. Each runtime self-declares
 * its own `kind` string inside its own capabilities; the shared contract never
 * enumerates them.
 */
export interface CompletionDeliveryShape {
  kind: string;
  description: string;
}

export interface AgentRuntimeResumeCheckpoint {
  /** Runtime-owned checkpoint kind; each runtime self-declares its own. */
  kind: string;
  id: string;
}

export type AgentRuntimeResumeCapability =
  | { supported: true; checkpoint: AgentRuntimeResumeCheckpoint['kind'] }
  | { supported: false };

export interface AgentRuntimeCapabilities {
  /** Whether this runtime can resume a prior checkpoint, and which checkpoint id it expects. */
  resume: AgentRuntimeResumeCapability;
  /** Whether a follow-up turn can steer/fold into an active turn. */
  steer: { supported: boolean };
  /** How runtime events are surfaced to Dreamux. */
  events: { kind: 'push' | 'synthesized' };
  /** Whether the runtime can report the last assistant/user-visible result. */
  last: { supported: boolean };
  /** Whether the runtime can report context-window usage. */
  context: { supported: boolean };
  /**
   * How the launcher-supplied role/system prompt content is applied: `replace`
   * swaps the engine's base instructions, `append` adds to them.
   */
  systemPrompt: { mode: 'replace' | 'append' };
  /** Upward delivery shapes this runtime supports for teammate completion. */
  teammateCompletion: readonly CompletionDeliveryShape[];
}

/**
 * A source-agnostic completion delivered upward to a runtime. `teammate` is one
 * source; `id` identifies the completing entity within that source.
 */
export interface CompletionEnvelope {
  source: string;
  id: string;
  status: 'completed' | 'failed' | 'stopped';
  result: string;
}

export type TeamMateCompletionDeliveryResult =
  | { status: 'accepted' }
  | { status: 'unsupported'; reason: string }
  | { status: 'failed'; error: Error };

export interface AgentRuntimeSystemInput {
  kind: 'system';
  text: string;
  reason: 'restart-notice' | 'teammate-completion' | 'runtime-control';
}

export interface AgentRuntimeResumeInput {
  checkpoint?: AgentRuntimeResumeCheckpoint | null;
}

export interface AgentRuntimeLastResult {
  text: string | null;
}

export interface AgentRuntimeContextSnapshot {
  usedTokens: number | null;
  windowTokens: number | null;
}

export interface AgentRuntimePathContext {
  /**
   * The per-dispatcher root the runtime drops its own state files into.
   * Neutral: the runtime derives its own subpaths from here. Volatile
   * rendezvous sockets do NOT live here.
   */
  dispatcherDir(id: string): string;
  /** The runtime's primary-process stdout log file in the central logs tree. */
  stdoutLogPath(id: string): string;
  /** The runtime's primary-process stderr/diagnostic log file in the central logs tree. */
  stderrLogPath(id: string): string;
  /** The owning dispatcher's completion-spill directory in the cache tree. */
  completionSpillDir(id: string): string;
}

export interface AgentRuntimeProviderConfigReadContext {
  providerRef: string;
  /**
   * The `agents[].id` whose config block is being parsed — a config-internal
   * alias, not a dispatcher identity.
   */
  agentId: string;
  file: string;
  prefix: string;
}

/**
 * A neutral runtime-binary launch descriptor a provider declares for doctor.
 * Pure data — the provider never runs it itself.
 */
export interface AgentRuntimeBinCheck {
  name: string;
  bin: string;
  args: string[];
}

/**
 * The neutral result of a provider's own (non-bin) diagnostic pass. `detail` is
 * a one-line summary; `errors` are per-problem lines.
 */
export interface AgentRuntimeDoctorResult {
  ok: boolean;
  detail: string;
  errors: string[];
}

/**
 * The minimal command runner a provider's diagnostic needs. A structural subset
 * of the CLI's command runner so the provider never imports host CLI modules.
 */
export interface AgentRuntimeDiagnosticRunner {
  check(
    command: string,
    args: string[],
    options?: { env?: NodeJS.ProcessEnv },
  ): Promise<boolean>;
  capture(
    command: string,
    args: string[],
    options?: { env?: NodeJS.ProcessEnv },
  ): Promise<string>;
}

/** Re-export so provider packages can take a logger in their own contexts. */
export type { DreamuxLogger };
