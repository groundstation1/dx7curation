/*
 * Assembling one comparable vector per voice, and the standardisation that
 * makes its dimensions commensurable.
 *
 * `algorithm` is deliberately absent from the distance vector: it is a
 * categorical label with no meaningful ordering, so it would only add noise to
 * a Euclidean distance. It stays available as a plot axis and a colour.
 */
import type { AcousticFeatures } from './acoustic.ts';
import type { StructuralFeatures } from './structural.ts';

export interface FeatureDef {
  name: string;
  label: string;
  group: 'acoustic' | 'structural';
  get: (a: AcousticFeatures, s: StructuralFeatures) => number;
}

export const FEATURE_DEFS: FeatureDef[] = [
  // --- acoustic ---
  { name: 'attack', label: 'attack time (log s)', group: 'acoustic', get: (a) => a.logAttackTime },
  { name: 'decay', label: 'decay time (log s)', group: 'acoustic', get: (a) => a.logDecayTime },
  { name: 'sustain', label: 'sustain level', group: 'acoustic', get: (a) => a.sustainRatio },
  { name: 'release', label: 'release time (log s)', group: 'acoustic', get: (a) => a.logReleaseTime },
  { name: 'brightness', label: 'brightness (oct above f0)', group: 'acoustic', get: (a) => a.centroidOct },
  { name: 'bright1', label: 'brightness contour, early', group: 'acoustic', get: (a) => a.brightnessTrack[0] ?? 0 },
  { name: 'bright2', label: 'brightness contour, early-mid', group: 'acoustic', get: (a) => a.brightnessTrack[1] ?? 0 },
  { name: 'bright3', label: 'brightness contour, late-mid', group: 'acoustic', get: (a) => a.brightnessTrack[2] ?? 0 },
  { name: 'bright4', label: 'brightness contour, late', group: 'acoustic', get: (a) => a.brightnessTrack[3] ?? 0 },
  { name: 'loud1', label: 'level early (dB below peak)', group: 'acoustic', get: (a) => a.loudnessTrack[0] ?? 0 },
  { name: 'loud2', label: 'level early-mid (dB)', group: 'acoustic', get: (a) => a.loudnessTrack[1] ?? 0 },
  { name: 'loud3', label: 'level late-mid (dB)', group: 'acoustic', get: (a) => a.loudnessTrack[2] ?? 0 },
  { name: 'loud4', label: 'level late (dB)', group: 'acoustic', get: (a) => a.loudnessTrack[3] ?? 0 },
  { name: 'absBrightness', label: 'brightness (oct above middle C)', group: 'acoustic', get: (a) => a.absBrightness },
  { name: 'register', label: 'register offset (oct)', group: 'acoustic', get: (a) => a.registerOct },
  { name: 'brightnessSlope', label: 'brightness drift (oct/s)', group: 'acoustic', get: (a) => a.centroidSlope },
  { name: 'spread', label: 'spectral spread', group: 'acoustic', get: (a) => a.spreadOct },
  { name: 'inharmonicity', label: 'inharmonicity', group: 'acoustic', get: (a) => a.inharmonicity },
  { name: 'oddEven', label: 'odd/even harmonics', group: 'acoustic', get: (a) => a.oddEvenRatio },
  { name: 'flatness', label: 'spectral flatness', group: 'acoustic', get: (a) => a.flatness },
  { name: 'attackBrightness', label: 'attack brightness', group: 'acoustic', get: (a) => a.attackBrightness },
  { name: 'loudness', label: 'loudness (dB)', group: 'acoustic', get: (a) => a.loudnessDb },
  { name: 'velLevel', label: 'velocity level range (dB)', group: 'acoustic', get: (a) => a.velLevelDb },
  { name: 'velBrightness', label: 'velocity brightness (oct)', group: 'acoustic', get: (a) => a.velBrightnessOct },
  { name: 'velAttack', label: 'velocity attack change', group: 'acoustic', get: (a) => a.velAttackRatio },
  { name: 'keyBrightness', label: 'brightness per octave', group: 'acoustic', get: (a) => a.keyBrightnessSlope },
  { name: 'keyLevel', label: 'level per octave (dB)', group: 'acoustic', get: (a) => a.keyLevelSlope },
  { name: 'keyDecay', label: 'decay per octave', group: 'acoustic', get: (a) => a.keyDecaySlope },
  { name: 'modResponse', label: 'mod wheel response (measured)', group: 'acoustic', get: (a) => a.modResponse },
  { name: 'modVibrato', label: 'mod wheel vibrato (cents)', group: 'acoustic', get: (a) => a.modVibratoCents },
  { name: 'modTremolo', label: 'mod wheel tremolo depth', group: 'acoustic', get: (a) => a.modTremoloDepth },
  { name: 'modTimbre', label: 'mod wheel timbre wobble (oct)', group: 'acoustic', get: (a) => a.modTimbreOct },
  { name: 'modBrightness', label: 'mod wheel brightness change (oct)', group: 'acoustic', get: (a) => a.modBrightnessOct },
  // --- structural ---
  { name: 'carriers', label: 'carriers', group: 'structural', get: (_a, s) => s.carriers },
  { name: 'feedback', label: 'feedback', group: 'structural', get: (_a, s) => s.feedback },
  { name: 'activeOps', label: 'active operators', group: 'structural', get: (_a, s) => s.activeOps },
  { name: 'modDepth', label: 'modulator level', group: 'structural', get: (_a, s) => s.modulatorDepth },
  { name: 'carrierLevel', label: 'carrier level', group: 'structural', get: (_a, s) => s.carrierLevel },
  { name: 'maxRatio', label: 'highest ratio (log2)', group: 'structural', get: (_a, s) => s.maxLogRatio },
  { name: 'ratioSpread', label: 'ratio spread', group: 'structural', get: (_a, s) => s.ratioSpread },
  { name: 'nonInteger', label: 'non-integer ratios', group: 'structural', get: (_a, s) => s.nonIntegerRatios },
  { name: 'fixedOps', label: 'fixed-frequency operators', group: 'structural', get: (_a, s) => s.fixedOps },
  { name: 'detuneSpread', label: 'detune spread', group: 'structural', get: (_a, s) => s.detuneSpread },
  { name: 'egAttackRate', label: 'carrier attack rate', group: 'structural', get: (_a, s) => s.carrierAttackRate },
  { name: 'egEndLevel', label: 'carrier end level', group: 'structural', get: (_a, s) => s.carrierEndLevel },
  { name: 'egSustainLevel', label: 'carrier sustain level', group: 'structural', get: (_a, s) => s.carrierSustainLevel },
  { name: 'keyScaling', label: 'keyboard level scaling', group: 'structural', get: (_a, s) => s.keyScaling },
  { name: 'velSensParam', label: 'velocity sensitivity (param)', group: 'structural', get: (_a, s) => s.velSens },
  { name: 'rateScaling', label: 'keyboard rate scaling', group: 'structural', get: (_a, s) => s.rateScaling },
  { name: 'ampModSens', label: 'amp mod sensitivity', group: 'structural', get: (_a, s) => s.ampModSens },
  { name: 'lfoSpeed', label: 'LFO speed', group: 'structural', get: (_a, s) => s.lfoSpeed },
  { name: 'lfoDelay', label: 'LFO delay', group: 'structural', get: (_a, s) => s.lfoDelay },
  { name: 'lfoPm', label: 'LFO pitch depth', group: 'structural', get: (_a, s) => s.lfoPmDepth },
  { name: 'lfoAm', label: 'LFO amp depth', group: 'structural', get: (_a, s) => s.lfoAmDepth },
  { name: 'lfoSampleHold', label: 'LFO sample and hold', group: 'structural', get: (_a, s) => s.lfoSampleHold },
  { name: 'pitchModSens', label: 'pitch mod sensitivity', group: 'structural', get: (_a, s) => s.pitchModSens },
  { name: 'modWheelDepth', label: 'mod wheel response (predicted)', group: 'structural', get: (_a, s) => s.modWheelDepth },
  { name: 'ampModMax', label: 'amp mod sensitivity (max)', group: 'structural', get: (_a, s) => s.ampModMax },
  { name: 'ampModCarriers', label: 'amp mod on carriers (tremolo)', group: 'structural', get: (_a, s) => s.ampModOnCarriers },
  { name: 'ampModModulators', label: 'amp mod on modulators (growl)', group: 'structural', get: (_a, s) => s.ampModOnModulators },
  { name: 'pitchEg', label: 'pitch envelope depth', group: 'structural', get: (_a, s) => s.pitchEgDepth },
];

export const FEATURE_NAMES = FEATURE_DEFS.map((d) => d.name);
export const FEATURE_COUNT = FEATURE_DEFS.length;

/**
 * Bumped whenever a stored feature would come out differently today.
 *
 * The vector's length already catches features being added or removed, but not
 * a measurement changing meaning underneath the same name - a longer probe, a
 * different definition of release time - which leaves a corpus holding numbers
 * that are no longer comparable with anything measured since. Since analysis
 * runs at about twenty voices a second per worker, telling the user their
 * features are out of date is cheap and being quietly wrong is not.
 *
 *   2  release time extrapolated past the end of the probe; probe tail 4 s
 */
export const ANALYSIS_VERSION = 2;

export function buildVector(a: AcousticFeatures, s: StructuralFeatures): Float32Array {
  const v = new Float32Array(FEATURE_COUNT);
  for (let i = 0; i < FEATURE_COUNT; i++) {
    const x = FEATURE_DEFS[i].get(a, s);
    v[i] = Number.isFinite(x) ? x : 0;
  }
  return v;
}

/**
 * Robust per-dimension standardisation: median and a MAD-derived scale, then a
 * clip. The corpus has genuine outliers (sound-effect patches, broken voices)
 * and mean/sd would let a handful of them squash everything else together.
 */
export interface Standardizer {
  centre: Float32Array;
  scale: Float32Array;
  clip: number;
  /** Multiplier applied to each dimension after scaling. */
  weight: Float32Array;
}

export interface StandardizerOptions {
  clip?: number;
  /** Weight applied to every structural dimension. */
  structuralWeight?: number;
  /** Per-feature overrides by name. */
  weights?: Record<string, number>;
}

function median(sorted: Float64Array, lo: number, hi: number): number {
  const n = hi - lo;
  if (n === 0) return 0;
  const mid = lo + (n >> 1);
  return n % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function fitStandardizer(vectors: Float32Array[], opts: StandardizerOptions = {}): Standardizer {
  const clip = opts.clip ?? 5;
  const structuralWeight = opts.structuralWeight ?? 0.6;
  const centre = new Float32Array(FEATURE_COUNT);
  const scale = new Float32Array(FEATURE_COUNT);
  const weight = new Float32Array(FEATURE_COUNT);
  const col = new Float64Array(vectors.length);

  for (let d = 0; d < FEATURE_COUNT; d++) {
    for (let i = 0; i < vectors.length; i++) col[i] = vectors[i][d];
    col.sort();
    const med = median(col, 0, col.length);
    // MAD, reusing the buffer.
    for (let i = 0; i < col.length; i++) col[i] = Math.abs(col[i] - med);
    col.sort();
    const mad = median(col, 0, col.length);
    centre[d] = med;
    // 1.4826 * MAD matches the standard deviation for normal data.
    let s = 1.4826 * mad;
    if (!(s > 1e-9)) {
      // Degenerate dimension (constant, or more than half the corpus identical):
      // fall back to the standard deviation so it still contributes something.
      let mean = 0;
      for (let i = 0; i < vectors.length; i++) mean += vectors[i][d];
      mean /= Math.max(1, vectors.length);
      let varSum = 0;
      for (let i = 0; i < vectors.length; i++) {
        const dx = vectors[i][d] - mean;
        varSum += dx * dx;
      }
      s = Math.sqrt(varSum / Math.max(1, vectors.length));
    }
    scale[d] = s > 1e-9 ? s : 1;
    const def = FEATURE_DEFS[d];
    weight[d] = opts.weights?.[def.name] ?? (def.group === 'structural' ? structuralWeight : 1);
  }

  return { centre, scale, clip, weight };
}

export function standardize(v: Float32Array, st: Standardizer, out = new Float32Array(FEATURE_COUNT)): Float32Array {
  for (let d = 0; d < FEATURE_COUNT; d++) {
    let z = (v[d] - st.centre[d]) / st.scale[d];
    if (z > st.clip) z = st.clip;
    else if (z < -st.clip) z = -st.clip;
    out[d] = z * st.weight[d];
  }
  return out;
}

export function squaredDistance(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    sum += d * d;
  }
  return sum;
}

export function distance(a: Float32Array, b: Float32Array): number {
  return Math.sqrt(squaredDistance(a, b));
}
