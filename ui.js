// Wrap the timegrapher functions here, so that we can await the promise in the record and beat rate detection buttons later

let tgReady;
let create;
let destroy;
let ingest;
let estimateBeatRate;
let newBeats;
let getRate;
let getErr;
let getAmp;
let resetEstimate;
let malloc;
let free;
let heap64Set;
let heap32;
let setOptimized;   // ← new: enables template-matching refinement mode

// visualization
let beatVis;
let beatProfileVis;

// estimatedBeatRate
let estimatedBeatRate;


// Wrap timegrapher module functions
tgReady = Module().then(function(Module) {
  create = Module.cwrap('TimeGrapher_create','number',['number','number','number','number']);
  destroy = Module.cwrap('TimeGrapher_destroy', null, ['number']);
  ingest = Module.cwrap('TimeGrapher_ingest_and_compute','number',['number','number','number','number','number','number']);
  estimateBeatRate = Module.cwrap('TimeGrapher_ingest_and_estimate_beat_rate', 'number', ['number','number','number']);
  getRate = Module.cwrap('TimeGrapher_get_rate','number',['number']);
  getErr = Module.cwrap('TimeGrapher_get_beat_error','number',['number']);
  getAmp = Module.cwrap('TimeGrapher_get_amplitude','number',['number']);
  resetEstimate = Module.cwrap('TimeGrapher_reset_beat_rate_estimation', null, ['number']);
  copyLastNBeats = Module.cwrap('TimeGrapher_copy_last_n_beats', 'number', ['number', 'number', 'number']);
  getProfileSize = Module.cwrap('TimeGrapher_get_profile_size', 'number', ['number']);
  copyTicProfile = Module.cwrap('TimeGrapher_copy_tic_profile', null, ['number', 'number']);
  copyTocProfile = Module.cwrap('TimeGrapher_copy_toc_profile', null, ['number', 'number']);
  // Template-matching refinement mode toggle.
  // Call with (tg_ptr, 1) to enable, (tg_ptr, 0) to disable.
  setOptimized = Module.cwrap('TimeGrapher_set_optimized', null, ['number', 'number']);

  malloc = Module._malloc;
  free = Module._free;
  heap64Set = Module.HEAPF64.set.bind(Module.HEAPF64);
  heap32 = Module.HEAP32;
  heapf64 = Module.HEAPF64;
  console.log("Timegrapher WASM ready");
});

async function ensureTimegrapherReady() {
  await tgReady;
}



/* UI configuration */

/* populate settings menu with choices */



// get ui objects

const beatErrorDisplay = document.getElementById("display-beat-error");
const amplitudeDisplay = document.getElementById("display-amplitude");
const rateDisplay = document.getElementById("display-rate");
const parametersDisplay = document.getElementById("display-parameters");

const settingsMenu = document.getElementById('settings-menu');
const widgetContainer = document.getElementById('widget-container');

const settingsButton = document.getElementById('settings-button');
const recordButton = document.getElementById('record-button');
const autoDetectButton = document.getElementById('auto-detect-button');

const beatRateDetectionNotifier = document.getElementById("beat-rate-detection-notifier");
const beatRateDetectionDoneNotifier = document.getElementById("beat-rate-detection-done-notifier");
const estimatedBeatRateDisplay = document.getElementById("estimated-beat-rate-display");

const progressDots = document.getElementById("in-progress-dots");

const beatPlotCanvas = document.getElementById("beat-plot-canvas");
const beatProfileCanvas = document.getElementById("beat-profile-canvas");
const xMinusButton = document.getElementById("x-minus-button");
const xPlusButton = document.getElementById("x-plus-button");
const yMinusButton = document.getElementById("y-minus-button");
const yPlusButton = document.getElementById("y-plus-button");

// Subdivision limits
const MAX_SUBDIVISIONS = 3;

// derived objects
beatVis = new beatPlot(beatPlotCanvas);
beatProfileVis = new WaveformPlot(beatProfileCanvas);

// Beat plot zoom button handlers
function updateBeatPlotSubdivisions(deltaX, deltaY) {
    let newXSubsDiv = beatVis.xSubdivisions + deltaX;
    let newYSubsDiv = beatVis.ySubdivisions + deltaY;
    
    // Clamp values between 0 and MAX_SUBDIVISIONS
    newXSubsDiv = Math.max(0, Math.min(MAX_SUBDIVISIONS, newXSubsDiv));
    newYSubsDiv = Math.max(0, Math.min(MAX_SUBDIVISIONS, newYSubsDiv));
    
    beatVis.setPlotParams(beatVis.sampleRate, beatVis.beatRate, newXSubsDiv, newYSubsDiv);
    // Trigger a redraw if we have beat data
    if (window.beatBuf) {
        beatVis.plot(Array.from(window.beatBuf.getLastSeconds(beatVis.getXMaxSecSubdiv() - 0.3)));
    }
}

xMinusButton.addEventListener('click', () => updateBeatPlotSubdivisions(-1, 0));
xPlusButton.addEventListener('click', () => updateBeatPlotSubdivisions(1, 0));
yMinusButton.addEventListener('click', () => updateBeatPlotSubdivisions(0, -1));
yPlusButton.addEventListener('click', () => updateBeatPlotSubdivisions(0, 1));

function resizeCanvases() {
    beatPlotCanvas.width = beatPlotCanvas.clientWidth;
    beatPlotCanvas.height = beatPlotCanvas.clientHeight;
    beatProfileCanvas.width = beatProfileCanvas.clientWidth;
    beatProfileCanvas.height = beatProfileCanvas.clientHeight;
    beatVis.drawGrid();
}

window.addEventListener('resize', resizeCanvases);
window.addEventListener('load', resizeCanvases);


function setDiagnosticsDisplay(rate, amplitude, beatError) {
    // Rate: s/d with + sign for positive numbers
    if (rate && rate !== 0) {
        const sign = rate > 0 ? '+' : '';
        rateDisplay.innerText = sign + rate.toLocaleString("en-EN", { maximumFractionDigits: 0 }) + ' s/d';
    } else {
        rateDisplay.innerText = '-';
    }
    
    // Amplitude: degree sign
    if (amplitude && amplitude !== 0) {
        amplitudeDisplay.innerText = amplitude.toLocaleString("en-EN", { maximumFractionDigits: 0 }) + '°';
    } else {
        amplitudeDisplay.innerText = '-';
    }
    
    // Beat error: ms
    if (beatError && beatError !== 0) {
        beatErrorDisplay.innerText = beatError.toLocaleString("en-EN", { maximumFractionDigits: 1 }) + ' ms';
    } else {
        beatErrorDisplay.innerText = '-';
    }
}


const settingsConfig = [
{
    key: 'beat-rate',
    label: 'beat rate',
    hasWidget: true,
    suffix: ''
},
{
    key: 'lift-angle',
    label: 'lift angle',
    hasWidget: true,
    suffix: '°'
},
{
    key: 'beat-detection',
    label: 'beat detection',
    hasWidget: true,
    suffix: ''
},
{
    key: 'audio-input',
    label: 'audio input',
    hasWidget: true,
    suffix: ''
},
{
    key: 'high-pass-filter',
    label: 'high-pass filter',
    hasWidget: true,
    suffix: ' Hz'
},
{
    key: 'signal-smoothing-window',
    label: 'signal smoothing window',
    hasWidget: true,
    suffix: ' ms'
}
];

widgetConfig = {
    'beat-rate': { label:'beat rate', type:'preset', presets:[14400, 16200, 17280, 18000, 19800, 21600, 25200, 28800, 36000, 43200], suffix:'', customRange:{min:3600,max:360000} },
    'lift-angle': { label:'lift angle', type:'drag', range:{min:30,max:70}, sensitivity:0.1, precision:0, suffix:'°' },
    // 'pulse start'          – standard energy-envelope peak detector (original algorithm)
    // 'template matching' – same coarse detector followed by TKEO template-matching refinement
    'beat-detection':{ label:'beat detection', type:'select', options:['pulse start','template matching'], suffix:'' },
    'high-pass-filter':{ label:'high-pass filter', type:'drag', range:{min:0,max:5000}, sensitivity:4.0, precision:0, suffix:' Hz' },
    'signal-smoothing-window':{ label:'signal smoothing window', type:'drag', range:{min:0.0, max:3.0}, sensitivity:0.008, precision:1, suffix:' ms' },
    'audio-input':{ label:'audio input', type:'select', options:['mic A', 'mic B', 'mic C'], suffix:'' }
}

const settingsData = {
    'beat-rate': 21600,
    'lift-angle': 52,
    'beat-detection': 'pulse start',
    'high-pass-filter': 2000,
    'signal-smoothing-window': 0.4,
    'audio-input': 'mic A'
};


settingsMenu.configure(settingsConfig);
settingsMenu.refreshSettingsValues(settingsData); // default values

/* Confgure the widgetContainer with the widgets it needs to contain */
widgetContainer.configureWidgets(widgetConfig)


/* Add event listeners to the settings button, and to the page, for clicks outside the settings menu */

settingsButton.addEventListener('click', (event) => {
    if (!settingsMenu.checkVisibility()) {
        event.stopImmediatePropagation();
        settingsMenu.show();
        widgetContainer.hide();
    }
});

/* Add event listener to the settings menu, and listen for the custom event "setting-clicked", which contains information about which setting was clicked, and its current value */

settingsMenu.addEventListener('setting-clicked', (e) => {
    const { settingKey, currentValue } = e.detail;

    // HIDE the settings list before showing the widget:
    settingsMenu.hide();
    widgetContainer.showWidget(
    settingKey,
    currentValue,
    (newValue) => {
        // Whenever the widget reports a new value, store it:
        settingsData[settingKey] = newValue;

        // If the user is changing the beat rate, update the beat plot visualization instantly
        if (settingKey === 'beat-rate' && window.beatBuf) {
            beatVis.setPlotParams(beatVis.sampleRate, settingsData['beat-rate'], beatVis.xSubdivisions, beatVis.ySubdivisions);
            beatVis.plot(Array.from(window.beatBuf.getLastSeconds(beatVis.getXMaxSecSubdiv() - 0.3)));
        }
    },
    () => {
        // "Back" button in widget: hide widget, then re-show settings list

        widgetContainer.hide();
        // new settings update here
        settingsMenu.refreshSettingsValues(settingsData) 
        settingsMenu.show();

        // If the user changed the audio input device, switch the microphone stream now.
        if (settingKey === 'audio-input') {
            changeMicrophone();
        }
    }
    );
});

function handleOutsideClick(event) {

    // settings menu disappear when clicking something else
    if (!settingsMenu.contains(event.target) & settingsMenu.checkVisibility() & !widgetContainer.contains(event.target)) {
        // Click was outside settingsMenu
        settingsMenu.hide();
    }
    if (!recordButton.contains(event.target)) {
        // Click was outside recordButton
    }
}

// Event listener to cancel stuff when clicking outside
document.addEventListener('click', handleOutsideClick);



// Cycle between beat rate and lift angle in the parameter display
let showBeat = true;
function updateParameterDisplay() {
    if (showBeat) {
    parametersDisplay.textContent = `${settingsData['beat-rate']} BPH`;
    } else {
    parametersDisplay.textContent = `${settingsData['lift-angle']}°`;
    }
    showBeat = !showBeat;
}
updateParameterDisplay();
setInterval(updateParameterDisplay, 4000); // calls the function repeatedly


// Add a custom state to replace :active for buttons - to prevent delay in transitioning to the active state



// Get all buttons that need instant touch feedback

const buttons = document.querySelectorAll('.button-row button');

buttons.forEach(button => {
    // Function to add active state

    const activate = () => {
        button.classList.add('touch-active');
    };
    
    // Function to remove active state
    const deactivate = () => {
        button.classList.remove('touch-active');
    };
    
    // Touch events (mobile)
    button.addEventListener('touchstart', activate);
    button.addEventListener('touchend', deactivate);
    button.addEventListener('touchcancel', deactivate);
    
    // Mouse events (desktop) - for testing
    button.addEventListener('mousedown', activate);
    button.addEventListener('mouseup', deactivate);
    button.addEventListener('mouseleave', deactivate);
});


// Add "animation" for auto detection of beat rate

const updateProgressDots = () => {
    if (progressDots.innerHTML.length < 5) {
        progressDots.innerHTML += '.';
    } else {
        progressDots.innerHTML = '.';
    }
}

const showAutoDetectionInProgress = () => {
    progressDotsInterval = setInterval(updateProgressDots, 300); // calls the function repeatedly
    beatRateDetectionNotifier.style.display = 'block';
}


const hideAutoDetectionInProgress = () => {
    if (typeof(progressDotsInterval) != "undefined") {
        clearInterval(progressDotsInterval);
    }
    beatRateDetectionNotifier.style.display = "none";
}

const showAutoDetectionDone = () => {
    // show the estimated beat rate for one second, then hide the notifier again
    estimatedBeatRateDisplay.textContent = `${settingsData['beat-rate']}`;
    beatRateDetectionDoneNotifier.style.display = 'block';
    setTimeout(() => {
        beatRateDetectionDoneNotifier.style.display = 'none';
    }, 2000);
}

const hideAutoDetectionDone = () => {
    beatRateDetectionDoneNotifier.style.display = 'none';
}


// Toggle behavior for recoding and auto-detection buttons

// also add touchstart

// use mutation event listeners to check for button state change
recordButton.setAttribute('data-recording-active', 'false');
autoDetectButton.setAttribute('data-autodetection-active', 'false');



recordButton.addEventListener('click', async () => {
    await ensureTimegrapherReady();
    if (recordButton.getAttribute('data-recording-active') === 'false') {
        recordButton.classList.add('recording-active');
        recordButton.setAttribute('data-recording-active', 'true');
        // recording and auto detection are exclusive
        autoDetectButton.classList.remove('autodetection-active');
        autoDetectButton.setAttribute('data-autodetection-active', 'false');
    } else {
        recordButton.classList.remove('recording-active');  
        recordButton.setAttribute('data-recording-active', 'false');
    }
});

autoDetectButton.addEventListener('click', async () => {
    await ensureTimegrapherReady();
    if (autoDetectButton.getAttribute('data-autodetection-active') === 'false') {
        autoDetectButton.classList.add('autodetection-active');
        autoDetectButton.setAttribute('data-autodetection-active', 'true');
        // recording and auto detection are exclusive
        recordButton.classList.remove('recording-active');
        recordButton.setAttribute('data-recording-active', 'false');
    } else {
        autoDetectButton.classList.remove('autodetection-active');
        autoDetectButton.setAttribute('data-autodetection-active', 'false');
    }

});


const updateAudioInput = (deviceList, defaultValue=null) => {
    if (deviceList.length > 0) {
        widgetConfig['audio-input']['options'] = deviceList;
        sd = settingsMenu.getData();
        if (deviceList.includes(defaultValue)) {
            sd['audio-input'] = defaultValue;
        } else {
            sd['audio-input'] = deviceList[0];
        }
        settingsMenu.refreshSettingsValues(sd); // default values
    }
}
