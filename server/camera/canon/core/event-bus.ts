import type { BridgeEventMap } from './types';

type EventKey = keyof BridgeEventMap;
type Handler<K extends EventKey> = (payload: BridgeEventMap[K]) => void;

export class EventBus {
  private handlers = new Map<EventKey, Set<Handler<any>>>();

  on<K extends EventKey>(event: K, handler: Handler<K>): () => void {
    const set = this.handlers.get(event) ?? new Set();
    set.add(handler as Handler<any>);
    this.handlers.set(event, set);
    return () => {
      const existing = this.handlers.get(event);
      if (!existing) return;
      existing.delete(handler as Handler<any>);
      if (existing.size === 0) this.handlers.delete(event);
    };
  }

  emit<K extends EventKey>(event: K, payload: BridgeEventMap[K]): void {
    const set = this.handlers.get(event);
    if (!set) return;
    for (const handler of set) {
      try {
        handler(payload);
      } catch (err) {
        console.warn('[canon-bridge] event handler failed', event, err);
      }
    }
  }
}

