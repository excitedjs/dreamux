import type { ProviderDiagnosticResult } from '@excitedjs/dreamux-types';
import type { ProviderDiagnosticReport } from '../provider-diagnostics.js';

export type OnboardFileStatus = 'created' | 'modified' | 'unchanged' | 'skipped';

export interface OnboardFileLedgerEntry {
  path: string;
  status: OnboardFileStatus;
  reason: string;
}

export interface OnboardFileLedger {
  entries(): OnboardFileLedgerEntry[];
  record(path: string, status: OnboardFileStatus, reason: string): void;
}

export type ServicePlatform = 'launchd' | 'systemd';

export interface OnboardAgentRuntimeConfig {
  id: string;
  provider: string;
  config: Record<string, unknown>;
}

export interface OnboardChannelConfig {
  id: string;
  provider: string;
  config: Record<string, unknown>;
}

export interface OnboardAnswers {
  configDir: string;
  dispatcherId: string;
  dispatcherCwd: string;
  agentRuntime: OnboardAgentRuntimeConfig;
  channels: OnboardChannelConfig[];
  registerService: boolean;
  startService: boolean;
  dreamuxBin: string;
  dryRun: boolean;
}

export interface OnboardDoctorResult extends ProviderDiagnosticResult {
  reports: ProviderDiagnosticReport[];
}

export interface OnboardRunResult {
  files: OnboardFileLedgerEntry[];
  doctor: OnboardDoctorResult;
  service:
    | {
        platform: ServicePlatform;
        unitPath: string;
        registered: boolean;
        started: boolean;
        lingerEnabled: boolean | null;
        warnings: string[];
      }
    | null;
}

export interface CommandRunner {
  run(
    command: string,
    args: string[],
    options?: {
      cwd?: string;
      env?: NodeJS.ProcessEnv;
      dryRun?: boolean;
    },
  ): Promise<void>;
  check(
    command: string,
    args: string[],
    options?: {
      cwd?: string;
      env?: NodeJS.ProcessEnv;
      dryRun?: boolean;
    },
  ): Promise<boolean>;
  capture(
    command: string,
    args: string[],
    options?: {
      cwd?: string;
      env?: NodeJS.ProcessEnv;
      dryRun?: boolean;
    },
  ): Promise<string>;
}
