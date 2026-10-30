/**
 * The proxy's clock, estimated from the send time on each SSE frame — a browser
 * clock can sit seconds off, enough to turn a 45s delay into 40 or 50.
 *
 * The offset is the *minimum* of recent `local - server` samples: flight time
 * inflates a sample, never deflates it. Samples expire so a clock correction is
 * picked up rather than outvoted forever by one lucky early sample.
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
      // A backlog replayed on connect contributes wildly inflated samples.
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
