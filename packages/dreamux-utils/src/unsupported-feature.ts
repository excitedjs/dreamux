import type { UnsupportedAgentRuntimeFeatureError } from '@excitedjs/dreamux-types';

export function unsupportedFeatureError(
  feature: string,
  message: string,
): UnsupportedAgentRuntimeFeatureError {
  return Object.assign(new Error(message), {
    name: 'UnsupportedAgentRuntimeFeatureError' as const,
    feature,
  });
}

export function isUnsupportedFeatureError(
  error: unknown,
  feature?: string,
): error is UnsupportedAgentRuntimeFeatureError {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { name?: unknown; feature?: unknown };
  return candidate.name === 'UnsupportedAgentRuntimeFeatureError' &&
    typeof candidate.feature === 'string' &&
    (feature === undefined || candidate.feature === feature);
}
