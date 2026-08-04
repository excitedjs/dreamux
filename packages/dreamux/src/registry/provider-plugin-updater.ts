import { errMessage } from './provider-loader.js';

export const PROVIDER_PLUGIN_UPDATE_INTERVAL_MS = 4 * 60 * 60 * 1000;
interface ProviderPluginUpdateStore {
  checkForUpdate(packageName: string, signal?: AbortSignal): Promise<void>;
  nextUpdateDelay(packages: readonly string[]): Promise<number>;
}

export class ProviderPluginUpdater {
  private timer: NodeJS.Timeout | null = null;
  private flight: Promise<void> | null = null;
  private abortController: AbortController | null = null;
  private closed = false;

  constructor(
    private readonly store: ProviderPluginUpdateStore,
    private readonly packages: readonly string[],
    private readonly warn: (message: string) => void,
  ) {}

  start(): void {
    this.schedule(0);
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.abortController?.abort(new Error('provider plugin updater closed'));
    await this.flight?.catch(() => undefined);
  }

  private schedule(delay: number): void {
    if (this.closed) return;
    this.timer = setTimeout(() => void this.run(), delay);
    this.timer.unref?.();
  }

  private async run(): Promise<void> {
    if (this.closed) return;
    this.timer = null;
    this.flight = this.runPackages();
    try {
      await this.flight;
    } catch (err) {
      if (!this.closed) this.warn(`provider plugin updater failed: ${errMessage(err)}`);
    } finally {
      this.flight = null;
      if (this.closed) return;
      let delay = PROVIDER_PLUGIN_UPDATE_INTERVAL_MS;
      try {
        delay = await this.store.nextUpdateDelay(this.packages);
      } catch (err) {
        this.warn(`provider plugin updater scheduling failed: ${errMessage(err)}`);
      }
      if (!this.closed) this.schedule(delay);
    }
  }

  private async runPackages(): Promise<void> {
    for (const packageName of this.packages) {
      if (this.closed) return;
      const nextUpdateDelay = await this.store.nextUpdateDelay([packageName]);
      if (this.closed) return;
      if (nextUpdateDelay > 0) continue;
      this.abortController = new AbortController();
      try {
        await this.store.checkForUpdate(packageName, this.abortController.signal);
      } finally {
        this.abortController = null;
      }
    }
  }
}
