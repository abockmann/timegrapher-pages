/**
 * BeatBuffer — a rolling window of detected beat sample positions.
 *
 * Beats are stored as absolute sample indices (the `imax` / i_global values
 * coming out of the C timegrapher).  The buffer has a fixed maximum capacity;
 * once full, pushing a new beat evicts the oldest one from the left — exactly
 * like a Python collections.deque(maxlen=N).
 *
 * Typical construction:
 *   const MAX_PLOT_SECONDS = 300;
 *   const BEATS_PER_SEC    = settingsData['beat-rate'] / 3600;
 *   const buf = new BeatBuffer(2 * MAX_PLOT_SECONDS * BEATS_PER_SEC, sampleRate);
 *
 * The ×2 factor gives you headroom so you never have to worry about the buffer
 * going empty when the plot window and the buffer window happen to align badly.
 */
class BeatBuffer {

  /**
   * @param {number} capacity    Maximum number of beats to retain.
   * @param {number} sampleRate  Audio sample rate (Hz), e.g. 44100.
   */
  constructor(capacity, sampleRate) {
    this.capacity   = capacity;
    this.sampleRate = sampleRate;
    this._beats     = [];   // oldest at index 0, newest at the end — just like a Python list
  }

  // ── write ────────────────────────────────────────────────────────────────

  /**
   * Push one or more new beat sample indices into the buffer.
   * Accepts either a single number or an array/Int32Array of numbers.
   *
   * Monotonicity guard: any incoming value that is not strictly greater than
   * the current newest beat is silently dropped.  This protects the sorted
   * invariant that _lowerBound() and getLastSeconds() rely on.
   *
   * The guard catches stale values that can arrive if copyLastNBeats() in C
   * returns an old ring-buffer entry (e.g. just after the ring has wrapped
   * and before the index arithmetic has been corrected).  Dropping them is
   * always safe: the coarse detector will produce a correct position on the
   * very next beat, so the visual gap is at most one beat period.
   *
   * @param {number|number[]|Int32Array} beatOrBeats
   */
  push(beatOrBeats) {
    const incoming = (typeof beatOrBeats === 'number') ? [beatOrBeats] : Array.from(beatOrBeats);
    for (const b of incoming) {
      // Enforce strict monotonicity — drop anything ≤ the current newest.
      if (this._beats.length > 0 && b <= this._beats[this._beats.length - 1]) {
        continue;
      }
      this._beats.push(b);
      if (this._beats.length > this.capacity) {
        this._beats.shift();   // evict oldest
      }
    }
  }

  // ── read ─────────────────────────────────────────────────────────────────

  /**
   * Return all beats that fall within the last `seconds` of audio,
   * measured backwards from the most recent beat in the buffer.
   *
   * The returned array preserves the original ascending sample-index order,
   * so you can directly iterate or apply fmod for the wipe effect:
   *
   *   const windowSamples = plotSeconds * sampleRate;
   *   for (const s of buf.getLastSeconds(plotSeconds)) {
   *     const x = (s % windowSamples) / windowSamples * canvasWidth;
   *     // ... plot dot at x
   *   }
   *
   * @param  {number}   seconds   How many seconds of history to retrieve.
   * @returns {number[]}          Beat sample indices, oldest-first.
   */
  getLastSeconds(seconds) {
    if (this._beats.length === 0) return [];
    const newest    = this._beats[this._beats.length - 1];
    const threshold = newest - seconds * this.sampleRate;
    // Binary search for the first index >= threshold (beats are monotonically increasing).
    return this._beats.slice(this._lowerBound(threshold));
  }

  /**
   * Return all beats within the last `seconds` as sample offsets relative to
   * the oldest returned beat, i.e. shifted so the first value is 0.
   * Convenient if your plotting code works in relative rather than absolute time.
   *
   * @param  {number}   seconds
   * @returns {number[]}
   */
  getLastSecondsRelative(seconds) {
    const abs = this.getLastSeconds(seconds);
    if (abs.length === 0) return [];
    const origin = abs[0];
    return abs.map(b => b - origin);
  }

  // ── convenience ──────────────────────────────────────────────────────────

  /** Total number of beats currently in the buffer. */
  get size()   { return this._beats.length; }

  /** Sample index of the most recently pushed beat, or null if empty. */
  get newest() { return this._beats.length ? this._beats[this._beats.length - 1] : null; }

  /** Sample index of the oldest retained beat, or null if empty. */
  get oldest() { return this._beats.length ? this._beats[0] : null; }

  /** How many seconds of audio the buffer currently spans. */
  get spanSeconds() {
    if (this._beats.length < 2) return 0;
    return (this.newest - this.oldest) / this.sampleRate;
  }

  /** Discard all stored beats. */
  clear() { this._beats = []; }

  // ── internal ─────────────────────────────────────────────────────────────

  /**
   * Binary search: index of the first element >= value.
   * O(log N) so getLastSeconds stays fast even with a large buffer.
   * @private
   */
  _lowerBound(value) {
    let lo = 0, hi = this._beats.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this._beats[mid] < value) lo = mid + 1;
      else                          hi = mid;
    }
    return lo;
  }
}
