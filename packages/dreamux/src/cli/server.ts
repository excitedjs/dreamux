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
import { installServerShutdown } from '../server/shutdown.js';
import { ConfigService } from '../config/service.js';
import { ProviderRegistry } from '../registry/registry.js';
import { startPlugins } from '../plugin/host.js';
import {
  createLogger,
  prepareLogDirectory,
  prepareLogFile,
} from '../platform/logger.js';
import { ensureOwnerOnlyDir } from '@excitedjs/dreamux-utils';
import {
  adminSocketLockPath,
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
  const providerRegistry = new ProviderRegistry();

  // Open ~/.dreamux/config.json before anything else starts. Missing or invalid
  // config is a setup error; `dreamux serve` must not silently create defaults.
  // The ConfigService is this process's single authority over config.json for
  // the rest of its life — every long-lived object that needs the current
  // config holds it, rather than a DreamuxConfig value read once here.
  const configService = await ConfigService.open({ providerRegistry });

  await mkdir(stateRoot(), { recursive: true });
  await prepareLogDirectory(logsRoot());
  await ensureOwnerOnlyDir(channelLogDir());
  await ensureOwnerOnlyDir(workflowLogDir());
  // Dispatcher IDs are fixed by the loaded config for this server lifetime.
  // Prepare their files before synchronous logger factories can write to them.
  await Promise.all(
    [
      serverLogPath(),
      ...configService
        .current()
        .dispatchers.flatMap(({ id }) => [
          channelLogPath(id),
          workflowLogPath(id),
        ]),
    ].map(prepareLogFile),
  );

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
    legacyAdminLockPath: adminSocketLockPath(legacyAdminSocketPath()),
  });
  const startup = server.start();
  installServerShutdown(server, startup, logger);
  await startup;
  logger.info({ admin_socket: adminSocketPath() }, 'server up');
}
