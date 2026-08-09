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
    // Gate on `visualizer`, not `isInit`. Since the butterchurn bundles are
    // now fetched on demand, isInit goes true the moment the overlay opens
    // but the visualizer object does not exist until the load resolves — a
    // song change in that window reaches here via VIZ.connect and would
    // dereference null. renderSource is still recorded above, and
    // startVisualizer() ends with a bare startRenderer() that picks it up.
    if(visualizer && isInit === true && renderSource) {
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
    // `visualizer` for the same reason as startRenderer: isInit can be true
    // while the on-demand bundle load is still in flight, and updateSize
    // calls straight into visualizer.setRendererSize.
    if (!document.getElementById("viz-canvas").clientWidth || !isInit || !visualizer) {
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

  // butterchurn + its two preset packs are ~1.65 MB unminified — the single
  // largest thing the webapp used to download, on every page load, for a
  // feature behind a click. They are fetched here on first open instead.
  // The promise is cached, so a second open (or a double click) reuses the
  // in-flight or completed load rather than injecting the tags twice.
  var butterchurnLoad = null;
  function loadButterchurn() {
    if (butterchurnLoad) { return butterchurnLoad; }
    // Order matters: the preset packs register themselves against globals
    // the core defines, so they are chained rather than fired in parallel.
    var files = [
      'assets/js/lib/butterchurn.min.js',
      'assets/js/lib/butterchurn-presets.min.js',
      'assets/js/lib/butterchurn-presets-extra.js'
    ];
    butterchurnLoad = files.reduce(function (chain, src) {
      return chain.then(function () {
        return new Promise(function (resolve, reject) {
          var s = document.createElement('script');
          s.src = src;
          s.onload = resolve;
          // Reject rather than hang: initPlayer resets isInit on failure so
          // a later click can retry (a flaky first load shouldn't kill the
          // visualizer for the rest of the session).
          s.onerror = function () { reject(new Error('failed to load ' + src)); };
          document.head.appendChild(s);
        });
      });
    }, Promise.resolve());
    return butterchurnLoad;
  }

  vizModule.initPlayer = function () {
    if(isInit === true) {
      return false;
    }
    isInit = true;

    // .catch AFTER .then, not a second .then argument: an onRejected
    // handler passed to .then only sees rejections from the promise BEFORE
    // it, so a throw inside startVisualizer — createVisualizer does throw
    // when the browser has no WebGL2, which is a real configuration —
    // would escape as an unhandled rejection with isInit stuck true,
    // leaving the visualizer permanently dead for the session and never
    // running the recovery below.
    loadButterchurn()
      .catch(function (err) {
        // The download itself failed; drop the cached promise so a later
        // click re-fetches rather than reusing a rejected one.
        butterchurnLoad = null;
        throw err;
      })
      .then(startVisualizer)
      .catch(function (err) {
        console.error('[viz] ' + err.message);
        isInit = false;   // let a later click try again
      });
  }

  function startVisualizer() {
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
