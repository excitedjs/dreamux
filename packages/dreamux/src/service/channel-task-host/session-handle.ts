import type {
  ChannelTaskHost,
  ChannelTaskHostCapability,
  ChannelTaskHostScope,
} from '@excitedjs/dreamux-types';

export interface TaskHostSessionHandleOptions {
  fence: string;
  scope: Omit<ChannelTaskHostScope, 'session_fence'>;
  assertActive: (fence: string) => void;
  negotiate: ChannelTaskHost['negotiate'];
  applyContainerManifest: ChannelTaskHost['applyContainerManifest'];
  submit: ChannelTaskHost['submit'];
  lookupSubmission: ChannelTaskHost['lookupSubmission'];
  cancel: ChannelTaskHost['cancel'];
  snapshot: ChannelTaskHost['snapshot'];
  replay: ChannelTaskHost['replay'];
  acknowledgeHostEvents: ChannelTaskHost['acknowledgeHostEvents'];
}

export const TASK_HOST_CAPABILITIES = [
  'durable_task_submission_v1',
  'host_event_stream_v1',
  'durable_container_manifest_v1',
  'resource_lifecycle_v1',
  'logical_repository_binding_v1',
] as const satisfies readonly ChannelTaskHostCapability[];

export function taskHostRequiredCapabilities(
  repositorySource: 'static' | 'channel',
): ChannelTaskHostCapability[] {
  return [
    'durable_task_submission_v1',
    'host_event_stream_v1',
    'durable_container_manifest_v1',
    'resource_lifecycle_v1',
    ...(repositorySource === 'channel'
      ? ['logical_repository_binding_v1' as const]
      : []),
  ];
}

export function createTaskHostSessionHandle(
  options: TaskHostSessionHandleOptions,
): ChannelTaskHost {
  const call = <Args extends unknown[], Result>(
    operation: (...args: Args) => Promise<Result>,
  ): ((...args: Args) => Promise<Result>) => (...args) =>
    Promise.resolve().then(() => {
      options.assertActive(options.fence);
      return operation(...args);
    });
  return {
    scope: { ...options.scope, session_fence: options.fence },
    negotiate: call(options.negotiate),
    applyContainerManifest: call(options.applyContainerManifest),
    submit: call(options.submit),
    lookupSubmission: call(options.lookupSubmission),
    cancel: call(options.cancel),
    snapshot: call(options.snapshot),
    replay: call(options.replay),
    acknowledgeHostEvents: call(options.acknowledgeHostEvents),
  };
}
