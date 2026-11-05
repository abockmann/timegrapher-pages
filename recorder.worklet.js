/**
 * AudioWorklet recorder processor.
 *
 * Responsibilities, in order, for every input sample:
 *
 * 1. Clock-glitch compensation.  Capture devices and the AudioContext run on
 *    different hardware clocks.  To bridge the drift, the browser/OS periodically
 *    INSERTS a block of digital silence (exact zeros, typically 10 ms = 480 samples
 *    at 48 kHz) into the stream.  The watch's ticks after the block are then
 *    delayed by that amount, which shows up as a step in the beat plot.  Runs of
 *    exact zeros of at least `zeroRunMin` samples are therefore removed.  Very long
 *    runs (> `zeroRunMax`) are real silence (e.g. a muted mic) and pass through.
 *
 * 2. High-pass filter (2nd-order biquad, coefficients exactly as in the Web Audio
 *    spec, so it behaves like the BiquadFilterNode it replaces).  The filter lives
 *    here, not in the audio graph, so that step 1 sees the raw, unfiltered samples.
 *
 * 3. Batching into fixed-size chunks.  Each message carries `startFrame`, the
 *    engine frame counter of the chunk's first sample MINUS all samples removed so
 *    far.  Consecutive chunks therefore differ by exactly `bufferSize` unless
 *    audio was really lost, which is what the main thread's gap detector relies on.
 *
 * Buffers are transferred, not copied, to avoid GC stalls on the audio thread.
 */
class RecorderProcessor extends AudioWorkletProcessor {

  constructor(options) {
    super();
    const o = options.processorOptions;
    this.bufferSize  = o.bufferSize;
    this.compensate  = o.compensate !== false;
    this.zeroRunMin  = o.zeroRunMin || 96;     // 2 ms at 48 kHz
    this.zeroRunMax  = o.zeroRunMax || 4800;   // 100 ms: longer = genuine silence

    this._buffer = new Float64Array(this.bufferSize);
    this._n = 0;
    this._batchStartFrame = 0;

    this._zeroRun = 0;          // length of the zero run currently being held back
    this._zeroStart = 0;        // engine frame where it started
    this._passZeros = false;    // inside a genuine long silence: let zeros through
    this._dropped = 0;          // total samples removed so far
    this._events = [];          // {frame, len} of removals since last message

    // High-pass biquad (Web Audio spec formulas; Q is in dB, default 1)
    const f = o.hpFreq || 0;
    this._hp = f > 0;
    if (this._hp) {
      const w0 = 2 * Math.PI * f / sampleRate;
      const cw = Math.cos(w0);
      const alpha = Math.sin(w0) / (2 * Math.pow(10, (o.hpQdB === undefined ? 1 : o.hpQdB) / 20));
      const a0 = 1 + alpha;
      this._b0 = ((1 + cw) / 2) / a0;
      this._b1 = (-(1 + cw)) / a0;
      this._b2 = this._b0;
      this._a1 = (-2 * cw) / a0;
      this._a2 = (1 - alpha) / a0;
    }
    this._x1 = 0; this._x2 = 0; this._y1 = 0; this._y2 = 0;
  }

  _emit(v, frame) {
    let y = v;
    if (this._hp) {
      y = this._b0 * v + this._b1 * this._x1 + this._b2 * this._x2 - this._a1 * this._y1 - this._a2 * this._y2;
      this._x2 = this._x1; this._x1 = v;
      this._y2 = this._y1; this._y1 = y;
    }
    if (this._n === 0) this._batchStartFrame = frame - this._dropped;
    this._buffer[this._n++] = y;
    if (this._n === this.bufferSize) this._flush();
  }

  process(inputs) {
    const ch = inputs[0]?.[0];
    if (!ch || ch.length === 0) return true;
    const f0 = currentFrame;

    for (let i = 0; i < ch.length; i++) {
      const v = ch[i];
      const fr = f0 + i;

      if (!this.compensate) { this._emit(v, fr); continue; }

      if (Math.abs(v) < 1e-8) {
        if (this._passZeros) { this._emit(0, fr); continue; }
        if (this._zeroRun === 0) this._zeroStart = fr;
        this._zeroRun++;
        if (this._zeroRun > this.zeroRunMax) {
          // Genuine long silence: release the held zeros and stop holding.
          for (let k = 0; k < this._zeroRun; k++) this._emit(0, this._zeroStart + k);
          this._zeroRun = 0;
          this._passZeros = true;
        }
        continue;
      }

      // Non-zero sample ends any zero run.
      this._passZeros = false;
      if (this._zeroRun > 0) {
        if (this._zeroRun >= this.zeroRunMin) {
          this._dropped += this._zeroRun;
          this._events.push({ frame: this._zeroStart, len: this._zeroRun });
        } else {
          for (let k = 0; k < this._zeroRun; k++) this._emit(0, this._zeroStart + k);
        }
        this._zeroRun = 0;
      }
      this._emit(v, fr);
    }
    return true;
  }

  _flush() {
    const buffer = this._buffer;
    this._buffer = new Float64Array(this.bufferSize);
    this._n = 0;
    const events = this._events;
    this._events = [];
    this.port.postMessage(
      { samples: buffer, startFrame: this._batchStartFrame, droppedTotal: this._dropped, dropEvents: events },
      [buffer.buffer]
    );
  }
}

registerProcessor('recorder.worklet', RecorderProcessor);
