import type { DispatcherCodexHomeDoctorResult } from '../runtime/dispatcher-codex-home.js';

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

export interface OnboardAnswers {
  configDir: string;
  runtimeDir: string;
  dispatcherId: string;
  dispatcherCwd: string;
  codexBin: string;
  botAppId: string;
  botAppSecret: string;
  registerService: boolean;
  startService: boolean;
  dreamuxBin: string;
  dryRun: boolean;
}

export interface OnboardRunResult {
  files: OnboardFileLedgerEntry[];
  doctor: DispatcherCodexHomeDoctorResult;
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
