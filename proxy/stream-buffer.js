/**
 * Rolling window of the SSE frames this proxy has broadcast: every delta plus a
 * full snapshot every few seconds.
 *
 * A viewer running behind live needs a starting point, and `currentState` is
 * the present — handing that over would spoil the next minute. Instead they get
 * the newest snapshot already older than their delay, plus every frame since.
 * Frames are stored as serialised SSE text so replaying them is a byte copy.
 *
 * Recording happens with or without clients connected; that is what makes the
 * first viewer's page load spoiler-free.
 */

/** Deepest delay a viewer may ask for. The UI offers the same ceiling. */
export const MAX_DELAY_MS = 60_000;

/** Bounds both the extra memory and the replay a delayed viewer is sent. */
const SNAPSHOT_INTERVAL_MS = 10_000;

/** Backstop against a pathological session; hitting it costs the oldest
 *  coverage, never correctness. */
const MAX_BYTES = 8 * 1024 * 1024;

export function createStreamBuffer({
  maxDelayMs = MAX_DELAY_MS,
  snapshotIntervalMs = SNAPSHOT_INTERVAL_MS,
  maxBytes = MAX_BYTES,
} = {}) {
  // Stitched by `seq`, not timestamps: a control event can share a millisecond
  // with the frame next to it. A snapshot records the last seq folded into it.
  const frames = [];
  const snapshots = [];
  let seq = 0;
  let bytes = 0;
  let lastSnapshotTs = 0;

  function release(entry) {
    if (entry) bytes -= entry.frame.length;
  }

  /** A snapshot plus the frames after it is the smallest unit droppable
   *  without breaking the chain a replay walks. */
  function dropOldestSegment() {
    if (snapshots.length === 0) {
      // No base to replay onto yet, so frames can go one by one.
      release(frames.shift());
      return;
    }
    release(snapshots.shift());
    const floor = snapshots.length > 0 ? snapshots[0].seq : Infinity;
    while (frames.length > 0 && frames[0].seq <= floor) release(frames.shift());
  }

  function prune(now) {
    // Past the deepest delay a snapshot can never be chosen again. Comparing
    // against the oldest also stops one recorded before a long idle stretch
    // from being handed over as if it were seconds old.
    while (
      snapshots.length > 1 &&
      snapshots[0].ts < now - maxDelayMs - snapshotIntervalMs
    ) {
      dropOldestSegment();
    }
    if (snapshots.length === 0) {
      const floor = now - maxDelayMs - snapshotIntervalMs;
      while (frames.length > 0 && frames[0].ts < floor) release(frames.shift());
    }
    // Never drop the last snapshot: it is the only base left to replay onto.
    while (bytes > maxBytes) {
      if (snapshots.length > 1) dropOldestSegment();
      else if (frames.length > 0) release(frames.shift());
      else break;
    }
  }

  return {
    /** Record a frame that was just broadcast. `frame` is the SSE text. */
    record(frame, ts) {
      seq += 1;
      frames.push({ seq, ts, frame });
      bytes += frame.length;
      prune(ts);
    },

    /** True when the next flush should also store a full snapshot. */
    snapshotDue(ts) {
      return ts - lastSnapshotTs >= snapshotIntervalMs;
    },

    /** Must follow the frame for the same timestamp, so snapshot and frames
     *  do not overlap. */
    recordSnapshot(frame, ts) {
      lastSnapshotTs = ts;
      snapshots.push({ seq, ts, frame });
      bytes += frame.length;
      prune(ts);
    },

    /** Starting state plus the frames since, for a viewer joining `delayMs`
     *  behind live. Null when nothing is stored and the caller serves live. */
    backlogFor(delayMs, now = Date.now()) {
      const cutoff = now - delayMs;
      let base = null;
      for (const snapshot of snapshots) {
        if (snapshot.ts > cutoff) break;
        base = snapshot;
      }
      // Nothing old enough yet: start from the oldest there is. Too new means
      // the browser waits for the window to fill; too old would show the future.
      if (!base) base = snapshots[0] ?? null;
      if (!base) return null;

      const tail = [];
      for (const frame of frames) {
        if (frame.seq > base.seq) tail.push(frame.frame);
      }
      return {
        snapshot: base.frame,
        snapshotTs: base.ts,
        frames: tail,
        coverageMs: now - base.ts,
      };
    },

    /** Surfaced on /health. */
    stats(now = Date.now()) {
      const oldest = snapshots[0]?.ts ?? frames[0]?.ts ?? now;
      return {
        maxDelayMs,
        coverageMs: now - oldest,
        frames: frames.length,
        snapshots: snapshots.length,
        kb: Math.round(bytes / 1024),
      };
    },
  };
}
