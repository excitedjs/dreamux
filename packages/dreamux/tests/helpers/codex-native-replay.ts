import type {
  CloseHandler,
  NotificationHandler,
} from '../../../agent-runtime/codex/dist/rpc.js';
import type { ServerNotification } from '../../../agent-runtime/codex/dist/types.js';

/** Minimal transport for replaying native collector notifications; no model execution. */
export class CodexNativeReplay {
  private readonly notifications = new Set<NotificationHandler>();
  private readonly closes: CloseHandler[] = [];
  private starts = 0;
  private releaseAdmission: ((value: unknown) => void) | null = null;
  private rejectAdmission: ((error: Error) => void) | null = null;
  holdNextAdmission = false;
  onNotification(handler: NotificationHandler): () => void {
    this.notifications.add(handler);
    return () => this.notifications.delete(handler);
  }
  onClose(handler: CloseHandler): void {
    this.closes.push(handler);
  }
  async request(method: string): Promise<unknown> {
    if (method !== 'turn/start')
      throw new Error(`Unexpected replay request: ${method}`);
    const value = { turn: { id: this.starts++ < 2 ? 'first' : 'third' } };
    if (!this.holdNextAdmission) return value;
    this.holdNextAdmission = false;
    return new Promise((resolve, reject) => {
      this.releaseAdmission = () => resolve(value);
      this.rejectAdmission = reject;
    });
  }
  get admissionPending(): boolean {
    return this.releaseAdmission !== null;
  }
  release(): void {
    this.releaseAdmission?.(undefined);
    this.releaseAdmission = null;
    this.rejectAdmission = null;
  }
  reject(error: Error): void {
    this.rejectAdmission?.(error);
    this.releaseAdmission = null;
    this.rejectAdmission = null;
  }
  emitCompleted(threadId: string, id: string, text: string): void {
    this.emit({
      method: 'item/completed',
      params: {
        threadId,
        turnId: id,
        completedAtMs: Date.now(),
        item: { type: 'agentMessage', id: `item-${id}`, text },
      },
    });
    this.emit({
      method: 'turn/completed',
      params: { threadId, turn: { id, status: 'completed', items: [] } },
    });
  }
  emit(notification: ServerNotification): void {
    for (const handler of this.notifications) handler(notification);
  }
  close(): void {
    this.reject(new Error('replay connection lost'));
    for (const handler of this.closes)
      handler(new Error('replay connection lost'));
  }
}
