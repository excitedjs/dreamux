import { loadConfig } from '../config/load.js';
import { validateDispatcherId } from '../platform/dispatcher-id.js';
import { npmPackageName } from '../plugin/resolve.js';
import { BUILTIN_CODEX_PROVIDER_REF } from '../registry/builtins.js';
import { formatProviderRef } from '../registry/provider-ref.js';
import { runOnboard, type RunOnboardOptions } from './run.js';
import type { OnboardRunResult } from './types.js';
import { answersFromOptions, promptText } from './wizard.js';

/**
 * `dreamux channel add <npm package name>`: onboarding for one Dispatcher
 * that carries one channel of a registered plugin. The answers are built and
 * written by the code `dreamux onboard` uses, with service registration off,
 * so the new Dispatcher and the provider's own configuration are asked and
 * checked the same way. Two things are this command's own: the registry is
 * the loaded configuration's, which holds the registered plugins, and an
 * existing Dispatcher id is refused, because onboarding replaces a Dispatcher
 * of the id it is given. An agent runtime id that already exists is updated
 * with what is answered, as under `dreamux onboard`.
 */
export async function addChannel(
  input: string,
  run: Omit<RunOnboardOptions, 'answers'> = {},
): Promise<OnboardRunResult & { dispatcher_id: string }> {
  if (process.stdin.isTTY !== true) {
    throw new Error(
      '`dreamux channel add` asks for the new Dispatcher and needs a terminal',
    );
  }
  const name = npmPackageName(input);
  const ref = `npm:${name}`;
  const loaded = await loadConfig();
  const plugin = loaded.plugins.find((entry) => entry.entry?.value.ref === ref);
  if (plugin === undefined) {
    throw new Error(
      `plugin ${ref} is not registered; run: dreamux plugin add ${name}`,
    );
  }
  const channelNames = plugin.providers
    .filter((provider) => provider.kind === 'channel')
    .map((provider) => provider.name);
  if (channelNames.length === 0) {
    throw new Error(`plugin ${ref} contributes no channel`);
  }
  const [only] = channelNames;
  const channel =
    only !== undefined && channelNames.length === 1
      ? only
      : await askChannel(channelNames, ref);
  const dispatcherId = validateDispatcherId(
    await promptText('new dispatcher id'),
  );
  if (loaded.config.dispatchers.some((entry) => entry.id === dispatcherId)) {
    throw new Error(
      `dispatcher ${dispatcherId} already exists; \`dreamux channel add\` creates a new Dispatcher and changes none`,
    );
  }
  const answers = await answersFromOptions(
    {
      dispatcherId,
      dispatcherCwd: await promptText('dispatcher cwd', process.cwd()),
      agent: await promptText(
        `agent runtime provider (${loaded.providerRegistry
          .listByKind('agentRuntime')
          .map((descriptor) => formatProviderRef(descriptor.ref))
          .join(', ')})`,
        BUILTIN_CODEX_PROVIDER_REF,
      ),
      channel: `builtin:${channel}`,
      registerService: false,
      startService: false,
    },
    true,
    loaded.providerRegistry,
  );
  const result = await runOnboard({ ...run, answers });
  return { ...result, dispatcher_id: dispatcherId };
}

async function askChannel(names: string[], ref: string): Promise<string> {
  const answer = (
    await promptText(`channel provider (${names.join(', ')})`)
  ).trim();
  if (!names.includes(answer)) {
    throw new Error(`plugin ${ref} contributes no channel "${answer}"`);
  }
  return answer;
}
