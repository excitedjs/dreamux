import type { ProviderDiagnosticResult } from '@excitedjs/dreamux-types';
import type { ServicePlatform } from '../daemon/unit.js';
import type { FileLedgerEntry } from '../platform/file-ledger.js';
import type { ProviderDiagnosticReport } from '../provider-diagnostics.js';

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
  files: FileLedgerEntry[];
  doctor: OnboardDoctorResult;
  service: {
    platform: ServicePlatform;
    unitPath: string;
    registered: boolean;
    started: boolean;
    lingerEnabled: boolean | null;
    warnings: string[];
  } | null;
}
