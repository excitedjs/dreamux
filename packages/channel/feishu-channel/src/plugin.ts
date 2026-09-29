/**
 * The built-in Feishu plugin, always loaded by Dreamux.
 *
 * It contributes the Feishu channel provider under the name `feishu`, which
 * config addresses as `builtin:feishu`, and publishes the extension api. The
 * provider and the api share one extension registry, created here per plugin
 * object, so what another plugin registers is exactly what this provider's
 * catalog and sessions serve. `server()` captures this plugin's own state
 * directory (`ServerHost.stateDir`) for the extensions mechanism to root
 * itself under — see `feishu-extensions.ts`.
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
  // Filled by `server()`, read by an extension's session-level initialize —
  // always later, since core runs every plugin's `server` before the first
  // Dispatcher (and so the first channel session) exists. Same
  // supplier-resolved-later idiom as the dispatcher agent's own
  // `mcp: () => TeammateAgentMcp`: the value does not exist when this factory
  // runs, only by the time something actually calls the supplier.
  let pluginStateDir: string | undefined;
  const provider = buildFeishuChannelProvider(
    options,
    extensions,
    () => pluginStateDir,
  );
  const api: FeishuApi = {
    extensions: { register: (extension) => extensions.register(extension) },
  };
  return {
    name: 'feishu',
    api,
    contribute(host) {
      host.channelProviders.contribute('feishu', provider);
    },
    server(host) {
      pluginStateDir = host.stateDir;
    },
  };
}

/** The zero-argument plugin factory Dreamux's plugin loader calls. */
export default function feishuPluginFactory(): DreamuxPlugin {
  return createFeishuPlugin();
}
