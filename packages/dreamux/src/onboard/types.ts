import type { DispatcherCodexHomeDoctorResult } from '../runtime/dispatcher-codex-home.js';

export type OnboardFileStatus = 'created' | 'modified' | 'unchanged';

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
  codexBin: string;
  codexModel: string;
  codexProvider: string;
  authEnvVar: string;
  codexMarketplaceSource: string;
  codexMarketplaceSparse: string[];
  codexMarketplaceName: string;
  codexPluginRef: string;
  claudeBin: string;
  claudeConfigDir: string;
  claudeMarketplaceSource: string;
  claudeMarketplaceSparse: string[];
  claudeMarketplaceName: string;
  claudePluginRef: string;
  botAppId: string;
  botSecretRef: string;
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
