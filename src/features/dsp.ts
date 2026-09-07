/*
 * Small DSP kit for the feature extractor. Everything here is allocation-aware:
 * the pipeline runs it tens of thousands of times, so scratch buffers are
 * cached per size rather than rebuilt per call.
 */

const windowCache = new Map<number, Float32Array>();

export function hann(size: number): Float32Array {
  let w = windowCache.get(size);
  if (!w) {
    w = new Float32Array(size);
    for (let i = 0; i < size; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size);
    windowCache.set(size, w);
  }
  return w;
}

interface FftTables {
  cos: Float32Array;
  sin: Float32Array;
  rev: Uint32Array;
}

const fftCache = new Map<number, FftTables>();

function fftTables(n: number): FftTables {
  let t = fftCache.get(n);
  if (t) return t;
  const levels = Math.log2(n) | 0;
  if (1 << levels !== n) throw new Error(`FFT size ${n} is not a power of two`);
  const cos = new Float32Array(n / 2);
  const sin = new Float32Array(n / 2);
  for (let i = 0; i < n / 2; i++) {
    cos[i] = Math.cos((2 * Math.PI * i) / n);
    sin[i] = Math.sin((2 * Math.PI * i) / n);
  }
  const rev = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    let x = i;
    let r = 0;
    for (let j = 0; j < levels; j++) {
      r = (r << 1) | (x & 1);
      x >>= 1;
    }
    rev[i] = r;
  }
  t = { cos, sin, rev };
  fftCache.set(n, t);
  return t;
}

/** In-place iterative radix-2 complex FFT. */
export function fft(re: Float32Array, im: Float32Array): void {
  const n = re.length;
  const { cos, sin, rev } = fftTables(n);
  for (let i = 0; i < n; i++) {
    const j = rev[i];
    if (j > i) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1;
    const step = n / size;
    for (let i = 0; i < n; i += size) {
      for (let j = i, k = 0; j < i + half; j++, k += step) {
        const l = j + half;
        const tre = re[l] * cos[k] + im[l] * sin[k];
        const tim = -re[l] * sin[k] + im[l] * cos[k];
        re[l] = re[j] - tre;
        im[l] = im[j] - tim;
        re[j] += tre;
        im[j] += tim;
      }
    }
  }
}

const scratch = new Map<number, { re: Float32Array; im: Float32Array; mag: Float32Array }>();

function scratchFor(n: number) {
  let s = scratch.get(n);
  if (!s) {
    s = { re: new Float32Array(n), im: new Float32Array(n), mag: new Float32Array(n / 2 + 1) };
    scratch.set(n, s);
  }
  return s;
}

/**
 * Magnitude spectrum of a Hann-windowed frame. The returned array is reused
 * between calls for the same size - copy it if you need to keep it.
 */
export function magnitudeSpectrum(samples: Float32Array, offset: number, size: number): Float32Array {
  const { re, im, mag } = scratchFor(size);
  const w = hann(size);
  const end = Math.min(samples.length, offset + size);
  for (let i = 0; i < size; i++) {
    const idx = offset + i;
    re[i] = idx < end ? samples[idx] * w[i] : 0;
    im[i] = 0;
  }
  fft(re, im);
  for (let i = 0; i <= size / 2; i++) mag[i] = Math.hypot(re[i], im[i]);
  return mag;
}

/** Frame-wise RMS. Returns one value per hop. */
export function rmsEnvelope(samples: Float32Array, frame: number, hop: number): Float32Array {
  const count = Math.max(1, Math.floor((samples.length - frame) / hop) + 1);
  const out = new Float32Array(count);
  for (let f = 0; f < count; f++) {
    const start = f * hop;
    let sum = 0;
    for (let i = 0; i < frame; i++) {
      const s = samples[start + i];
      sum += s * s;
    }
    out[f] = Math.sqrt(sum / frame);
  }
  return out;
}

export function spectralCentroid(mag: Float32Array, sampleRate: number, size: number): number {
  let num = 0;
  let den = 0;
  const binHz = sampleRate / size;
  for (let i = 1; i < mag.length; i++) {
    const m = mag[i];
    num += m * i * binHz;
    den += m;
  }
  return den > 0 ? num / den : 0;
}

export function spectralSpread(mag: Float32Array, sampleRate: number, size: number, centroid: number): number {
  let num = 0;
  let den = 0;
  const binHz = sampleRate / size;
  for (let i = 1; i < mag.length; i++) {
    const m = mag[i];
    const d = i * binHz - centroid;
    num += m * d * d;
    den += m;
  }
  return den > 0 ? Math.sqrt(num / den) : 0;
}

/** Geometric mean over arithmetic mean of the power spectrum: 0 tonal, 1 noisy. */
export function spectralFlatness(mag: Float32Array): number {
  let logSum = 0;
  let sum = 0;
  let n = 0;
  for (let i = 1; i < mag.length; i++) {
    const p = mag[i] * mag[i] + 1e-20;
    logSum += Math.log(p);
    sum += p;
    n++;
  }
  if (n === 0 || sum <= 0) return 0;
  return Math.exp(logSum / n) / (sum / n);
}

export interface HarmonicAnalysis {
  /**
   * Share of spectral energy that is not near a harmonic of f0, rescaled so
   * that a flat noise spectrum reads 1 rather than reading the width of the
   * harmonic windows. 0 is tonal, 1 is clangorous.
   */
  inharmonicity: number;
  /** Raw share of energy falling inside the harmonic windows. */
  harmonicFraction: number;
  /** Fraction of the analysed spectrum the harmonic windows cover. */
  coverage: number;
  /** Odd-harmonic energy over total harmonic energy. 0.5 is balanced. */
  oddEvenRatio: number;
  /** Highest harmonic number carrying more than 1% of the harmonic energy. */
  brightnessHarmonic: number;
}

/** Half-width of each harmonic window, as a fraction of the harmonic spacing. */
const HARMONIC_WINDOW = 0.15;

/**
 * Compare the spectrum against the harmonic series of a known f0.
 *
 * The played pitch is derived from the patch rather than tracked, which is what
 * makes this reliable on bells and other patches where pitch tracking fails -
 * but it does mean f0 has to account for the voice transpose and the lowest
 * carrier's frequency ratio, not just the MIDI note.
 */
export function harmonicAnalysis(
  mag: Float32Array, sampleRate: number, size: number, f0: number, maxHarmonic = 40,
): HarmonicAnalysis {
  const binHz = sampleRate / size;
  const nyquistBin = mag.length - 1;
  const tolerance = Math.max(2, (f0 * HARMONIC_WINDOW) / binHz);

  let total = 0;
  for (let i = 1; i < mag.length; i++) total += mag[i] * mag[i];
  if (total <= 0 || f0 <= 0) {
    return { inharmonicity: 0, harmonicFraction: 1, coverage: 1, oddEvenRatio: 0.5, brightnessHarmonic: 0 };
  }

  let harmonic = 0;
  let odd = 0;
  let even = 0;
  let covered = 0;
  let highest = 0;
  const perHarmonic: number[] = [];

  for (let h = 1; h <= maxHarmonic; h++) {
    const centre = (h * f0) / binHz;
    if (centre > nyquistBin) break;
    const lo = Math.max(1, Math.round(centre - tolerance));
    const hi = Math.min(nyquistBin, Math.round(centre + tolerance));
    let e = 0;
    for (let i = lo; i <= hi; i++) e += mag[i] * mag[i];
    perHarmonic.push(e);
    covered += hi - lo + 1;
    harmonic += e;
    if (h % 2 === 1) odd += e;
    else even += e;
  }

  for (let h = 0; h < perHarmonic.length; h++) {
    if (harmonic > 0 && perHarmonic[h] / harmonic > 0.01) highest = h + 1;
  }

  const harmonicFraction = harmonic / total;
  const coverage = Math.min(0.95, covered / Math.max(1, nyquistBin));
  // Rescale so uncorrelated energy reads 1: a flat spectrum lands `coverage` of
  // its energy in the windows purely by chance.
  const inharmonicity = Math.max(0, Math.min(1, (1 - harmonicFraction) / (1 - coverage)));

  return { inharmonicity, harmonicFraction, coverage, oddEvenRatio: odd + even > 0 ? odd / (odd + even) : 0.5, brightnessHarmonic: highest };
}

export interface ModulationDepth {
  /** Pitch deviation of the fundamental, in cents, 5th to 95th percentile. */
  vibratoCents: number;
  /** Amplitude wobble of the fundamental: standard deviation over mean. */
  tremoloDepth: number;
  /** Frames that carried enough signal to measure. */
  frames: number;
}

const MOD_FRAME = 1024;
const MOD_HOP = 256;

/**
 * Measure how much the fundamental wobbles, in pitch and in amplitude.
 *
 * The obvious way to quantify a mod wheel's effect - subtract the dry render
 * from the wet one and take the RMS - does not work: past a few cents of
 * vibrato the two signals are simply uncorrelated, the difference pins at
 * sqrt(2) times the dry level, and a gentle patch scores the same as a violent
 * one. So instead this tracks the FFT bin at the fundamental across frames and
 * reads the phase advance, which gives instantaneous frequency directly and
 * keeps scaling all the way up.
 */
export function modulationDepth(
  samples: Float32Array, sampleRate: number, f0: number, from: number, to: number,
): ModulationDepth {
  const empty = { vibratoCents: 0, tremoloDepth: 0, frames: 0 };
  if (f0 <= 0) return empty;
  const k0 = Math.round((f0 * MOD_FRAME) / sampleRate);
  if (k0 < 1 || k0 >= MOD_FRAME / 2) return empty;

  const w = hann(MOD_FRAME);
  const re = new Float32Array(MOD_FRAME);
  const im = new Float32Array(MOD_FRAME);
  const expected = (2 * Math.PI * k0 * MOD_HOP) / MOD_FRAME;

  const freqs: number[] = [];
  const binAmps: number[] = [];
  let lastPhase = 0;
  let havePhase = false;
  let peakAmp = 0;

  for (let off = Math.max(0, Math.floor(from)); off + MOD_FRAME <= Math.min(samples.length, to); off += MOD_HOP) {
    for (let i = 0; i < MOD_FRAME; i++) {
      re[i] = samples[off + i] * w[i];
      im[i] = 0;
    }
    fft(re, im);
    const a = Math.hypot(re[k0], im[k0]);
    const phase = Math.atan2(im[k0], re[k0]);
    if (a > peakAmp) peakAmp = a;
    binAmps.push(a);
    if (havePhase) {
      let d = phase - lastPhase - expected;
      // Wrap into (-pi, pi]: the phase advance we expect is already removed, so
      // what is left is the deviation from the nominal bin frequency.
      d -= 2 * Math.PI * Math.round(d / (2 * Math.PI));
      const hz = ((k0 / MOD_FRAME) + d / (2 * Math.PI * MOD_HOP)) * sampleRate;
      freqs.push(hz);
    }
    lastPhase = phase;
    havePhase = true;
  }

  if (binAmps.length < 4 || peakAmp <= 0) return empty;

  // Only trust frames where the fundamental is actually present.
  const floor = peakAmp * 0.1;
  const goodFreqs: number[] = [];
  let good = 0;
  for (let i = 0; i < binAmps.length; i++) {
    if (binAmps[i] < floor) continue;
    good++;
    if (i > 0 && i - 1 < freqs.length) goodFreqs.push(freqs[i - 1]);
  }
  if (good < 4 || goodFreqs.length < 4) return empty;

  const sortedF = goodFreqs.slice().sort((a, b) => a - b);
  const lo = sortedF[Math.floor(sortedF.length * 0.05)];
  const hi = sortedF[Math.min(sortedF.length - 1, Math.ceil(sortedF.length * 0.95))];
  const vibratoCents = lo > 0 && hi > 0 ? Math.abs(1200 * Math.log2(hi / lo)) : 0;

  return { vibratoCents, tremoloDepth: tremoloOf(samples, sampleRate, from, to), frames: good };
}

/**
 * Amplitude wobble, measured on the broadband envelope rather than on the
 * fundamental's bin.
 *
 * Reading it off the bin looked simpler but was wrong: when a patch vibratos,
 * the fundamental slides in and out of its bin and the bin's amplitude swings
 * wildly, so pure pitch modulation registered as heavy tremolo. The broadband
 * envelope does not care where the energy sits in frequency. A moving average
 * is subtracted first so that the note's own decay is not counted as wobble.
 */
function tremoloOf(samples: Float32Array, sampleRate: number, from: number, to: number): number {
  const lo = Math.max(0, Math.floor(from));
  const hi = Math.min(samples.length, Math.floor(to));
  if (hi - lo < MOD_FRAME * 2) return 0;
  const env = rmsEnvelope(samples.subarray(lo, hi), 512, 256);
  if (env.length < 8) return 0;

  // ~150 ms of smoothing: slower than any DX7 LFO worth calling tremolo, so
  // what survives the subtraction is the wobble and not the envelope shape.
  const half = Math.max(2, Math.round((0.15 * sampleRate) / 256 / 2));
  let mean = 0;
  let varSum = 0;
  let n = 0;
  for (let i = 0; i < env.length; i++) {
    let sum = 0;
    let count = 0;
    for (let j = Math.max(0, i - half); j <= Math.min(env.length - 1, i + half); j++) {
      sum += env[j];
      count++;
    }
    const trend = sum / count;
    if (trend <= 1e-6) continue;
    const residual = env[i] - trend;
    varSum += residual * residual;
    mean += trend;
    n++;
  }
  if (n < 4 || mean <= 0) return 0;
  return Math.sqrt(varSum / n) / (mean / n);
}

export function midiToHz(note: number): number {
  return 440 * Math.pow(2, (note - 69) / 12);
}

export function dbFromAmp(a: number): number {
  return 20 * Math.log10(Math.max(a, 1e-9));
}

/** Least-squares slope of y against x. */
export function slope(x: ArrayLike<number>, y: ArrayLike<number>): number {
  const n = x.length;
  if (n < 2) return 0;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) {
    sx += x[i];
    sy += y[i];
    sxx += x[i] * x[i];
    sxy += x[i] * y[i];
  }
  const den = n * sxx - sx * sx;
  return den === 0 ? 0 : (n * sxy - sx * sy) / den;
}
