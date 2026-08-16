/**
 * Filesystem layout for dreamux-owned runtime state, volatile run files, and
 * logs.
 *
 * Effective layout (issue #182 PR-1 split durable state from volatile run
 * files):
 *   ~/.dreamux/
 *     run/                    volatile IPC/control artifacts; safe to clear
 *                             when no dreamux server is running
 *       admin.sock            admin control socket (+ admin.sock.lock)
 *       restart-intent.json   one-shot daemon restart marker
 *       sockets/              fallback root for runtime rendezvous sockets
 *                             (see platform/runtime-sockets.ts)
 *     state/                  durable server-owned state
 *       <dispatcher-id>/      (issue #233 symmetric layout)
 *         access.json
 *         chat-bots.json
 *         channel-bindings.json
 *         collaboration-spaces.json
 *         teammate/<name>/    dispatcher-owned teammate identity
 *         team/<team>/        one dir per team: leader identity,
 *                             record.json, teammate/<name>/ members
 *     logs/
 *       dreamux-server.log
 *       codex-app-server/
 *         <dispatcher-id>.log
 *       channel/
 *         <dispatcher-id>.log
 *     cache/                  rebuildable provider/cache artifacts
 *       <dispatcher-id>/
 *         spill/
 *         <provider-owned subdirs>
 *
 * `stateRoot()` is the single root for dreamux-owned durable state; `runRoot()`
 * is the single root for dreamux-owned volatile run files. The old
 * `runtime_dir` concept (and its `runtimeRoot()` alias) was retired in issue #98.
 */

import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assertUnixSocketPathBudget,
} from '@excitedjs/dreamux-utils';

import {
  BUILT_IN_DEFAULTS,
  type DreamuxConfig,
} from '../config/config.js';
import { pathExists } from './fs-errors.js';
import { validateDispatcherId } from '../state/dispatcher-id.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = dirname(dirname(HERE));

export const BUNDLED_SKILL_NAMES = [
  'dispatcher-workflow',
  'dreamux-maintenance',
  'team-workflow',
  'workflow',
] as const;

export type BundledSkillName = typeof BUNDLED_SKILL_NAMES[number];

let currentConfig: DreamuxConfig = BUILT_IN_DEFAULTS;

/**
 * Set the active configuration snapshot. Called once by Server.start() with
 * the result of loadConfig(); tests can call it to inject a custom snapshot.
 * Idempotent.
 */
export function setRuntimeConfig(config: DreamuxConfig): void {
  currentConfig = config;
}

/** Test hook: revert to the built-in defaults. */
export function resetRuntimeConfig(): void {
  currentConfig = BUILT_IN_DEFAULTS;
}

export function getRuntimeConfig(): DreamuxConfig {
  return currentConfig;
}

/**
 * The dreamux home root. Overridable via the `DREAMUX_ROOT` environment variable
 * so tests (or custom deployments) can redirect durable state into an isolated
 * directory without hijacking `process.env.HOME`.
 */
export function dreamuxRoot(): string {
  const override = process.env['DREAMUX_ROOT'];
  if (override !== undefined && override !== '') return override;
  return join(homedir(), '.dreamux');
}

/** Lexical containment: is `candidate` at or under `root` (both resolved)? */
function pathIsAtOrUnder(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

/**
 * True when `path` resolves to, or inside, the dreamux home root (`~/.dreamux`).
 * Lexical only — symlinks are not caught; use {@link isRealPathUnderDreamuxRoot}
 * for the placement guard. Managed worktree creation must fail loud rather than
 * place a worktree under Dreamux's own state/run/cache tree (issue #182 PR-4).
 */
export function isUnderDreamuxRoot(path: string): boolean {
  return pathIsAtOrUnder(dreamuxRoot(), path);
}

/** realpath, falling back to a lexical resolve when the path does not exist. */
async function canonicalPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return resolve(path);
  }
}

/**
 * Symlink-safe variant of {@link isUnderDreamuxRoot} (issue #182 PR-4, #186):
 * canonicalizes both the root and `path` with `realpath` before the containment
 * check, so a workspace that symlinks into `~/.dreamux` is still rejected.
 */
export async function isRealPathUnderDreamuxRoot(path: string): Promise<boolean> {
  const [realRoot, realPath] = await Promise.all([
    canonicalPath(dreamuxRoot()),
    canonicalPath(path),
  ]);
  return pathIsAtOrUnder(realRoot, realPath);
}

export function stateRoot(): string {
  return join(dreamuxRoot(), 'state');
}

/**
 * Root for dreamux-owned volatile run files: IPC sockets, lock files, and
 * one-shot control markers. Nothing under it is durable; it is safe to remove
 * while no dreamux server is running. Durable state stays under `stateRoot()`.
 */
export function runRoot(): string {
  return join(dreamuxRoot(), 'run');
}

/**
 * One-shot marker dropped by `dreamux daemon restart --notify-resumed` before
 * it triggers the service-manager restart. The freshly started server reads it
 * once, deletes it, and injects a "restart completed" notice into the named
 * resumed dispatchers. Volatile run file; safe to delete.
 */
export function restartIntentPath(): string {
  return join(runRoot(), 'restart-intent.json');
}

export function logsRoot(): string {
  return join(dreamuxRoot(), 'logs');
}

/**
 * Root for dreamux-owned cache: rebuildable, droppable artifacts that are
 * neither durable state nor volatile run files (issue #182 PR-2). Holds
 * per-dispatcher completion spill files and inbound attachment caches. Safe to
 * remove while no server is running; nothing here is part of identity, status,
 * history, or checkpoint recovery.
 */
export function cacheRoot(): string {
  return join(dreamuxRoot(), 'cache');
}

export function dispatcherCacheDir(id: string): string {
  return join(cacheRoot(), dispatcherPathSegment(id));
}

/**
 * Per-dispatcher completion-spill directory (issue #182 PR-2): where an
 * over-budget teammate completion result is written so only its path is inlined
 * into the dispatcher turn. Cache, not state — the file is read by no process;
 * it is surfaced to the dispatcher model as text and is safe to delete.
 */
export function dispatcherCompletionSpillDir(id: string): string {
  return join(dispatcherCacheDir(id), 'spill');
}

/**
 * The stable cross-process admin IPC endpoint. Packaged CLI commands and MCP
 * shims resolve it through this builder only — it is a fixed path contract, so
 * an over-budget path (extreme $HOME length) fails loudly instead of moving.
 */
export function adminSocketPath(): string {
  return assertUnixSocketPathBudget(
    join(runRoot(), 'admin.sock'),
    'admin socket path',
  );
}

/**
 * The pre-#182 admin socket location, under durable state. PR-1 moved the live
 * admin socket to `run/admin.sock`; this builder exists only so a new server
 * can detect a still-running OLD-version server (which locks the legacy path)
 * and fail loud — see `assertNoLegacyAdminServer`. Detection only: dreamux
 * never removes or migrates the legacy file.
 */
export function legacyAdminSocketPath(): string {
  return join(stateRoot(), 'admin.sock');
}

export function dispatcherDir(id: string): string {
  return join(stateRoot(), dispatcherPathSegment(id));
}

export function defaultDispatcherCwd(id: string): string {
  return join(dispatcherDir(id), 'cwd');
}

/** The package-shipped bundled skill root (issue #209). */
export function bundledSkillsDir(): string {
  return join(PACKAGE_ROOT, 'skills');
}

/** Compiled entry point forked for each Dynamic Workflow run. */
export function workflowRunnerEntryPath(): string {
  return join(PACKAGE_ROOT, 'dist', 'service', 'workflow-service', 'runner.js');
}

export function bundledDispatcherSkillRoot(): string {
  return join(bundledSkillsDir(), 'dispatcher');
}

export function bundledTeamLeaderSkillRoot(): string {
  return join(bundledSkillsDir(), 'team-leader');
}

export function bundledSharedSkillRoot(): string {
  return join(bundledSkillsDir(), 'shared');
}

/**
 * Packaged changelog files, shipped inside the installed package so that
 * `dreamux changelog` is an offline, deterministic read of the *installed*
 * version's release notes. Both files are rush-generated; they must stay in
 * `package.json` `files` or these paths resolve outside the published tarball.
 */
export function packagedChangelogMarkdownPath(): string {
  return join(PACKAGE_ROOT, 'CHANGELOG.md');
}

export function packagedChangelogJsonPath(): string {
  return join(PACKAGE_ROOT, 'CHANGELOG.json');
}

export function serverLogPath(): string {
  return join(logsRoot(), 'dreamux-server.log');
}

export function channelLogDir(): string {
  return join(logsRoot(), 'channel');
}

/** Per-dispatcher channel log: gate decisions, inbound, outbound, introduce. */
export function channelLogPath(id: string): string {
  return join(channelLogDir(), `${dispatcherPathSegment(id)}.log`);
}

export function channelMcpLogDir(): string {
  return join(logsRoot(), 'channel-mcp');
}

/**
 * Per-dispatcher channel MCP stdio shim log. The shim's stdout is the JSON-RPC
 * transport, so its diagnostics persist here (and to stderr) — never stdout.
 */
export function channelMcpLogPath(id: string): string {
  return join(channelMcpLogDir(), `${dispatcherPathSegment(id)}.log`);
}

export function teammateMcpLogDir(): string {
  return join(logsRoot(), 'teammate-mcp');
}

/**
 * Per-dispatcher TeamMate scheduling MCP stdio shim diagnostics. */
export function teammateMcpLogPath(id: string): string {
  return join(teammateMcpLogDir(), `${dispatcherPathSegment(id)}.log`);
}

export function workflowLogDir(): string {
  return join(logsRoot(), 'workflow');
}

/** Per-dispatcher Dynamic Workflow lifecycle diagnostics. */
export function workflowLogPath(id: string): string {
  return join(workflowLogDir(), `${dispatcherPathSegment(id)}.log`);
}

export function cronMcpLogDir(): string {
  return join(logsRoot(), 'cron-mcp');
}

/** Per-dispatcher scheduled-tasks MCP stdio shim diagnostics. */
export function cronMcpLogPath(id: string): string {
  return join(cronMcpLogDir(), `${dispatcherPathSegment(id)}.log`);
}

/**
 * Per-dispatcher agent-collection root (issue #233 symmetric layout): the
 * `teammate/` directory whose immediate children are one directory per
 * dispatcher-owned teammate. Listing the collection is a blind `readdir` of this
 * dir, so it must hold ONLY entity directories — the dispatcher agent's own
 * pair and channel bindings live elsewhere.
 */
export function dispatcherTeamMateDir(id: string): string {
  return join(dispatcherDir(id), 'teammate');
}

/**
 * Per-dispatcher Team Mode collection root (issue #233): the `team/` directory
 * whose immediate children are one directory per team. Like `teammate/` it holds
 * ONLY entity directories (channel bindings moved to the dispatcher root).
 */
export function dispatcherTeamDir(id: string): string {
  return join(dispatcherDir(id), 'team');
}

/**
 * One team's root directory (issue #233 symmetric layout). Holds the team
 * leader's `identity.json` at its root, the team `record.json`,
 * and a `teammate/` sub-collection of the team's members.
 */
export function dispatcherTeamScopeDir(id: string, teamId: string): string {
  return join(dispatcherTeamDir(id), teamMateNameSegment(teamId));
}

/** A team's `record.json` — members, bound channel, leader name, … (issue #233). */
export function dispatcherTeamRecordPath(id: string, teamId: string): string {
  return join(dispatcherTeamScopeDir(id, teamId), 'record.json');
}

/**
 * A Team concrete-name claim. The claim is created before any Team or
 * collaboration-target side effect and is never removed, so a concrete name
 * cannot be reused after failure, shutdown, dissolve, or process restart.
 */
export function dispatcherTeamNameClaimPath(id: string, teamId: string): string {
  return join(dispatcherTeamScopeDir(id, teamId), 'name-claim.json');
}

/** Per-TeamLeader cron jobs; path isolation keeps the job schema dispatcher-scoped. */
export function dispatcherTeamCronJobsPath(id: string, teamId: string): string {
  return join(dispatcherTeamScopeDir(id, teamId), 'cron-jobs.json');
}

/**
 * The `teammate/` sub-collection inside one team's scope — the team's members,
 * one directory each. Distinct from {@link dispatcherTeamMateDir} (dispatcher
 * scope); both are blind-scan collections of per-name entity directories.
 */
export function dispatcherTeamTeamMateDir(id: string, teamId: string): string {
  return join(dispatcherTeamScopeDir(id, teamId), 'teammate');
}

export interface WorkflowScopePathInput {
  dispatcherId: string;
  teamId: string | null;
}

export interface WorkflowRunPathInput extends WorkflowScopePathInput {
  runId: string;
}

export function validateWorkflowRunId(runId: string): string {
  if (!/^[a-z0-9-]+$/.test(runId)) {
    throw new Error(
      `invalid workflow run id ${JSON.stringify(runId)}: expected lowercase letters, digits, and '-'`,
    );
  }
  return runId;
}

/** The workflow collection root for one dispatcher or Team scope. */
export function workflowScopeDir(input: WorkflowScopePathInput): string {
  const ownerDir = input.teamId === null
    ? dispatcherDir(input.dispatcherId)
    : dispatcherTeamScopeDir(input.dispatcherId, input.teamId);
  return join(ownerDir, 'workflow');
}

/** Durable state directory for one Dynamic Workflow run. */
export function workflowRunDir(input: WorkflowRunPathInput): string {
  return join(workflowScopeDir(input), validateWorkflowRunId(input.runId));
}

export function workflowRunRecordPath(input: WorkflowRunPathInput): string {
  return join(workflowRunDir(input), 'record.json');
}

export function workflowRunJournalPath(input: WorkflowRunPathInput): string {
  return join(workflowRunDir(input), 'journal.jsonl');
}

export type AgentEntityRole =
  | 'dispatcher'
  | 'teammate'
  | 'team_leader'
  | 'team_member';

/**
 * The on-disk directory for one agent entity (issue #233 symmetric layout). The
 * `dispatcher` agent's pair sits at the dispatcher ROOT (not under `teammate/`),
 * so it is structurally outside the teammate/team blind-scan collections — the
 * `teammate.*` read chokepoints never enumerate it (issue #233 Phase 5). A
 * `team_leader` lives at its team root; a `team_member` under that team's
 * `teammate/<name>/`; an ordinary `teammate` under the dispatcher's
 * `teammate/<name>/`. Every entity directory holds `identity.json`.
 */
export function dispatcherAgentEntityDir(input: {
  dispatcherId: string;
  name: string;
  teamId: string | null;
  role: AgentEntityRole;
}): string {
  if (input.role === 'dispatcher') {
    return dispatcherDir(input.dispatcherId);
  }
  if (input.role === 'team_leader' && input.teamId !== null) {
    return dispatcherTeamScopeDir(input.dispatcherId, input.teamId);
  }
  if (input.role === 'team_member' && input.teamId !== null) {
    return join(
      dispatcherTeamTeamMateDir(input.dispatcherId, input.teamId),
      teamMateNameSegment(input.name),
    );
  }
  return join(
    dispatcherTeamMateDir(input.dispatcherId),
    teamMateNameSegment(input.name),
  );
}

/** `<entity-dir>/identity.json` — durable identity and runtime association. */
export function dispatcherAgentIdentityPath(input: {
  dispatcherId: string;
  name: string;
  teamId: string | null;
  role: AgentEntityRole;
}): string {
  return join(dispatcherAgentEntityDir(input), 'identity.json');
}

export function dispatcherChannelBindingsPath(id: string): string {
  return join(dispatcherDir(id), 'channel-bindings.json');
}

export function dispatcherCollaborationSpacesPath(id: string): string {
  return join(dispatcherDir(id), 'collaboration-spaces.json');
}

export function dispatcherCronJobsPath(id: string): string {
  return join(dispatcherDir(id), 'cron-jobs.json');
}

/**
 * Neutral teammate-name path segment sanitizer. Shared by the neutral
 * teammate-state builders here and by each builtin's teammate log-path builders.
 */
export function teamMateNameSegment(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]/g, '_');
}

export function dispatcherPathSegment(id: string): string {
  return validateDispatcherId(id);
}

// ---------------------------------------------------------------------------
// Managed-service PATH builder
//
// The managed Dreamux service runs under a minimal environment that does NOT
// inherit the operator's interactive shell PATH. Provider-owned bare binaries
// (a `local-agent` installed into $HOME/.local/bin, a Homebrew-installed tool, an
// nvm/pyenv shim, …) therefore must be explicitly placed on the service PATH
// and searched during the daemon-install preflight so the launched service
// resolves them.
//
// `buildServicePath` is the single source of truth for that PATH. It lives in
// platform/ (the neutral path builder) so onboard/service.ts only orchestrates
// the managed-service environment and never owns the home/PATH contract itself.
//
// Order (deduplicated while preserving first occurrence):
//   1. Stable Dreamux-owned dirs (selected Node bin dir, resolved provider bin
//      dirs, dreamux bin dir). These lead so the service always resolves the
//      exact binaries the orchestrator pinned, regardless of the session PATH.
//   2. The captured interactive-session PATH, in its original order. This is
//      the full PATH the operator ran `dreamux onboard` / `daemon install`
//      under, so binaries installed by nvm / pyenv / Homebrew / etc. resolve.
//   3. Fresh-install fallback dirs (XDG_BIN_HOME when set, $HOME/.local/bin,
//      and the portable platform system dirs). These cover a bare environment
//      that has no interactive session PATH yet.
//
// Invariants:
//   - Every helper takes its inputs explicitly ({ platform, homeDir, env }).
//     They never read process.env, process.platform, or os.homedir() — the
//     caller passes those values. This keeps the contract testable and prevents
//     the ambient environment from silently changing the service PATH.
//   - XDG_BIN_HOME is read from the passed env only. It is a widely-followed
//     convention among some installers (e.g. language-ecosystem tools) but is
//     NOT part of the formal XDG Base Directory specification; we honor it when
//     the caller supplies it and also keep the conventional $HOME/.local/bin.
//   - Results are ordered and de-duplicated. Earlier entries win. User-local and
//     portable system dirs are deterministic fallbacks. Optional Homebrew
//     prefixes are added only after an async presence probe at the orchestration
//     boundary, then captured for the whole install.
//   - No shell profile is read or written, brew --prefix is never executed, and
//     the interactive shell PATH is never mutated.
// ---------------------------------------------------------------------------

export interface ExecDirOptions {
  /** Platform selecting the conventional system dirs (darwin / linux). */
  platform: NodeJS.Platform;
  /** Home directory resolving $HOME/.local/bin. */
  homeDir: string;
  /**
   * Environment to read conventions from (currently XDG_BIN_HOME). Passed
   * explicitly by the caller; these helpers never read process.env.
   */
  env: NodeJS.ProcessEnv;
}

/**
 * The operator's user-local standard bin dirs, in priority order. When
 * XDG_BIN_HOME is set (in the passed env) and non-empty it is included first;
 * the conventional $HOME/.local/bin is always included. Both are kept so a
 * binary installed in either location resolves.
 */
export function userLocalBinDirs(options: ExecDirOptions): string[] {
  const dirs: string[] = [];
  const xdg = options.env['XDG_BIN_HOME'];
  if (typeof xdg === 'string' && xdg.trim() !== '') {
    dirs.push(xdg.trim());
  }
  dirs.push(join(options.homeDir, '.local', 'bin'));
  return dirs;
}

/**
 * Platform conventional system bin dirs (user-local dirs are NOT included here —
 * see {@link userLocalBinDirs}). These deterministic portable fallbacks do not
 * include optional Homebrew prefixes; {@link probeStandardExecDirs} adds the
 * platform candidate only when it exists.
 */
export function systemExecDirs(_platform: NodeJS.Platform): string[] {
  return ['/usr/local/bin', '/usr/bin', '/bin'];
}

/**
 * The full ordered, de-duplicated standard executable dirs for a platform: the
 * user-local bin dirs (see {@link userLocalBinDirs}) followed by the platform
 * conventional system dirs (see {@link systemExecDirs}). Used as the
 * fresh-install fallback dirs by {@link buildServicePath}.
 */
export function standardExecDirs(options: ExecDirOptions): string[] {
  return dedupeExecDirs([
    ...userLocalBinDirs(options),
    ...systemExecDirs(options.platform),
  ]);
}

export type ExecDirProbe = (path: string) => Promise<boolean>;

/**
 * Resolve the standard executable fallback list for one onboard/daemon-install
 * run. The portable fallbacks remain deterministic; the single platform
 * Homebrew candidate is added only when the async probe confirms it exists.
 *
 * Callers capture this result once and reuse it for provider resolution,
 * launch validation, and service rendering. That keeps the effective PATH
 * stable within one install even if the filesystem changes later.
 */
export async function probeStandardExecDirs(
  options: ExecDirOptions,
  probe: ExecDirProbe = pathExists,
): Promise<string[]> {
  const dirs = standardExecDirs(options);
  const homebrewDir = homebrewExecDir(options.platform);
  if (homebrewDir !== null && (await probe(homebrewDir))) {
    dirs.push(homebrewDir);
  }
  return dedupeExecDirs(dirs);
}

/**
 * Input for {@link buildServicePath} and {@link withServicePath}.
 */
export interface ServicePathInput {
  /**
   * Stable Dreamux-owned dirs that lead the PATH (selected Node bin dir,
   * resolved provider bin dirs, dreamux bin dir).
   */
  stableDirs: string[];
  /**
   * The captured interactive-session PATH (the full `env.PATH` string the
   * operator ran `dreamux onboard` / `daemon install` under). Its entries are
   * appended in original order after the stable dirs.
   */
  sessionPath: string;
  /**
   * Fresh-install fallback dirs (XDG_BIN_HOME / $HOME/.local/bin + portable
   * platform system dirs). Appended last so a bare environment still resolves.
   */
  fallbackDirs: string[];
}

/**
 * Build the managed-service PATH: stable Dreamux-owned dirs first, then the
 * captured session PATH in original order, then the fresh-install fallback
 * dirs. Deduplicated while preserving first occurrence. Never reads
 * process.env. This is the single source of truth for the service PATH order.
 */
export function buildServicePath(input: ServicePathInput): string {
  return dedupeExecDirs([
    ...input.stableDirs,
    ...input.sessionPath.split(delimiter),
    ...input.fallbackDirs,
  ]).join(delimiter);
}

/**
 * Return a copy of `env` with PATH set to {@link buildServicePath}. The
 * caller's env object (and process.env) is never mutated.
 */
export function withServicePath(
  env: NodeJS.ProcessEnv,
  input: ServicePathInput,
): NodeJS.ProcessEnv {
  return { ...env, PATH: buildServicePath(input) };
}

/**
 * Return a copy of `env` with PATH augmented so bare provider/agent binaries
 * resolve against the standard executable dirs during `dreamux onboard` and
 * `dreamux daemon install`. It places the captured session PATH (in original
 * order) ahead of the fresh-install fallback dirs (XDG_BIN_HOME /
 * $HOME/.local/bin + portable platform system dirs), matching the order
 * {@link buildServicePath} persists into the service unit — so the
 * daemon-install preflight and the running service agree.
 *
 * Stable Dreamux-owned dirs (Node bin, provider bin dirs, dreamux bin) are NOT
 * included here: at resolve time the Node bin is not yet selected and the
 * dreamux bin dir is computed separately. Those are added when the service PATH
 * is rendered (see `managedServicePath` in onboard/service.ts). Pass
 * `extraDirs` to lead the PATH with explicit actual dirs (e.g. a resolved
 * provider bin dir).
 *
 * The caller's env (and process.env) is never mutated; platform/homeDir/env are
 * passed explicitly by the caller and these helpers never read process.env.
 * XDG_BIN_HOME is a widely-followed convention (NOT part of the formal XDG Base
 * Directory spec); it is honored alongside $HOME/.local/bin so binaries in
 * either location resolve.
 */
export function withStandardExecPath(
  env: NodeJS.ProcessEnv,
  options: ExecDirOptions & { extraDirs?: string[] },
): NodeJS.ProcessEnv {
  const sessionPath = env['PATH'] ?? '';
  const fallbackDirs = standardExecDirs(options);
  return withServicePath(env, {
    stableDirs: options.extraDirs ?? [],
    sessionPath,
    fallbackDirs,
  });
}

function homebrewExecDir(platform: NodeJS.Platform): string | null {
  if (platform === 'darwin') return '/opt/homebrew/bin';
  if (platform === 'linux') return '/home/linuxbrew/.linuxbrew/bin';
  return null;
}

function dedupeExecDirs(values: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (value === '' || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}
