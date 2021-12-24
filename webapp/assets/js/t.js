var VIZ = (() => {
  let vizModule = {};

  var visualizer = null;
  var audioContext = new AudioContext();
  var vizSettings = {
    width: 800,
    height: 600,
    pixelRatio: window.devicePixelRatio || 1,
    textureRatio: 1
  }
  var cycleInterval = null;
  var presets = {};
  var presetKeys = [];
  var presetIndexHist = [];
  var presetIndex = 0;
  var presetCycle = true;
  var presetCycleLength = 15000;
  var presetRandom = true;
  
  var isInit = false;
  
  var renderSource = null;
  function startRenderer(source) {
    if(source) {
      renderSource = source;
    }
    if(isInit === true && renderSource) {
      visualizer.connectAudio(renderSource);
  
      requestAnimationFrame(() => startRenderer());
      visualizer.render();
    }
  }
  
  function connectAudio(sourceNode) {
    audioContext.resume();
    var gainNode = audioContext.createGain();
    var biquadFilter = audioContext.createBiquadFilter();
  
    gainNode.gain.value = 1.25;
    sourceNode.connect(gainNode);
    gainNode.connect(biquadFilter)
    startRenderer(biquadFilter);
    // startRenderer(sourceNode);
  }
  function nextPreset(blendTime = 5.7) {
    presetIndexHist.push(presetIndex);
    var numPresets = presetKeys.length;
    if (presetRandom) {
      presetIndex = Math.floor(Math.random() * presetKeys.length);
    } else {
      presetIndex = (presetIndex + 1) % numPresets;
    }
    visualizer.loadPreset(presets[presetKeys[presetIndex]], blendTime);
    document.getElementById('presetSelect').value = presetIndex;
  }
  function prevPreset(blendTime = 5.7) {
    var numPresets = presetKeys.length;
    if (presetIndexHist.length > 0) {
      presetIndex = presetIndexHist.pop();
    } else {
      presetIndex = ((presetIndex - 1) + numPresets) % numPresets;
    }
    visualizer.loadPreset(presets[presetKeys[presetIndex]], blendTime);
    document.getElementById('presetSelect').value = presetIndex;
  }
  function restartCycleInterval() {
    if (cycleInterval) {
      clearInterval(cycleInterval);
      cycleInterval = null;
    }
    if (presetCycle) {
      cycleInterval = setInterval(() => nextPreset(2.7), presetCycleLength);
    }
  }
  
  // NOTE: These controls are not accessible to the user currently
  // $('#presetSelect').change((evt) => {
  //   presetIndexHist.push(presetIndex);
  //   presetIndex = parseInt($('#presetSelect').val());
  //   visualizer.loadPreset(presets[presetKeys[presetIndex]], 5.7);
  // });
  // $('#presetCycle').change(() => {
  //   presetCycle = $('#presetCycle').is(':checked');
  //   restartCycleInterval();
  // });
  // $('#presetCycleLength').change((evt) => {
  //   presetCycleLength = parseInt($('#presetCycleLength').val() * 1000);
  //   restartCycleInterval();
  // });

  vizModule.connect = function (audioNode) {
    connectAudio(audioNode)
  }

  vizModule.get = function () {
    return audioContext;
  }

  vizModule.updateSize = function () {
    var canvas = document.getElementById('viz-canvas');
    vizSettings.width = canvas.clientWidth;
    vizSettings.height = canvas.clientHeight;
    canvas.width = vizSettings.width;
    canvas.height = vizSettings.height;

    visualizer.setRendererSize(vizSettings.width, vizSettings.height)
  }

  function reportWindowSize() {
    if (!document.getElementById("viz-canvas").clientWidth || !isInit) {
      return;
    }
    vizModule.updateSize();
  }
  window.onresize = reportWindowSize;

  vizModule.toggleDom = () => {
    document.getElementById('main-overlay').classList.toggle('hide-fade');
    document.getElementById('main-overlay').classList.toggle('show-fade');
    VIZ.initPlayer();
  }

  vizModule.initPlayer = function () {
    if(isInit === true) {
      return false;
    }
    isInit = true;

    var canvas = document.getElementById('viz-canvas');
    // audioContext = new AudioContext();
    presets = {};
    if (window.butterchurnPresets) {
      Object.assign(presets, butterchurnPresets.getPresets());
    }
    if (window.butterchurnPresetsExtra) {
      Object.assign(presets, butterchurnPresetsExtra.getPresets());
    }
    
    presetKeys = Object.keys(presets);

    presetIndex = Math.floor(Math.random() * presetKeys.length);
    var presetSelect = document.getElementById('presetSelect');
    for (var i = 0; i < presetKeys.length; i++) {
        var opt = document.createElement('option');
        opt.innerHTML = presetKeys[i].substring(0,60) + (presetKeys[i].length > 60 ? '...' : '');
        opt.value = i;
        presetSelect.appendChild(opt);
    }

    vizSettings.width = document.getElementById("viz-canvas").clientWidth ? document.getElementById("viz-canvas").clientWidth : 800;
    vizSettings.height = document.getElementById("viz-canvas").clientHeight ? document.getElementById("viz-canvas").clientHeight : 600;
    canvas.width = vizSettings.width;
    canvas.height = vizSettings.height;

    visualizer = butterchurn.default.createVisualizer(audioContext, canvas, vizSettings);
    nextPreset(0);
    cycleInterval = setInterval(() => nextPreset(2.7), presetCycleLength);
    startRenderer();
  }

  return vizModule;
})();
