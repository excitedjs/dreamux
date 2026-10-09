/**
 * The Activity domain (declaration-only): what a runtime reports about what an
 * agent did, in two distinct contracts.
 *
 * `RuntimeActivity` (with its `NativeActivity`/`RuntimeToolAction` support
 * types) is the live, per-provider-detailed stream a runtime pushes through
 * {@link AgentRuntimeActivitySink} while a turn is running. `AgentActivityRecord`
 * (with `AgentActivityQuery`/`AgentActivityPage`/`AgentActivityReadContext`/
 * `AgentActivityError`) is the neutral, minimal contract
 * {@link AgentRuntimeProvider.readRecentActivity} replays from a cold
 * session/rollout file. The two are deliberately not unified: a provider folds
 * many submissions into one native turn, so live activity carries per-call
 * detail (arguments, results, native ids) a cold replay never reconstructs,
 * while a cold read exposes only the minimal shape every provider can honestly
 * replay after the live runtime is gone. This module holds both because they
 * are the same domain — what an agent did — read through the runtime's two
 * different lifecycles, separate from `agent-runtime.ts`'s concern of
 * launching and running a native session at all.
 */
import type { JsonValue } from './json.js';
import type { DreamuxLogger } from './logger.js';

/**
 * What a tool invocation does, classified by the runtime that owns the tool
 * vocabulary. `null` means the runtime has no such classification for this call.
 */
export type RuntimeToolAction =
  'read' | 'list_files' | 'search' | 'edit' | 'run';

/** A live fact identified by the native object it reports. */
interface NativeActivity<K extends string> {
  readonly kind: K;
  readonly occurredAt: number;
  /**
   * The provider's own id, taken whole without a prefix, suffix, or counter.
   * It identifies the native object, not a unique activity: a tool's start
   * and result share its call id; usage and interruption share a turn id.
   * A consumer derives row identity from kind (and tool status) plus this id.
   */
  readonly id: string;
}

/**
 * One thing an agent's runtime did, in the runtime's own vocabulary.
 *
 * Keyed on the agent and nothing else. A provider folds any number of Dreamux
 * submissions into one native turn, so an activity cannot honestly name the
 * submission that caused it — and inventing one would make a display pick an
 * arbitrary member. What a live surface needs is this agent's stream in order,
 * which is what this is.
 *
 * A Channel receives this same type with every text and JSON payload member
 * already redacted by Core. Core bounds nothing: each surface applies its
 * own display limits where it sends.
 */
export type RuntimeActivity =
  | (NativeActivity<'assistant.message'> & {
      readonly text: string;
    })
  /**
   * The runtime compacted its context. Carries no summary or compaction
   * metadata. Live-only: the cold activity reader never produces this.
   */
  | NativeActivity<'context.compacted'>
  /**
   * A display marker, not a terminal: a native turn stopped at an interrupt
   * request. Reported from the native interrupted terminal, before its
   * `token.usage` (when available) and paired `turn.ended` with status
   * `interrupted`. Teardown reports `turn.ended` `interrupted` without this
   * marker. Live-only: the cold activity reader never produces this.
   */
  | NativeActivity<'turn.interrupted'>
  | (NativeActivity<'tool.call'> & {
      readonly toolName: string;
      readonly action: RuntimeToolAction | null;
      /**
       * The call as the runtime's own UI labels it, in one line: a command's
       * stated purpose, the path a file tool touches, the pattern a search
       * runs, the task a sub-agent was given. `null` when the runtime has no
       * label of its own for the tool, so a display falls back to the name.
       */
      readonly summary: string | null;
      /**
       * The call as a person would write it: the shell command line, the
       * task text handed to a sub-agent, the script a runner executes.
       * `arguments` is the tool's full structured input; this is the one
       * member of it that has a notation of its own, so a display can show
       * it in that notation instead of as JSON. `null` when there is none.
       */
      readonly invocation: string | null;
      /**
       * What the call is about, one entry per item, as the runtime reported
       * it in structured members of the call: the path a file tool reads or
       * writes, the paths of a patch, the files a parsed shell command read.
       * Not limited to files: a runtime lists whatever discrete things its
       * protocol names for the call. Empty when it names none; never
       * recovered from a label or an output by parsing.
       */
      readonly items: readonly string[];
      readonly status: 'started' | 'completed' | 'failed';
      readonly arguments: JsonValue | null;
      readonly result: JsonValue | null;
      readonly error: string | null;
    })
  /**
   * The native runtime's cumulative token counters for its live session,
   * at the turn they were observed for. Runners that fold several native
   * turns into one provider turn emit once on the native terminal with the
   * latest snapshot, so one activity stands for one turn.
   *
   * Values are session-total as the runtime owns them, never turn deltas:
   * a consumer derives a turn's consumption by differencing against the
   * previous snapshot for this agent. The runtime keeps no history and
   * performs no subtraction. Live-only: the cold activity reader never
   * replays this, and a dropped snapshot simply widens the next delta.
   */
  | (NativeActivity<'token.usage'> & {
      readonly inputTokens: number;
      readonly outputTokens: number;
      /** The last response's context footprint, and the native window when the runtime reports one; `null` when the runtime gives no context signal. */
      readonly context: {
        readonly usedTokens: number;
        readonly windowTokens: number | null;
      } | null;
    })
  | {
      /**
       * The runtime stopped producing for the turn it was running, whatever
       * that turn contained. `completed` is the runtime's own successful
       * terminal; `failed` is a proven terminal error; `interrupted` is a
       * native turn that ended without either, such as a stop or a protocol
       * loss. `reason` carries the runtime's own explanation when it holds
       * one, so a display can say why rather than only that.
       * A native interrupt also reports `turn.interrupted` before this end.
       *
       * Core also reports this for an input no runtime accepted, because that
       * input opened a display that nothing else closes.
       *
       * A provider reports this from the native terminal it observed, and
       * again, without asking whether a turn was open, when it tears down a
       * live native session. It keeps no display state to answer that
       * question, so a consumer may receive an end with nothing open and
       * ignores it: a native end closes an open display and never opens one.
       */
      readonly kind: 'turn.ended';
      readonly occurredAt: number;
      readonly status: 'completed' | 'failed' | 'interrupted';
      readonly reason: string | null;
    };

/**
 * A bounded request for the recent tail of one session's activity. Cursors are
 * opaque and provider-owned; pagination walks a stable recent tail without
 * skipping or duplicating records as native history grows.
 */
export interface AgentActivityQuery {
  readonly sessionId: string;
  readonly cursor?: string;
  readonly limit?: number;
  /** Tools are included by default and can only be hidden as a group. */
  readonly includeTools?: boolean;
}

export interface AgentActivityReadContext<TConfig> {
  readonly config: TConfig;
  readonly cwd: string;
  readonly logger: DreamuxLogger;
}

/**
 * One neutral activity fact. Tool arguments, tool results, provider-native
 * lines, Core status, admission, and settlement never appear here.
 */
export type AgentActivityRecord =
  | {
      readonly kind: 'assistant_message';
      readonly text: string;
      readonly occurredAt?: string;
    }
  | {
      readonly kind: 'tool';
      readonly name: string;
      readonly status: 'started' | 'completed' | 'failed';
      readonly occurredAt?: string;
    };

/** One chronological page of recent Activity Records. */
export interface AgentActivityPage {
  readonly records: readonly AgentActivityRecord[];
  readonly nextCursor?: string;
  /** Set by the provider when its own native read bounds truncated the page. */
  readonly truncated: boolean;
}

/**
 * Structural shape of the `Error` a provider rejects an Activity read with.
 * Reasons describe neutral states only: never a filesystem path, native history
 * layout, or scan mode. Callers branch on `error.name` rather than
 * `instanceof`, keeping this package declaration-only.
 */
export interface AgentActivityError extends Error {
  name: 'AgentActivityError';
  reason:
    | 'session_unavailable'
    | 'cursor_invalid'
    | 'activity_corrupt'
    | 'provider_failure';
}
