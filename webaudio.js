let microphone;
let sampleRate = 48000;
let bufferSize = 2**7 // the size of the incoming audio chunks
let isDetectingBeatRate = false;
let recorder;
let context;
let currentSourceNode;
let audioInputIdMap = {};
let shuttingDown = false;

let tg; // time grapher pointer
let batchPtr; // array living in Module
let expectedFrame = null; // Web Audio frame counter we expect on the next worklet chunk (gap detection)
let droppedFrames = 0;
const liveCapture = { on: false, chunks: [], frames: [] }; // ?test only: copy of what the detector receives
    // total frames lost between worklet and main thread this session (diagnostic)

let beatBuf = new BeatBuffer(4000, sampleRate); // a beat buffer in JS to mirror the one in C and provide convenient access for plotting, diagnostics, etc.
window.beatBuf = beatBuf; // expose globally for plot redrawing when subdivisions change



async function fullyStopAudio() { 
  shuttingDown = true; 
  if (recorder) {
    recorder.port.onmessage = null; 
    recorder.disconnect(); 
    recorder = null; 
  } 

  if (currentSourceNode) {
    currentSourceNode.disconnect(); 
    currentSourceNode = null;
  } 
  // allow already-queued worklet messages to flush 
  await new Promise(r => setTimeout(r, 60)); 
  shuttingDown = false; 
}



// timegrapher functionality

function getBeatProfileSize() {
  if (!tg) {
    console.warn("TimeGrapher not initialized");
    return 0;
  }
  return getProfileSize(tg);
}

function getBeatProfiles() {
  if (!tg) {
    console.warn("TimeGrapher not initialized");
    return 0;
  }
  const profileSize = getBeatProfileSize();
  if (profileSize === 0) {
    return { tic: [], toc: [], size: 0};
  }
  // Allocate memory for both profiles
  const ticPtr = malloc(profileSize * 8);
  const tocPtr = malloc(profileSize * 8);

  try {
    // Call both C functions
    copyTicProfile(tg, ticPtr);
    copyTocProfile(tg, tocPtr);
    
    const ticProfile = new Float64Array(getHeapF64().buffer, ticPtr, profileSize).slice();
    const tocProfile = new Float64Array(getHeapF64().buffer, tocPtr, profileSize).slice();
    const ticProfileArr = Array.from(ticProfile);
    const tocProfileArr = Array.from(tocProfile);

    return {
      tic: ticProfileArr,
      toc: tocProfileArr,
      size: profileSize
    };

  } finally {
    // Always free the allocated memory
    free(ticPtr);
    free(tocPtr);
  }
}




const audioInputSelect = document.querySelector('select#audioSource');
const selectors = [audioInputSelect];


function isRecording() {
  return recordButton.getAttribute('data-recording-active') === 'true'
}

function isAutoDetecting() {
  return autoDetectButton.getAttribute('data-autodetection-active') === 'true'
}

// WebAudio error handler
function handleError(error) {
  console.log('navigator.MediaDevices.getUserMedia error: ', error.message, error.name);
}


const recordButtonObserver = new MutationObserver((mutationsList, observer) => {
  mutationsList.forEach(mutation => {
    console.log(mutation)
    if (mutation.target === recordButton) {
      console.log('Recording state changed to:', mutation.target.getAttribute('data-recording-active'));
      if (isRecording()) { // new value
        startRecording('record');
        console.log('Recording started')
      } else {
        stopRecording(false);
        console.log('Recording stopped')
      }
    }
  });
});
recordButtonObserver.observe(recordButton, {attributes: true, attributeFilter: ['data-recording-active']});


const autoDetectButtonObserver = new MutationObserver((mutationsList, observer) => {
  mutationsList.forEach(mutation => {
    console.log(mutation)
    if (mutation.target === autoDetectButton) {
      console.log('AutoDetect state changed to:', mutation.target.getAttribute('data-autodetection-active'));
      if (isAutoDetecting()) { // new value
        startRecording('detect');
        console.log('AutoDetection started')
        hideAutoDetectionDone();
        showAutoDetectionInProgress();
        setTimeout(() => {
          if (isAutoDetecting()) {
            stopRecording(true);
            hideAutoDetectionInProgress();
            showAutoDetectionDone();
            autoDetectButton.classList.remove('autodetection-active');
            autoDetectButton.setAttribute('data-autodetection-active', 'false');
            console.log('AutoDetection  stopped')
          }
        }, 5000);
      } else {
        stopRecording(false);
        hideAutoDetectionInProgress();
        console.log('AutoDetection  stopped')
      }
    }
  });
});
autoDetectButtonObserver.observe(autoDetectButton, {attributes: true, attributeFilter: ['data-autodetection-active']});


const requestMicrophoneAccess = async () => {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach(track => track.stop());
    await navigator.mediaDevices.enumerateDevices().then(gotDevices).catch(handleError);
  } catch (error) {
    console.error("Error accessing microphone:", error);
    alert("Error accessing microphone: " + error.message);
  }
};

await requestMicrophoneAccess();


let workletModuleLoaded = false;

const setupRecorder = async (mode) => {
  // Tear down any existing recorder and source nodes first.
  if (recorder) {
    recorder.port.onmessage = null;
    recorder.disconnect();
    recorder = null;
  }
  if (currentSourceNode) {
    currentSourceNode.disconnect();
    currentSourceNode = null;
  }
  await new Promise(r => setTimeout(r, 40));

  const source = context.createMediaStreamSource(microphone);
  currentSourceNode = source;

  const hpFreq = settingsData['high-pass-filter'] || 1000;

  if (!workletModuleLoaded) {
    await context.audioWorklet.addModule("recorder.worklet.js");
    workletModuleLoaded = true;
  }
  recorder = new AudioWorkletNode(context, "recorder.worklet", {processorOptions: {
    bufferSize: bufferSize,
    hpFreq: hpFreq,                                   // high-pass now runs inside the worklet
    compensate: window.tgCompensate !== false         // set window.tgCompensate = false to disable glitch removal
  }});

  const silentGain = context.createGain();
  silentGain.gain.value = 0;
  recorder.connect(silentGain).connect(context.destination);

  source.connect(recorder)

  recorder.port.onmessage = ({ data }) => {
    const { samples, startFrame, droppedTotal, dropEvents } = data;
    if (dropEvents && dropEvents.length) {
      for (const e of dropEvents)
        console.warn(`Removed ${e.len} samples (${(e.len / sampleRate * 1000).toFixed(1)} ms) of inserted digital silence at engine t=${(e.frame / sampleRate).toFixed(2)} s; total removed ${droppedTotal} (${(droppedTotal / sampleRate * 1000).toFixed(0)} ms)`);
    }

    // ── Gap detection ───────────────────────────────────────────────────────
    // startFrame is the audio engine's sample-accurate counter.  If a chunk goes
    // missing (audio glitch, thread starvation, device hiccup) the timegrapher's
    // own sample counter silently falls behind real time and every later beat is
    // shifted by the lost samples -> a step in the beat plot.  Feed silence for
    // the missing frames so the timeline stays aligned with real time.
    if (mode === 'record' && expectedFrame !== null) {
      const gap = startFrame - expectedFrame;
      if (gap > 0) {
        droppedFrames += gap;
        console.warn(`Audio gap: ${gap} frames (${(gap / sampleRate * 1000).toFixed(1)} ms) at ${(startFrame / sampleRate).toFixed(2)} s; total lost ${droppedFrames}`);
        const nFill = Math.min(Math.round(gap / bufferSize), 2000);
        const zeros = new Float64Array(bufferSize);
        for (let k = 0; k < nFill; k++) {
          heap64Set(zeros, batchPtr / 8);
          ingest(tg, batchPtr, bufferSize);
        }
      } else if (gap < 0) {
        console.warn(`Audio frame counter went backwards by ${-gap} frames at ${(startFrame / sampleRate).toFixed(2)} s`);
      }
    }
    expectedFrame = startFrame + samples.length;
    if (liveCapture.on && liveCapture.chunks.length < 180 * sampleRate / bufferSize) {
      liveCapture.chunks.push(Float32Array.from(samples));
      liveCapture.frames.push(startFrame);
    }

    heap64Set(samples, batchPtr / 8)
    
    if (mode === 'record') {
      const numNewBeats = ingest(tg, batchPtr, bufferSize)
      if (numNewBeats > 0) {

        const newBeatsPtr = malloc(numNewBeats * 4);
        const count = copyLastNBeats(tg, numNewBeats, newBeatsPtr);
        const beats = new Int32Array(getHeap32().buffer, newBeatsPtr, numNewBeats).slice();

        diagnoseBeats(beats);
        beatBuf.push(beats);

        free(newBeatsPtr);
        
        beatVis.plot(Array.from(beatBuf.getLastSeconds(beatVis.getXMaxSecSubdiv() - 0.3)));

        const rate = getRate(tg);
        const beatError = getErr(tg); 
        const amplitude = getAmp(tg);

        setDiagnosticsDisplay(rate, amplitude, beatError);

        const bp = getBeatProfiles()
        const ticProfile = bp.tic;
        const tocProfile = bp.toc;

        beatProfileVis.plot(ticProfile, tocProfile, sampleRate, settingsData['lift-angle'], settingsData['beat-rate']/3600, amplitude);
      }
    } else if (mode === 'detect') {
      estimatedBeatRate = estimateBeatRate(tg, batchPtr, bufferSize);
    }

  }
}


// Diagnostics. Compare each beat with the one two beats earlier (same tic/toc phase).
//  STEP: the tic-to-tic interval changed by > 0.5 ms vs the previous one -> real timing step
//  WRAP: the beat's y position on the plot jumped by > half the plot height -> display wrap
//  ODD : interval more than 10% off nominal (detector firing in noise / missed beat)
function diagnoseBeats(beats) {
          const nominal = sampleRate * 3600 / settingsData['beat-rate'];
          const hist = beatBuf._beats.slice(-3);
          const ypos = v => ((v % beatVis.spb) % beatVis.spbSubdiv) / beatVis.spbSubdiv;
          for (const b of beats) {
            const n = hist.length;
            const tt = (b / sampleRate).toFixed(2);
            if (n >= 1 && Math.abs((b - hist[n-1]) - nominal) > 0.1 * nominal)
              console.warn(`ODD  interval ${b - hist[n-1]} samples (nominal ${nominal.toFixed(0)}) at t=${tt} s`);
            if (n >= 3) {
              const d  = b - hist[n-2], dp = hist[n-1] - hist[n-3];
              if (Math.abs(d - dp) > 0.0005 * sampleRate)
                console.warn(`STEP tic-to-tic changed by ${((d - dp) / sampleRate * 1000).toFixed(2)} ms at t=${tt} s`);
              const dy = ypos(b) - ypos(hist[n-2]);
              if (Math.abs(dy) > 0.5)
                console.warn(`WRAP plot y jumped ${dy.toFixed(2)} of height at t=${tt} s (ySubdiv=${beatVis.ySubdivisions}, xSubdiv=${beatVis.xSubdivisions})`);
            }
            hist.push(b); if (hist.length > 3) hist.shift();
          }
}

function gotDevices(deviceInfos) {
  audioInputIdMap = {};
  deviceInfos.forEach((deviceInfo) => {
    if (deviceInfo.kind === 'audioinput') {
      if (!(['default', 'communications'].includes(deviceInfo.deviceId))) {
        audioInputIdMap[deviceInfo.label] = deviceInfo.deviceId;
      }
    }
  });
  const deviceList = Object.keys(audioInputIdMap);
  updateAudioInput(deviceList, null);
  changeMicrophone();
}


async function changeMicrophone() {
  if (microphone) {
    microphone.getAudioTracks().forEach(track => track.stop());
  }

  const audioSource = audioInputIdMap[settingsMenu.getData()['audio-input']];
  const constraints = {
    audio: {
      channelCount: 1,
      deviceId: audioSource ? { exact: audioSource } : undefined,
      echoCancellation:  false,
      noiseSuppression:  false,
      autoGainControl:   false,
    }
  };

  microphone = await navigator.mediaDevices.getUserMedia(constraints).catch(handleError);

  if (isRecording()) {
    await setupRecorder('record');
  }
}
window.changeMicrophone = changeMicrophone;


async function startRecording(mode) {
  if (!microphone) {
    console.error('No microphone selected!');
    return;
  }

  if (!context) {
    context = new (window.AudioContext || window.webkitAudioContext)({
      latencyHint: 'interactive',
      sampleRate: sampleRate
    });

    context.addEventListener('statechange', () => {
      if (context.state === 'suspended') context.resume();
    });
    document.addEventListener('visibilitychange', () => {
      if (context.state === 'suspended') context.resume();
    });
  }

  await fullyStopAudio();

  // Sync beat plot to the current beat-rate setting.
  // beatPlot defaults to 21600 BPH so starting at any other BPH would use
  // the wrong spb / spbSubdiv, making the y-coordinates meaningless and the
  // plot appear frozen even though data is flowing correctly.
  beatVis.setPlotParams(sampleRate, settingsData['beat-rate'], beatVis.xSubdivisions, beatVis.ySubdivisions);

  // clear beat buffer
  beatBuf.clear();
  expectedFrame = null;
  droppedFrames = 0;
  liveCapture.chunks = []; liveCapture.frames = [];

  // Destroy existing instance if any
  if (tg) {
    destroy(tg)
  }
  // Create new timegrapher instance
  tg = create(settingsData['beat-rate'], settingsData['lift-angle'], sampleRate, bufferSize);

  // ── Apply beat-detection mode ────────────────────────────────────────────
  // 'pulse start'          → standard mode (no refinement)
  // 'template matching' → matched-filter template refinement enabled
  const useOptimized = settingsData['beat-detection'] === 'template matching' ? 1 : 0;
  setOptimized(tg, useOptimized);
  console.log(`Beat detection mode: ${settingsData['beat-detection']} (optimized=${useOptimized})`);
  // ────────────────────────────────────────────────────────────────────────

  // Free Module buffer if it exists
  if (batchPtr) {
    free(batchPtr);
  }
  batchPtr = malloc(bufferSize * 8);

  await setupRecorder(mode);
}


function stopRecording(setEstimatedBeatRate = false) {

  if (setEstimatedBeatRate && estimatedBeatRate !== undefined) {
    settingsData['beat-rate'] = estimatedBeatRate;
    settingsMenu.configure(settingsConfig);
    settingsMenu.refreshSettingsValues(settingsData);
  }

  // Destroy timegrapher instance
  if (tg) {
    destroy(tg)
    tg = null;
  }

  if (batchPtr) {
    free(batchPtr);
    batchPtr = null;
  }

  if (recorder) {
    recorder.port.onmessage = null;
    recorder.disconnect();
    recorder = null;
  }

  if (currentSourceNode) {
    currentSourceNode.disconnect();
    currentSourceNode = null;
  }

  // Reset displays
  rateDisplay.textContent = '-';
  amplitudeDisplay.textContent = '-';
  beatErrorDisplay.textContent = '-';

}

// ── Test hook: run an audio file through the real WASM + plot pipeline, no microphone ──
// Usage (browser console, while NOT recording):  tgFeedWav(fileInputElement.files[0])
// or temporarily:  document.body.insertAdjacentHTML('beforeend','<input type=file id=wavtest>');
//                  wavtest.onchange = () => tgFeedWav(wavtest.files[0]);
// The file is resampled to the context rate and high-passed exactly like the live path,
// then fed in the same 128-sample chunks, with a pause each second of audio so the plot animates.
async function tgFeedWav(file, hpHz) {
  await ensureTimegrapherReady();
  if (recorder) { console.error('Stop recording first'); return; }
  hpHz = hpHz || settingsData['high-pass-filter'] || 1000;
  const dec = await new OfflineAudioContext(1, 1, sampleRate).decodeAudioData(await file.arrayBuffer());
  const off = new OfflineAudioContext(1, dec.length, sampleRate);
  const src = off.createBufferSource(); src.buffer = dec;
  const f = off.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = hpHz;
  src.connect(f).connect(off.destination); src.start();
  const x = (await off.startRendering()).getChannelData(0);
  console.log(`tgFeedWav: ${(x.length / sampleRate).toFixed(1)} s at ${sampleRate} Hz, high-pass ${hpHz} Hz`);

  beatVis.setPlotParams(sampleRate, settingsData['beat-rate'], beatVis.xSubdivisions, beatVis.ySubdivisions);
  beatBuf.clear();
  if (tg) destroy(tg);
  tg = create(settingsData['beat-rate'], settingsData['lift-angle'], sampleRate, bufferSize);
  setOptimized(tg, settingsData['beat-detection'] === 'template matching' ? 1 : 0);
  if (batchPtr) free(batchPtr);
  batchPtr = malloc(bufferSize * 8);

  const chunksPerSec = Math.round(sampleRate / bufferSize);
  for (let pos = 0, c = 0; pos + bufferSize <= x.length; pos += bufferSize, c++) {
    heap64Set(x.subarray(pos, pos + bufferSize), batchPtr / 8);
    const n = ingest(tg, batchPtr, bufferSize);
    if (n > 0) {
      const ptr = malloc(n * 4);
      copyLastNBeats(tg, n, ptr);
      const beats = new Int32Array(getHeap32().buffer, ptr, n).slice();
      free(ptr);
      diagnoseBeats(beats);
      beatBuf.push(beats);
      beatVis.plot(Array.from(beatBuf.getLastSeconds(beatVis.getXMaxSecSubdiv() - 0.3)));
    }
    if (c % chunksPerSec === 0) await new Promise(r => setTimeout(r, 0));
  }
  console.log(`tgFeedWav done: ${beatBuf.size} beats`);
}
window.tgFeedWav = tgFeedWav;

if (new URLSearchParams(location.search).has('test')) {
  const inp = document.createElement('input');
  inp.type = 'file'; inp.accept = 'audio/*';
  inp.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:99;background:#222;color:#fff;padding:4px';
  inp.onchange = () => inp.files[0] && tgFeedWav(inp.files[0]);
  document.body.appendChild(inp);
  liveCapture.on = true;
  const btn = document.createElement('button');
  btn.textContent = 'Save live capture';
  btn.style.cssText = 'position:fixed;left:8px;bottom:44px;z-index:99;padding:4px 8px';
  btn.onclick = saveLiveCapture;
  document.body.appendChild(btn);
}

function download(name, blob) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

// Saves (1) the exact post-filter audio the detector received, as a 32-bit float WAV, and
// (2) a JSON with the beats the app detected live plus the audio frame counter per chunk.
function saveLiveCapture() {
  const n = liveCapture.chunks.length * bufferSize;
  if (!n) { console.warn('Nothing captured yet: record first'); return; }
  const buf = new ArrayBuffer(44 + n * 4), v = new DataView(buf);
  const str = (o, t) => [...t].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF'); v.setUint32(4, 36 + n * 4, true); str(8, 'WAVEfmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 3, true); v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * 4, true);
  v.setUint16(32, 4, true); v.setUint16(34, 32, true); str(36, 'data'); v.setUint32(40, n * 4, true);
  let o = 44;
  for (const ch of liveCapture.chunks) for (let i = 0; i < ch.length; i++, o += 4) v.setFloat32(o, ch[i], true);
  download('live_capture.wav', new Blob([buf], { type: 'audio/wav' }));
  download('live_beats.json', new Blob([JSON.stringify({
    sampleRate, beatRate: settingsData['beat-rate'], highPass: settingsData['high-pass-filter'],
    detection: settingsData['beat-detection'], droppedFrames,
    beats: beatBuf._beats, chunkStartFrames: liveCapture.frames
  })], { type: 'application/json' }));
}
