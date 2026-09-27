/**
 * `dreamux serve`'s implementation: {@link runServe} runs in-process inside
 * the `dreamux` CLI process — `cli/commands/serve.ts` calls it directly, no
 * child process involved. It logs to stderr for a foreground run.
 *
 * Configuration sources:
 *   - ~/.dreamux/config.json — named agents[], dispatcher declarations, and
 *     channel secrets; each dispatcher's channel lives under
 *     dispatchers[].channels[] and its runtime is a named agents[] entry
 *     referenced via dispatchers[].agentRuntime
 *   - built-in defaults compiled into the binary
 *
 * Plugins (the optional top-level plugins[] plus the always-loaded built-in
 * plugins) load and contribute providers inside ConfigService.open; their
 * `server` entries run once the file logger exists, before the Server is
 * constructed, so every host hook is tapped before the first Dispatcher exists.
 *
 * Per-dispatcher channel secrets live in the dreamux JSON config.
 */

import { mkdir } from 'node:fs/promises';

import { Server } from '../server.js';
import { ConfigService } from '../config/service.js';
import { createBuiltinProviderRegistry } from '../registry/index.js';
import { startPlugins } from '../plugin/host.js';
import { createLogger } from '../platform/logger.js';
import { errorInfo } from '@excitedjs/dreamux-utils';
import {
  adminSocketPath,
  channelLogDir,
  channelLogPath,
  legacyAdminSocketPath,
  logsRoot,
  serverLogPath,
  stateRoot,
  workflowLogDir,
  workflowLogPath,
} from '../platform/paths.js';
import { sweepRuntimeSocketDirs } from '../platform/runtime-sockets.js';

export async function runServe(): Promise<void> {
  // Hand an empty registry to ConfigService.open, which loads plugins first —
  // contributing codex/claude-code/feishu, the always-loaded built-ins, each
  // with its descriptor and implementation registered together — then loads
  // any npm:-ref provider agents[]/channels[] name, before parsing them (each
  // entry's config is parsed through its provider's readConfig, so the
  // implementation must be present first). The populated registry then backs
  // the Server's runtime + channel catalogs (Server builds them from it).
  const providerRegistry = createBuiltinProviderRegistry();

  // Open ~/.dreamux/config.json before anything else starts. Missing or invalid
  // config is a setup error; `dreamux serve` must not silently create defaults.
  // The ConfigService is this process's single authority over config.json for
  // the rest of its life — every long-lived object that needs the current
  // config holds it, rather than a DreamuxConfig value read once here.
  const configService = await ConfigService.open({ providerRegistry });

  await mkdir(stateRoot(), { recursive: true });
  await mkdir(logsRoot(), { recursive: true });
  await mkdir(channelLogDir(), { recursive: true });
  await mkdir(workflowLogDir(), { recursive: true });

  // The CLI is the only constructor of file-backed loggers; everything else
  // (tests) gets stderr-only defaults. Both stream to stderr too, so a
  // foreground `serve` stays visible.
  const logger = createLogger({ name: 'server', filePath: serverLogPath() });
  logger.info({ config_file: configService.file }, 'loaded global config');
  const { hooks } = startPlugins(configService.plugins, logger);

  const server = new Server({
    config: configService,
    providerRegistry,
    hooks,
    logger,
    channelLoggerFactory: (id) =>
      createLogger({ name: `channel/${id}`, filePath: channelLogPath(id) }),
    workflowLoggerFactory: (id) =>
      createLogger({ name: `workflow/${id}`, filePath: workflowLogPath(id) }),
    runtimeSocketSweep: () => sweepRuntimeSocketDirs(),
    legacyAdminLockPath: `${legacyAdminSocketPath()}.lock`,
  });
  await server.start();
  logger.info({ admin_socket: adminSocketPath() }, 'server up');

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'received signal');
    await server.shutdown();
    process.exit(0);
  };
  const requestShutdown = (signal: string): void => {
    void shutdown(signal).catch((error: unknown) => {
      logger.error(
        { signal, err: errorInfo(error) },
        'server shutdown failed; process remains fenced for teardown retry',
      );
    });
  };
  process.on('SIGTERM', () => requestShutdown('SIGTERM'));
  process.on('SIGINT', () => requestShutdown('SIGINT'));
}
