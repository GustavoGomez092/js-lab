type AnyListener = (payload: unknown) => void;

/** Most payloads kept per message name while nobody listens; past this the oldest is dropped. */
const MAX_QUEUED = 32;

export interface MessageHub<M> {
  /** A transport handler for `name`: delivers to current listeners, or queues while there are none. */
  dispatch<K extends keyof M>(name: K): (payload: unknown) => void;
  /** Subscribes; the first listener for a name receives that name's queued payloads synchronously, in order. */
  on<K extends keyof M>(name: K, listener: (payload: M[K]) => void): () => void;
}

/**
 * Main can message a view before it has subscribed (the Settings window receives `e2e.request` while its bundle is
 * still loading, R-M2-T24-4). Nothing sent before the first listener is lost, and no payload is delivered twice.
 */
export function createMessageHub<M>(): MessageHub<M> {
  const listeners = new Map<keyof M, Set<AnyListener>>();
  const queues = new Map<keyof M, unknown[]>();
  return {
    dispatch: (name) => (payload) => {
      const current = listeners.get(name);
      if (current && current.size > 0) {
        for (const listener of [...current]) listener(payload);
        return;
      }
      const queue = queues.get(name) ?? [];
      queue.push(payload);
      if (queue.length > MAX_QUEUED) queue.shift();
      queues.set(name, queue);
    },
    on(name, listener) {
      const set = listeners.get(name) ?? new Set<AnyListener>();
      listeners.set(name, set);
      const first = set.size === 0;
      set.add(listener as AnyListener);
      if (first) {
        const queued = queues.get(name) ?? [];
        queues.delete(name);
        for (const payload of queued) (listener as AnyListener)(payload);
      }
      return () => {
        set.delete(listener as AnyListener);
      };
    },
  };
}
