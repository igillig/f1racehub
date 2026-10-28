/**
 * Frames that have arrived but are not allowed on screen yet.
 *
 * Someone watching the race on TV sets a delay, and from then on every frame
 * waits here until the proxy's clock has moved past its timestamp plus that
 * delay. Order is arrival order: SSE runs over TCP, so what the proxy sent
 * first is what arrived first.
 *
 * The raw JSON text is kept rather than the parsed object. A minute of a race
 * is a few hundred frames, and parsing on arrival would both do the work twice
 * over — once here, once when the frame is applied — and hold every
 * intermediate object in memory for the length of the delay.
 */

export type StreamEventName = "initial" | "update" | "reset";

export interface PendingFrame {
  /** The proxy's clock when it sent the frame. */
  ts: number;
  event: StreamEventName;
  /** Unparsed `data:` payload. */
  raw: string;
}

export interface FrameQueue {
  push(frame: PendingFrame): void;
  /** Every frame due at `ts`, in order, removed from the queue. */
  drainUpTo(ts: number): PendingFrame[];
  clear(): void;
  readonly size: number;
}

export function createFrameQueue(): FrameQueue {
  const pending: PendingFrame[] = [];

  return {
    push(frame: PendingFrame) {
      pending.push(frame);
    },

    drainUpTo(ts: number) {
      let due = 0;
      while (due < pending.length && pending[due].ts <= ts) due += 1;
      return due > 0 ? pending.splice(0, due) : [];
    },

    clear() {
      pending.length = 0;
    },

    get size() {
      return pending.length;
    },
  };
}
