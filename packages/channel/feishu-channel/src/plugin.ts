/**
 * The built-in Feishu plugin, always loaded by Dreamux.
 *
 * It contributes the Feishu channel provider under the name `feishu`, which
 * config addresses as `builtin:feishu`, and publishes the extension api. The
 * provider and the api share one extension registry, created here per plugin
 * object, so what another plugin registers is exactly what this provider's
 * catalog and sessions serve.
 */
import type { DreamuxPlugin } from '@excitedjs/dreamux-types';

import type { FeishuApi } from './extension.js';
import { FeishuExtensionRegistry } from './feishu-extensions.js';
import {
  buildFeishuChannelProvider,
  type CreateFeishuChannelProviderOptions,
} from './provider.js';

declare module '@excitedjs/dreamux-types' {
  interface DreamuxPluginApis {
    feishu: FeishuApi;
  }
}

export function createFeishuPlugin(
  options: CreateFeishuChannelProviderOptions = {},
): DreamuxPlugin {
  const extensions = new FeishuExtensionRegistry();
  const provider = buildFeishuChannelProvider(options, extensions);
  const api: FeishuApi = {
    extensions: { register: (extension) => extensions.register(extension) },
  };
  return {
    name: 'feishu',
    api,
    contribute(host) {
      host.channelProviders.contribute('feishu', provider);
    },
  };
}

/** The zero-argument plugin factory Dreamux's plugin loader calls. */
export default function feishuPluginFactory(): DreamuxPlugin {
  return createFeishuPlugin();
}
