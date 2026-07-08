/**
 * Provider reference and descriptor shapes.
 *
 * Declaration-only structural contracts shared between Dreamux core and external
 * provider packages. Parsing, validation, and the in-process registry are
 * runtime concerns owned by `@excitedjs/dreamux`; this package exposes only the
 * shapes so providers can be authored without depending on the host.
 */

/** Where a provider's implementation comes from. */
export type ProviderRefSource = 'builtin' | 'npm';

/** A bundled, first-party provider selected by id, e.g. `builtin:codex`. */
export interface BuiltinProviderRef {
  source: 'builtin';
  /** Bundled provider id, e.g. `codex` or `claude-code`. */
  id: string;
  /** The original, canonical string form. */
  raw: string;
}

/**
 * An external provider selected by npm package, optionally narrowed to a named
 * export.
 */
export interface NpmProviderRef {
  source: 'npm';
  /** npm package name, e.g. `@example/dreamux-provider` or `some-provider`. */
  package: string;
  /** Named export within the package, or null for the package default. */
  export: string | null;
  /** The original, canonical string form. */
  raw: string;
}

export type ProviderRef = BuiltinProviderRef | NpmProviderRef;

/** Kinds of provider the registry can hold. */
export type ProviderKind = 'channel' | 'agentRuntime';

/** A registered provider descriptor. Capabilities live on provider instances. */
export interface ProviderDescriptor {
  /** Stable registry id; builtin providers use their builtin id. */
  id: string;
  kind: ProviderKind;
  ref: ProviderRef;
}

/** A descriptor narrowed to the Agent Runtime kind. */
export type AgentRuntimeProviderDescriptor = ProviderDescriptor & {
  kind: 'agentRuntime';
};

/** A descriptor narrowed to the Channel kind. */
export type ChannelProviderDescriptor = ProviderDescriptor & {
  kind: 'channel';
};

/**
 * A Dreamux-owned environment map: variable name → value (or `undefined` when
 * unset). Declaration-only and host-neutral so provider packages never reference
 * a Node process-env typings global in their public surface — this is the
 * sanctioned neutral env shape (issue #209 public-types audit, P0).
 */
export type DreamuxEnvironment = Record<string, string | undefined>;

/** Shared diagnostic scope for checks run in the current shell vs service env. */
export type ProviderDiagnosticScope = 'foreground' | 'managedService';

/**
 * A provider-owned binary launch descriptor. Pure data: providers
 * declare it, Dreamux core deduplicates and executes it with its own runner.
 */
export interface ProviderBinCheck {
  name: string;
  bin: string;
  args: string[];
}

/**
 * The result of a provider's own diagnostic pass. `detail` is a one-line
 * summary; `errors` are per-problem lines.
 */
export interface ProviderDiagnosticResult {
  ok: boolean;
  detail: string;
  errors: string[];
}

/**
 * The minimal command runner a provider diagnostic needs. A structural subset
 * of the host's command runner so providers never import host CLI modules.
 */
export interface ProviderDiagnosticRunner {
  check(
    command: string,
    args: string[],
    options?: { env?: DreamuxEnvironment },
  ): Promise<boolean>;
  capture(
    command: string,
    args: string[],
    options?: { env?: DreamuxEnvironment },
  ): Promise<string>;
}

export interface ProviderOnboardTextPrompt {
  message: string;
  initialValue?: string;
  required?: boolean;
}

export interface ProviderOnboardSecretPrompt {
  message: string;
  initialValue?: string;
  required?: boolean;
}

export interface ProviderOnboardConfirmPrompt {
  message: string;
  initialValue: boolean;
}

/**
 * Host-owned prompt functions exposed to provider onboarding. Providers decide
 * which fields to ask for; core owns the concrete CLI UI and file writes.
 */
export interface ProviderOnboardPromptHost {
  text(input: ProviderOnboardTextPrompt): Promise<string>;
  secret(input: ProviderOnboardSecretPrompt): Promise<string>;
  confirm(input: ProviderOnboardConfirmPrompt): Promise<boolean>;
}

export interface ProviderOnboardContext {
  providerRef: string;
  providerId: string;
  env: DreamuxEnvironment;
  interactive: boolean;
}

/**
 * Optional provider-owned onboarding. It returns the raw config block Dreamux
 * should write; config validation still goes through the provider's `readConfig`
 * during normal config load.
 */
export interface ProviderOnboard<TConfig = unknown> {
  collect(
    context: ProviderOnboardContext,
    prompts: ProviderOnboardPromptHost,
  ): TConfig | Promise<TConfig>;
}

/**
 * The context Dreamux core hands a provider package's factory export. Mirrors the
 * core loader's call exactly — the canonical `ref` and the seed `descriptor` the
 * provider must echo back on its own `descriptor`. `TDescriptor` lets kind-
 * specific factory aliases carry the already-narrowed descriptor kind.
 */
export interface ProviderFactoryContext<
  TDescriptor extends ProviderDescriptor = ProviderDescriptor,
> {
  /** Canonical provider ref, e.g. `npm:some-pkg#provider` or `builtin:codex`. */
  ref: string;
  /** Seed descriptor the provider must echo back on its own `descriptor`. */
  descriptor: TDescriptor;
}

/**
 * A provider package's factory export (default export, or the named export a
 * `npm:pkg#export` ref selects). Dreamux core invokes it with a
 * {@link ProviderFactoryContext} and registers the returned provider.
 */
export type ProviderFactory<
  TProvider,
  TDescriptor extends ProviderDescriptor = ProviderDescriptor,
> = (
  context: ProviderFactoryContext<TDescriptor>,
) => TProvider | Promise<TProvider>;
