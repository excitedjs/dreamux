/** Bounded correlation for this session's in-flight Channel submissions. */
const FEISHU_INBOUND_CORRELATIONS_MAX = 256;

interface PendingToken {
  turnKey: string | null;
}

export class FeishuInboundCorrelations {
  private readonly pending = new Map<string, Set<PendingToken>>();
  private readonly ownTurns = new Map<string, Set<PendingToken>>();
  private size = 0;

  /** Hold a caller-owned id until its submitted fact arrives or invoke returns. */
  begin(sourceId: string): () => void {
    if (sourceId === '' || this.size >= FEISHU_INBOUND_CORRELATIONS_MAX) {
      return () => undefined;
    }
    let tokens = this.pending.get(sourceId);
    if (tokens === undefined) {
      tokens = new Set();
      this.pending.set(sourceId, tokens);
    }
    const token: PendingToken = { turnKey: null };
    tokens.add(token);
    this.size += 1;
    return () => this.release(sourceId, token);
  }

  /** Recognize this session's id and remember the exact turn it produced. */
  submitted(sourceId: string | null, recipientKey: string, turnId: string): void {
    if (sourceId === null || sourceId === '') return;
    const tokens = this.pending.get(sourceId);
    const token = tokens?.values().next().value as PendingToken | undefined;
    if (token === undefined) return;
    tokens!.delete(token);
    if (tokens!.size === 0) this.pending.delete(sourceId);
    const key = turnKey(recipientKey, turnId);
    token.turnKey = key;
    let turnTokens = this.ownTurns.get(key);
    if (turnTokens === undefined) {
      turnTokens = new Set();
      this.ownTurns.set(key, turnTokens);
    }
    turnTokens.add(token);
  }

  /** Hide the recognized turn's user body once; every other turn fails open. */
  consumeTurn(recipientKey: string, turnId: string): boolean {
    const key = turnKey(recipientKey, turnId);
    const tokens = this.ownTurns.get(key);
    const token = tokens?.values().next().value as PendingToken | undefined;
    if (token === undefined) return false;
    this.removeTurn(key, token);
    return true;
  }

  clear(): void {
    this.pending.clear();
    this.ownTurns.clear();
    this.size = 0;
  }

  private release(sourceId: string, token: PendingToken): void {
    if (token.turnKey !== null) {
      this.removeTurn(token.turnKey, token);
      return;
    }
    const tokens = this.pending.get(sourceId);
    if (tokens === undefined || !tokens.delete(token)) return;
    this.size -= 1;
    if (tokens.size === 0) this.pending.delete(sourceId);
  }

  private removeTurn(key: string, token: PendingToken): void {
    const tokens = this.ownTurns.get(key);
    if (tokens === undefined || !tokens.delete(token)) return;
    token.turnKey = null;
    this.size -= 1;
    if (tokens.size === 0) this.ownTurns.delete(key);
  }
}

function turnKey(recipientKey: string, turnId: string): string {
  return `${recipientKey}\0${turnId}`;
}
