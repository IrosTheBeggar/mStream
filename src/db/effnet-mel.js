// Pure-JS mel front-end for Discogs-EffNet — a drop-in replacement for
// essentia.js's TensorflowInputMusiCNN, ~20× faster (no per-frame WASM
// boundary crossings; typed-array FFT + sparse filterbank).
//
// ⚠ PARITY CONTRACT: EffNet was trained on essentia's exact mel pipeline, so
// this implementation must match it bit-closely or embedding quality degrades
// SILENTLY. The exact configuration was established empirically by grid-
// searching the parameter space against the golden essentia output
// (max abs diff 1.7e-5 on real music — float32 noise floor):
//
//   frame 512, hop 256, Hann window (NOT normalized), POWER spectrum,
//   96 mel bands 0–8000 Hz on the SLANEY scale (linear < 1 kHz, log above),
//   area-normalized triangles (essentia's 'unit_tri': × 2/(f_right−f_left)),
//   compression log10(1 + 10000·x).
//
// test/db/effnet-mel-parity.test.mjs re-derives the golden output from
// essentia.js on every run — any drift here (or an essentia upgrade that
// changes the reference) fails loudly instead of degrading quietly.

export const MEL_FRAME_SIZE = 512;
export const MEL_HOP_SIZE = 256;
export const MEL_BANDS = 96;
export const MEL_SAMPLE_RATE = 16000;
const SPEC_BINS = MEL_FRAME_SIZE / 2 + 1;
const LOW_HZ = 0;
const HIGH_HZ = 8000;

// Slaney mel scale: linear below 1 kHz, logarithmic above.
function hzToMel(f) {
  return f < 1000 ? (f * 3) / 200 : 15 + 27 * (Math.log(f / 1000) / Math.log(6.4));
}
function melToHz(m) {
  return m < 15 ? (m * 200) / 3 : 1000 * Math.pow(6.4, (m - 15) / 27);
}

/**
 * Precomputed mel extractor. Create ONCE per worker run and reuse — the
 * window, FFT twiddles/bit-reversal, and sparse filterbank are all built
 * here; melFrames() then allocates only its output rows.
 */
export function createMelExtractor() {
  const N = MEL_FRAME_SIZE;

  // Hann window, essentia-style (unnormalized): 0.5 − 0.5·cos(2πi/(N−1)).
  const window = new Float64Array(N);
  for (let i = 0; i < N; i++) { window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1)); }

  // Iterative radix-2 FFT tables.
  const rev = new Uint32Array(N);
  for (let i = 0, j = 0; i < N; i++) {
    rev[i] = j;
    let bit = N >> 1;
    for (; j & bit; bit >>= 1) { j ^= bit; }
    j ^= bit;
  }
  const cosT = new Float64Array(N / 2);
  const sinT = new Float64Array(N / 2);
  for (let i = 0; i < N / 2; i++) {
    cosT[i] = Math.cos((-2 * Math.PI * i) / N);
    sinT[i] = Math.sin((-2 * Math.PI * i) / N);
  }

  // Sparse mel filterbank: 96 area-normalized triangles on the Slaney scale.
  // Stored flat per band as [binIndex, weight, binIndex, weight, ...].
  const loMel = hzToMel(LOW_HZ);
  const hiMel = hzToMel(HIGH_HZ);
  const centers = new Float64Array(MEL_BANDS + 2);
  for (let i = 0; i < MEL_BANDS + 2; i++) {
    centers[i] = melToHz(loMel + ((hiMel - loMel) * i) / (MEL_BANDS + 1));
  }
  const binHz = MEL_SAMPLE_RATE / N;
  const filterbank = [];
  for (let b = 0; b < MEL_BANDS; b++) {
    const fl = centers[b];
    const fc = centers[b + 1];
    const fr = centers[b + 2];
    const areaNorm = 2 / (fr - fl);   // 'unit_tri'
    const flat = [];
    for (let k = 0; k < SPEC_BINS; k++) {
      const f = k * binHz;
      if (f < fl || f > fr) { continue; }
      const w = f <= fc
        ? (fc === fl ? 1 : (f - fl) / (fc - fl))
        : (fr === fc ? 1 : (fr - f) / (fr - fc));
      if (w > 0) { flat.push(k, w * areaNorm); }
    }
    filterbank.push(Float64Array.from(flat));
  }

  // Reusable scratch buffers (single-threaded worker — no reentrancy).
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  const power = new Float64Array(SPEC_BINS);

  /**
   * Signal → mel rows: one Float32Array(96) per frame (hop 256), matching
   * essentia's TensorflowInputMusiCNN output. Trailing partial frame dropped,
   * like the previous implementation.
   */
  function melFrames(signal) {
    const rows = [];
    for (let start = 0; start + N <= signal.length; start += MEL_HOP_SIZE) {
      // Window into the FFT buffers.
      for (let i = 0; i < N; i++) {
        re[rev[i]] = signal[start + i] * window[i];
      }
      im.fill(0);
      // In-place FFT — but bit-reversal wrote re[] permuted, so im must be
      // permuted identically; it's all zeros, so fill(0) suffices.
      for (let len = 2; len <= N; len <<= 1) {
        const half = len >> 1;
        const step = N / len;
        for (let i = 0; i < N; i += len) {
          for (let j = 0; j < half; j++) {
            const k = j * step;
            const xr = re[i + j + half];
            const xi = im[i + j + half];
            const tre = xr * cosT[k] - xi * sinT[k];
            const tim = xr * sinT[k] + xi * cosT[k];
            re[i + j + half] = re[i + j] - tre;
            im[i + j + half] = im[i + j] - tim;
            re[i + j] += tre;
            im[i + j] += tim;
          }
        }
      }
      // Power spectrum → sparse filterbank → log compression.
      for (let k = 0; k < SPEC_BINS; k++) { power[k] = re[k] * re[k] + im[k] * im[k]; }
      const row = new Float32Array(MEL_BANDS);
      for (let b = 0; b < MEL_BANDS; b++) {
        const fb = filterbank[b];
        let acc = 0;
        for (let i = 0; i < fb.length; i += 2) { acc += power[fb[i]] * fb[i + 1]; }
        row[b] = Math.log10(1 + 10000 * acc);
      }
      rows.push(row);
    }
    return rows;
  }

  return { melFrames };
}
