/**
 * The proxy's clock, as closely as this browser can estimate it.
 *
 * Every SSE frame carries the time the proxy sent it (the `id:` field). To run
 * the stream a fixed amount behind live we compare those stamps against "now",
 * and a browser clock can sit seconds away from the proxy's — enough to turn a
 * 45s delay into 40 or 50 without anyone noticing.
 *
 * Each frame gives one sample of `local - server`. The true offset is the
 * smallest of them: a sample is inflated by however long the frame spent in
 * flight, never deflated, so the minimum is the closest estimate available.
 * Samples expire, so a clock correction on either end is picked up instead of
 * being outvoted forever by one lucky early sample.
 */

/** How long a sample stays in the estimate. */
const SAMPLE_TTL_MS = 120_000;

/** Ceiling on retained samples — at 10 frames/s the TTL alone is thousands. */
const MAX_SAMPLES = 240;

export interface ServerClock {
  /** Feed in the send time of a frame that just arrived. */
  sample(serverTs: number): void;
  /** Best estimate of the proxy's clock, in ms since the epoch. */
  now(): number;
}

export function createServerClock(): ServerClock {
  const offsets: number[] = [];
  const takenAt: number[] = [];

  return {
    sample(serverTs: number) {
      if (!Number.isFinite(serverTs) || serverTs <= 0) return;
      const at = Date.now();
      offsets.push(at - serverTs);
      takenAt.push(at);
      // A backlog replayed on connect arrives with timestamps up to a minute
      // old, so it contributes wildly inflated samples. They are harmless —
      // the minimum ignores them — but they should not linger.
      while (takenAt.length > 0 && at - takenAt[0] > SAMPLE_TTL_MS) {
        takenAt.shift();
        offsets.shift();
      }
      while (offsets.length > MAX_SAMPLES) {
        takenAt.shift();
        offsets.shift();
      }
    },

    now() {
      if (offsets.length === 0) return Date.now();
      let smallest = offsets[0];
      for (const offset of offsets) {
        if (offset < smallest) smallest = offset;
      }
      return Date.now() - smallest;
    },
  };
}
