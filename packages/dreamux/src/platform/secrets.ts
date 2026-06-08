import { dispatcherFeishuConfig, type DreamuxConfig } from '../config/config.js';

export function resolveBotSecret(ref: string, config: DreamuxConfig): string {
  if (ref.startsWith('config:')) {
    const dispatcherId = ref.slice('config:'.length);
    const dispatcher = config.dispatchers.find((item) => item.id === dispatcherId);
    if (dispatcher === undefined) {
      throw new Error(
        `missing Feishu app_secret in dreamux config for bot_secret_ref=${ref}`,
      );
    }
    const feishu = dispatcherFeishuConfig(dispatcher);
    if (feishu.app_secret.trim() === '') {
      throw new Error(
        `missing Feishu app_secret in dreamux config for bot_secret_ref=${ref}`,
      );
    }
    return feishu.app_secret;
  }

  if (ref.startsWith('env:')) {
    const varName = ref.slice('env:'.length);
    const value = process.env[varName];
    if (value === undefined || value === '') {
      throw new Error(
        `bot secret env var '${varName}' is not set (referenced by bot_secret_ref=${ref})`,
      );
    }
    return value;
  }

  throw new Error(
    `unsupported bot_secret_ref scheme: ${ref}. Use config:<dispatcherId>.`,
  );
}
