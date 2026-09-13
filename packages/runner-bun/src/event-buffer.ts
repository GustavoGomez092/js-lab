import type { RawRunEvent, RawRunEventBody } from "@jslab/rpc-schema";

export interface TimerFns {
  setTimeout: typeof setTimeout;
  clearTimeout: typeof clearTimeout;
}

/** Batches run events and enforces the per-run output cap before anything crosses IPC. */
export class EventBuffer {
  #queue: RawRunEvent[] = [];
  #seq = 0;
  #counted = 0;
  #dropped = 0;
  #reportedDropped = 0;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #closed = false;

  constructor(
    private readonly send: (events: RawRunEvent[]) => void,
    private readonly maxEntries: number,
    private readonly timers: TimerFns,
    private readonly intervalMs = 16,
  ) {}

  /** Returns the event's sequence number, or null when the event was dropped by the cap. */
  push(body: RawRunEventBody): number | null {
    if (this.#closed) return null;
    if (body.kind !== "promiseSettled") {
      if (this.#counted >= this.maxEntries) {
        this.#dropped++;
        this.#schedule();
        return null;
      }
      this.#counted++;
    }
    const seq = ++this.#seq;
    this.#queue.push({ ...body, seq, t: Date.now() } as RawRunEvent);
    this.#schedule();
    return seq;
  }

  flush(): void {
    if (this.#timer !== null) {
      this.timers.clearTimeout(this.#timer);
      this.#timer = null;
    }
    if (this.#dropped !== this.#reportedDropped) {
      this.#reportedDropped = this.#dropped;
      this.#queue.push({ kind: "truncated", dropped: this.#dropped, seq: ++this.#seq, t: Date.now() });
    }
    if (this.#queue.length === 0) return;
    const events = this.#queue;
    this.#queue = [];
    this.send(events);
  }

  /** Sends whatever is pending, then drops every later push (the run was stopped). */
  close(): void {
    this.flush();
    this.#closed = true;
  }

  #schedule(): void {
    if (this.#timer !== null) return;
    this.#timer = this.timers.setTimeout(() => {
      this.#timer = null;
      this.flush();
    }, this.intervalMs);
  }
}
