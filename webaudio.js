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
    
    const ticProfile = new Float64Array(heapf64.buffer, ticPtr, profileSize).slice();
    const tocProfile = new Float64Array(heapf64.buffer, tocPtr, profileSize).slice();
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

  const filter = context.createBiquadFilter();
  filter.type = 'highpass'
  filter.frequency.value = settingsData['high-pass-filter'] || 1000;

  if (!workletModuleLoaded) {
    await context.audioWorklet.addModule("recorder.worklet.js");
    workletModuleLoaded = true;
  }
  recorder = new AudioWorkletNode(context, "recorder.worklet", {processorOptions: {bufferSize: bufferSize}});

  const silentGain = context.createGain();
  silentGain.gain.value = 0;
  recorder.connect(silentGain).connect(context.destination);

  source.connect(filter).connect(recorder)

  recorder.port.onmessage = ({ data }) => {
    const { samples, startFrame } = data;

    heap64Set(samples, batchPtr / 8)
    
    if (mode === 'record') {
      const numNewBeats = ingest(tg, batchPtr, bufferSize)
      if (numNewBeats > 0) {

        const newBeatsPtr = malloc(numNewBeats * 4);
        const count = copyLastNBeats(tg, numNewBeats, newBeatsPtr);
        const beats = new Int32Array(heap32.buffer, newBeatsPtr, numNewBeats).slice();

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
