import type { CodexWsClient } from './rpc.js';
import type { ThreadStartResponse } from './types.js';

const EFFORT_ORDER = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

interface Model {
  model: string;
  defaultReasoningEffort: string;
  supportedReasoningEfforts: Array<{ reasoningEffort: string }>;
}

/** Owns submission-local effort selection; Codex still owns native turn timing. */
export class CodexReasoningEffort {
  private ordinary: string | undefined;
  private highest: string | undefined;

  constructor(
    private readonly client: CodexWsClient,
    private readonly thread: Pick<ThreadStartResponse, 'model' | 'reasoningEffort'>,
    private readonly resumed: boolean,
    private readonly cwd: string,
  ) {}

  /** The effort one submission asks for, or undefined to leave it to Codex. */
  async effortFor(text: string): Promise<string | undefined> {
    const marked = /ultrathink/i.test(text);
    if (!marked && !this.resumed && this.ordinary === undefined) return undefined;

    if (this.ordinary === undefined) {
      // Cold resume may restore the last temporary override from native state.
      // The effective config, including CLI/project overrides, owns the baseline.
      const effort = this.resumed
        ? (await this.client.request<{ config: { model_reasoning_effort: string | null } }>(
          'config/read', { cwd: this.cwd },
        )).config.model_reasoning_effort
        : this.thread.reasoningEffort;
      this.ordinary = effort ?? (await this.readModel()).defaultReasoningEffort;
    }
    if (!marked) return this.ordinary;

    if (this.highest === undefined) {
      const model = await this.readModel();
      const efforts = model.supportedReasoningEfforts
        .map((option) => option.reasoningEffort)
        .filter((effort) => !['ultra', 'persistent', 'disabled'].includes(effort));
      if (efforts.length === 0 || efforts.some((effort) => !EFFORT_ORDER.includes(effort))) {
        throw new Error(`Cannot select the highest reasoning effort for Codex model ${model.model}`);
      }
      this.highest = efforts.reduce((highest, effort) =>
        EFFORT_ORDER.indexOf(effort) > EFFORT_ORDER.indexOf(highest) ? effort : highest);
    }
    return this.highest;
  }

  private async readModel(): Promise<Model> {
    let cursor: string | null = null;
    do {
      const page: { data: Model[]; nextCursor: string | null } = await this.client.request(
        'model/list', { includeHidden: true, cursor },
      );
      const model = page.data.find((entry) => entry.model === this.thread.model);
      if (model !== undefined) return model;
      cursor = page.nextCursor;
    } while (cursor !== null);
    throw new Error(`Codex model ${this.thread.model} is absent from model/list`);
  }
}
