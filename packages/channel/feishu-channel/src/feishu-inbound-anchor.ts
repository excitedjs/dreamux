/**
 * Which in-flight submissions are this session's own.
 *
 * The Channel makes the operator's message visible before it submits it, so
 * Core's echo of that same body must not be shown a second time. This holds
 * the caller-owned ids this session issued, and recognition is a comparison
 * against them — never a check that an id is present, which proves nothing: a
 * cron fire, a task push-back, and a restart notice all carry one too.
 */

/** Bounded correlation for this session's in-flight Channel submissions. */
const FEISHU_INBOUND_CORRELATIONS_MAX = 256;

export class FeishuInboundCorrelations {
  private readonly pending = new Map<string, Set<object>>();
  private size = 0;

  /** Hold a caller-owned id until its input fact arrives or invoke returns. */
  begin(sourceId: string): () => void {
    if (sourceId === '' || this.size >= FEISHU_INBOUND_CORRELATIONS_MAX) {
      return () => undefined;
    }
    const token = {};
    let tokens = this.pending.get(sourceId);
    if (tokens === undefined) {
      tokens = new Set();
      this.pending.set(sourceId, tokens);
    }
    tokens.add(token);
    this.size += 1;
    return () => this.drop(sourceId, token);
  }

  /** Hide this session's own body once; every other input fails open. */
  consume(sourceId: string | null): boolean {
    if (sourceId === null) return false;
    const token = this.pending.get(sourceId)?.values().next().value;
    if (token === undefined) return false;
    this.drop(sourceId, token);
    return true;
  }

  clear(): void {
    this.pending.clear();
    this.size = 0;
  }

  /** Idempotent: the release the caller holds and a consumed body are the same token. */
  private drop(sourceId: string, token: object): void {
    const tokens = this.pending.get(sourceId);
    if (tokens === undefined || !tokens.delete(token)) return;
    this.size -= 1;
    if (tokens.size === 0) this.pending.delete(sourceId);
  }
}
