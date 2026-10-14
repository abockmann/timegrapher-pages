/**
 * AudioWorklet recorder processor.
 *
 * Key improvements over the original:
 *
 * 1. `currentFrame` is included in every message.  This is the Web Audio engine's
 *    sample-accurate monotonic counter — it never drifts and never resets during a
 *    session.  The main thread converts it with `startFrame / audioContext.sampleRate`
 *    and uses it as the authoritative timestamp for pulse-timing, instead of
 *    Date.now() / performance.now() which are subject to scheduling jitter.
 *
 * 2. Zero-copy buffer transfer.  Instead of postMessage *copying* the Float64Array,
 *    we *transfer* its underlying ArrayBuffer to the main thread and immediately
 *    allocate a fresh one in the worklet.  This eliminates the O(N) copy on every
 *    flush and avoids a GC stall on the real-time audio thread.
 *
 * 3. Correct null guard.  channelData is checked for null/empty *before* any write.
 *
 * 4. Batch start frame.  `_batchStartFrame` is latched at the first sample of each
 *    new batch so the timestamp reflects the *beginning* of the buffer, not the end.
 */
class RecorderProcessor extends AudioWorkletProcessor {

  constructor(options) {
    super();
    this.bufferSize       = options.processorOptions.bufferSize;
    this._buffer          = new Float64Array(this.bufferSize);
    this._bytesWritten    = 0;
    this._batchStartFrame = 0;
  }

  process(inputs) {
    const channelData = inputs[0]?.[0];
    if (!channelData || channelData.length === 0) return true;

    // Latch the frame counter at the start of each fresh batch.
    if (this._bytesWritten === 0) {
      this._batchStartFrame = currentFrame;
    }

    for (let i = 0; i < channelData.length; i++) {
      this._buffer[this._bytesWritten++] = channelData[i];

      if (this._bytesWritten === this.bufferSize) {
        this._flush();
        // If more samples remain in this 128-sample block, latch the next frame.
        if (i + 1 < channelData.length) {
          this._batchStartFrame = currentFrame + (i + 1);
        }
      }
    }

    return true;
  }

  _flush() {
    // Swap out the buffer and transfer it (zero-copy) to the main thread.
    const buffer       = this._buffer;
    this._buffer       = new Float64Array(this.bufferSize);
    this._bytesWritten = 0;

    this.port.postMessage(
      { samples: buffer, startFrame: this._batchStartFrame },
      [buffer.buffer]   // transferable — no copy
    );
  }
}

registerProcessor('recorder.worklet', RecorderProcessor);