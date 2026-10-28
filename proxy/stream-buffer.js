/**
 * Rolling window of the SSE frames this proxy has already broadcast.
 *
 * Viewers who watch the race on TV want the dashboard a few seconds behind
 * live. The delay itself belongs in the browser — it holds each frame back and
 * applies it late — but a viewer who opens the page mid-session has to start
 * from somewhere, and `currentState` is the present: handing that over would
 * show them the next minute of the race before the delay even takes effect.
 *
 * So the proxy keeps what it put on the wire: every delta frame, plus a full
 * snapshot every few seconds. A delayed viewer is served the newest snapshot
 * that is already older than their delay, followed by every frame recorded
 * after it. That lands them exactly where a viewer connected all along would
 * be, with the rest of the window queued in their browser.
 *
 * Frames are stored as the serialised SSE text, so replaying them is a byte
 * copy rather than a second pass of JSON.stringify.
 *
 * The buffer records whether or not anyone is connected. It costs one extra
 * reference to each frame and it is what makes the *first* viewer's page load
 * spoiler-free — on a dashboard with one viewer, that is every page load.
 */

/** Deepest delay a viewer may ask for. The UI offers the same ceiling. */
export const MAX_DELAY_MS = 60_000;

/**
 * How often a full snapshot is taken. It bounds both the extra memory (one
 * copy of the state per snapshot) and how many frames a delayed viewer has to
 * be sent on top of their starting point.
 */
const SNAPSHOT_INTERVAL_MS = 10_000;

/**
 * Hard ceiling on the window. Measured frames are small (a quali session
 * averages well under 30 KB/s of deltas), so this is a backstop against a
 * pathological session, not the normal operating point. Hitting it costs
 * coverage from the oldest end, never correctness.
 */
const MAX_BYTES = 8 * 1024 * 1024;

export function createStreamBuffer({
  maxDelayMs = MAX_DELAY_MS,
  snapshotIntervalMs = SNAPSHOT_INTERVAL_MS,
  maxBytes = MAX_BYTES,
} = {}) {
  // Delta frames in broadcast order, and the snapshots they hang off.
  // `seq` is what the two are stitched together by: a snapshot records the
  // sequence number of the last frame already folded into it, so replaying
  // means "this snapshot, then every frame with a higher seq". Timestamps
  // alone would be ambiguous — a control event can share a millisecond with
  // the frame next to it.
  const frames = [];
  const snapshots = [];
  let seq = 0;
  let bytes = 0;
  let lastSnapshotTs = 0;

  function release(entry) {
    if (entry) bytes -= entry.frame.length;
  }

  /**
   * One snapshot plus the frames recorded after it is the smallest unit that
   * can be dropped without breaking the chain a replay walks, so shrinking the
   * buffer always means giving up its oldest segment.
   */
  function dropOldestSegment() {
    if (snapshots.length === 0) {
      // Before the first snapshot exists the frames have no base to be
      // replayed onto, so they can go one by one.
      release(frames.shift());
      return;
    }
    release(snapshots.shift());
    const floor = snapshots.length > 0 ? snapshots[0].seq : Infinity;
    while (frames.length > 0 && frames[0].seq <= floor) release(frames.shift());
  }

  function prune(now) {
    // A snapshot is only ever a starting point while it is older than the delay
    // asked for. Once it is older than the deepest delay — regardless of whether
    // the snapshot after it is already old enough — it can never be chosen
    // again, so it is dead weight. Comparing against the oldest (not the
    // second-oldest) is what also keeps a snapshot recorded before a long idle
    // stretch from lingering and being handed to a delayed viewer as if it were
    // seconds old.
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
    // Never drop the last snapshot: it is the only base a delayed viewer has to
    // replay onto. Frames go first, and a lone snapshot larger than the cap is
    // kept rather than leaving the buffer with nothing to start from.
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

    /**
     * Record a full-state snapshot. Must be called after the frame for the
     * same timestamp has been recorded, so the snapshot and the frames that
     * follow it do not overlap.
     */
    recordSnapshot(frame, ts) {
      lastSnapshotTs = ts;
      snapshots.push({ seq, ts, frame });
      bytes += frame.length;
      prune(ts);
    },

    /**
     * What to send a viewer joining `delayMs` behind live: a starting state and
     * the frames recorded since. Null when there is nothing stored yet, which
     * leaves the caller to serve the live state.
     */
    backlogFor(delayMs, now = Date.now()) {
      const cutoff = now - delayMs;
      let base = null;
      for (const snapshot of snapshots) {
        if (snapshot.ts > cutoff) break;
        base = snapshot;
      }
      // Nothing old enough yet — the proxy has been up for less than the delay
      // asked for. Start from the oldest snapshot there is: it is newer than
      // the viewer wanted, so their browser will sit on it until the window
      // fills, which is the harmless direction to be wrong in. The other way
      // round would mean showing them data from the future.
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
