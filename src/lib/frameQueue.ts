/**
 * Frames that arrived but are not due yet: each waits until the proxy's clock
 * passes its timestamp plus the viewer's delay. Arrival order is send order,
 * since SSE runs over TCP.
 *
 * Raw JSON is kept rather than the parsed object — parsing on arrival would do
 * the work twice and hold every intermediate object for the length of the delay.
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
