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
  $('#presetSelect').val(presetIndex);
}
function prevPreset(blendTime = 5.7) {
  var numPresets = presetKeys.length;
  if (presetIndexHist.length > 0) {
    presetIndex = presetIndexHist.pop();
  } else {
    presetIndex = ((presetIndex - 1) + numPresets) % numPresets;
  }
  visualizer.loadPreset(presets[presetKeys[presetIndex]], blendTime);
  $('#presetSelect').val(presetIndex);
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

$(function() {
    // $(document).keydown((e) => {
    //   if (e.which === 32 || e.which === 39) {
    //     nextPreset();
    //   } else if (e.which === 8 || e.which === 37) {
    //     prevPreset();
    //   } else if (e.which === 72) {
    //     nextPreset(0);
    //   }
    // });
    $('#presetSelect').change((evt) => {
      presetIndexHist.push(presetIndex);
      presetIndex = parseInt($('#presetSelect').val());
      visualizer.loadPreset(presets[presetKeys[presetIndex]], 5.7);
    });
    $('#presetCycle').change(() => {
      presetCycle = $('#presetCycle').is(':checked');
      restartCycleInterval();
    });
    $('#presetCycleLength').change((evt) => {
      presetCycleLength = parseInt($('#presetCycleLength').val() * 1000);
      restartCycleInterval();
    });
    // $('#presetRandom').change(() => {
    //   presetRandom = $('#presetRandom').is(':checked');
    // });
    // $("#localFileBut").click(function() {
    //   $("#audioSelectWrapper").css('display', 'none');
    //   var fileSelector = $('<input type="file" accept="audio/*" multiple />');
    //   fileSelector[0].onchange = function(event) {
    //     loadLocalFiles(fileSelector[0].files);
    //   }
    //   fileSelector.click();
    // });
    // $("#micSelect").click(() => {
    //   $("#audioSelectWrapper").css('display', 'none');
    //   navigator.getUserMedia({ audio: true }, (stream) => {
    //     var micSourceNode = audioContext.createMediaStreamSource(stream);
    //     connectAudio(micSourceNode);
    //   }, (err) => {
    //     console.log('Error getting audio stream from getUserMedia');
    //   });
    // });
    
    // function initPlayer() {
    //   var canvas = document.getElementById('viz-canvas');
    //   audioContext = new AudioContext();
    //   presets = {};
    //   if (window.butterchurnPresets) {
    //     Object.assign(presets, butterchurnPresets.getPresets());
    //   }
    //   if (window.butterchurnPresetsExtra) {
    //     Object.assign(presets, butterchurnPresetsExtra.getPresets());
    //   }
    //   presets = _(presets).toPairs().sortBy(([k, v]) => k.toLowerCase()).fromPairs().value();
    //   presetKeys = _.keys(presets);
    //   presetIndex = Math.floor(Math.random() * presetKeys.length);
    //   var presetSelect = document.getElementById('presetSelect');
    //   for(var i = 0; i < presetKeys.length; i++) {
    //       var opt = document.createElement('option');
    //       opt.innerHTML = presetKeys[i].substring(0,60) + (presetKeys[i].length > 60 ? '...' : '');
    //       opt.value = i;
    //       presetSelect.appendChild(opt);
    //   }
    //   console.log(canvas.clientWidth)
    //   console.log(canvas.clientWidth)
    //   vizSettings.width = document.getElementById("viz-canvas").clientWidth ? document.getElementById("viz-canvas").clientWidth : 800;
    //   vizSettings.height = document.getElementById("viz-canvas").clientHeight ? document.getElementById("viz-canvas").clientHeight : 600;

    //   visualizer = butterchurn.createVisualizer(audioContext, canvas, vizSettings);
    //   nextPreset(0);
    //   cycleInterval = setInterval(() => nextPreset(2.7), presetCycleLength);
    // }
    // initPlayer();
  });

var VIZ = (function () {
  let vizModule = {};

  vizModule.connect = function (audioNode) {
    connectAudio(audioNode)
  }

  vizModule.get = function () {
    return audioContext;
  }

  // TODO: call on window resize
  vizModule.updateSize = function () {
    console.log(document.getElementById("viz-canvas").clientWidth)
    console.log(document.getElementById("viz-canvas").clientHeight)

    vizSettings.width = document.getElementById("viz-canvas").clientWidth;
    vizSettings.height = document.getElementById("viz-canvas").clientHeight;

    visualizer.setRendererSize(vizSettings.width, vizSettings.height)
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
    presets = _(presets).toPairs().sortBy(([k, v]) => k.toLowerCase()).fromPairs().value();
    presetKeys = _.keys(presets);
    presetIndex = Math.floor(Math.random() * presetKeys.length);
    var presetSelect = document.getElementById('presetSelect');
    for(var i = 0; i < presetKeys.length; i++) {
        var opt = document.createElement('option');
        opt.innerHTML = presetKeys[i].substring(0,60) + (presetKeys[i].length > 60 ? '...' : '');
        opt.value = i;
        presetSelect.appendChild(opt);
    }

    vizSettings.width = document.getElementById("viz-canvas").clientWidth ? document.getElementById("viz-canvas").clientWidth : 800;
    vizSettings.height = document.getElementById("viz-canvas").clientHeight ? document.getElementById("viz-canvas").clientHeight : 600;

    visualizer = butterchurn.createVisualizer(audioContext, canvas, vizSettings);
    nextPreset(0);
    cycleInterval = setInterval(() => nextPreset(2.7), presetCycleLength);
    startRenderer();
  }

  return vizModule;
}());
