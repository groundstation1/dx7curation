/*
 * Acoustic features, measured from the rendered probe.
 *
 * The played pitch is known exactly, so everything spectral is expressed
 * relative to f0 - centroid in octaves above the fundamental rather than in Hz.
 * That makes a bass patch and a bell patch comparable without the pitch itself
 * dominating the distance.
 */
import {
  dbFromAmp, harmonicAnalysis, magnitudeSpectrum, midiToHz, modulationDepth, rmsEnvelope,
  slope, spectralCentroid, spectralFlatness, spectralSpread,
} from './dsp.ts';
import type { ProbeResult, ProbeSegment, ProbeSpec } from '../render/probe.ts';

const ENV_FRAME = 512;
const ENV_HOP = 256;
/** Short frames for tracking how brightness moves over the note. */
const FFT_SIZE = 4096;
/** Longer frame for the harmonic analysis, which needs to resolve low f0. */
const SPECTRUM_SIZE = 8192;
const SILENCE = 1e-5;

export interface SegmentFeatures {
  peak: number;
  /** RMS over the held portion. */
  rms: number;
  /** Seconds from onset to 90% of the held peak. */
  attackTime: number;
  /** Seconds from the peak down to the sustain plateau. */
  decayTime: number;
  /** Sustain level over held peak, 0..1. */
  sustainRatio: number;
  /** Seconds from key-up to 60 dB down. Censored at the tail length. */
  releaseTime: number;
  /** True when the tail was still audible when the probe ended. */
  releaseCensored: boolean;
  /** Spectral centroid in octaves above f0, averaged over the note. */
  centroidOct: number;
  /**
   * Brightness sampled at four points across the held note, in octaves above
   * f0.
   *
   * The mean and slope were losing the shape: a patch that starts dull, blooms
   * and then closes again fits the same straight line as one that never moves.
   * Four samples is enough to tell a bloom from a decay from a flat hold, and
   * cheap enough that it costs nothing worth measuring.
   */
  brightnessTrack: number[];
  /** Level at the same four points, in dB relative to the note's peak. */
  loudnessTrack: number[];

  /** Spectral centroid in octaves relative to middle C, so register shows. */
  absCentroidOct: number;
  /** Octaves between the note asked for and the fundamental actually sounded. */
  registerOct: number;
  /** Change in centroid over the held note, octaves per second. */
  centroidSlope: number;
  /** Spectral spread in octaves. */
  spreadOct: number;
  inharmonicity: number;
  oddEvenRatio: number;
  brightnessHarmonic: number;
  flatness: number;
  /** Centroid of the attack transient minus centroid of the body, in octaves. */
  attackBrightness: number;
}

const SILENT_SEGMENT: SegmentFeatures = {
  peak: 0, rms: 0, attackTime: 0, decayTime: 0, sustainRatio: 0,
  releaseTime: 0, releaseCensored: false, centroidOct: 0,
  brightnessTrack: [0, 0, 0, 0], loudnessTrack: [0, 0, 0, 0], absCentroidOct: 0,
  registerOct: 0, centroidSlope: 0,
  spreadOct: 0, inharmonicity: 0, oddEvenRatio: 0.5, brightnessHarmonic: 0,
  flatness: 0, attackBrightness: 0,
};

/** Reference pitch for absolute brightness: middle C. */
const REFERENCE_HZ = 261.6256;

function centroidOctavesAt(seg: ProbeSegment, offset: number, f0: number): number {
  const mag = magnitudeSpectrum(seg.samples, offset, FFT_SIZE);
  const c = spectralCentroid(mag, seg.sampleRate, FFT_SIZE);
  return c > 0 ? Math.log2(c / f0) : 0;
}

export function analyseSegment(seg: ProbeSegment): SegmentFeatures {
  if (seg.peak < SILENCE) return { ...SILENT_SEGMENT };

  const nominalF0 = seg.f0Hz > 0 ? seg.f0Hz : midiToHz(seg.note);
  const env = rmsEnvelope(seg.samples, ENV_FRAME, ENV_HOP);
  const hopSec = ENV_HOP / seg.sampleRate;
  const releaseFrame = Math.min(env.length - 1, Math.floor(seg.releaseAt / ENV_HOP));

  // ---- held-note envelope ----
  let peakVal = 0;
  let peakFrame = 0;
  for (let f = 0; f <= releaseFrame; f++) {
    if (env[f] > peakVal) {
      peakVal = env[f];
      peakFrame = f;
    }
  }
  if (peakVal < SILENCE) return { ...SILENT_SEGMENT };

  // Attack is measured to the first *significant local* maximum, not the global
  // one. Tremolo and slow swells put the global peak hundreds of milliseconds
  // in on sounds that are plainly there from the first millisecond, and taking
  // the global peak reads those as slow-attack pads.
  const lookahead = Math.max(1, Math.round((0.06 * seg.sampleRate) / ENV_HOP));
  let attackTargetFrame = peakFrame;
  for (let f = 0; f <= peakFrame; f++) {
    if (env[f] < 0.5 * peakVal) continue;
    let isLocalMax = true;
    const end = Math.min(releaseFrame, f + lookahead);
    for (let g = f + 1; g <= end; g++) {
      if (env[g] > env[f]) {
        isLocalMax = false;
        break;
      }
    }
    if (isLocalMax) {
      attackTargetFrame = f;
      break;
    }
  }
  const attackLevel = env[attackTargetFrame];
  let attackFrame = attackTargetFrame;
  for (let f = 0; f <= attackTargetFrame; f++) {
    if (env[f] >= 0.9 * attackLevel) {
      attackFrame = f;
      break;
    }
  }
  const attackTime = attackFrame * hopSec;

  // Sustain: median of the last fifth of the held note.
  const sustainStart = Math.max(attackFrame, releaseFrame - Math.max(1, Math.floor((releaseFrame - attackFrame) / 5)));
  const sustainSlice = Array.from(env.slice(sustainStart, releaseFrame + 1)).sort((a, b) => a - b);
  const sustain = sustainSlice.length ? sustainSlice[sustainSlice.length >> 1] : 0;
  const sustainRatio = Math.min(1, sustain / peakVal);

  // A sound that swells after its onset has no decay stage.
  let decayFrame = attackFrame;
  if (attackLevel > sustain * 1.05) {
    const threshold = sustain + 0.1 * (attackLevel - sustain);
    decayFrame = releaseFrame;
    for (let f = attackFrame; f <= releaseFrame; f++) {
      if (env[f] <= threshold) {
        decayFrame = f;
        break;
      }
    }
  }
  const decayTime = Math.max(0, (decayFrame - attackFrame) * hopSec);

  // ---- release tail ----
  const atRelease = Math.max(env[releaseFrame], SILENCE);
  const target = atRelease / 1000; // -60 dB
  let releaseEnd = env.length - 1;
  let censored = true;
  for (let f = releaseFrame; f < env.length; f++) {
    if (env[f] <= target) {
      releaseEnd = f;
      censored = false;
      break;
    }
  }
  const releaseTime = (releaseEnd - releaseFrame) * hopSec;

  // ---- spectrum ----
  // Analyse a little after the onset, where a percussive patch still has body.
  const bodyOffset = Math.min(
    Math.max(0, seg.releaseAt - SPECTRUM_SIZE),
    attackFrame * ENV_HOP + Math.floor(0.05 * seg.sampleRate),
  );
  const mag = magnitudeSpectrum(seg.samples, bodyOffset, SPECTRUM_SIZE);

  // Guard against the analytic f0 landing an octave high, which happens when a
  // modulator puts real energy at a sub-octave the carrier ratios do not show.
  let harm = harmonicAnalysis(mag, seg.sampleRate, SPECTRUM_SIZE, nominalF0);
  let f0 = nominalF0;
  const sub = harmonicAnalysis(mag, seg.sampleRate, SPECTRUM_SIZE, nominalF0 / 2);
  if (sub.harmonicFraction - harm.harmonicFraction > 0.15) {
    harm = sub;
    f0 = nominalF0 / 2;
  }

  const centroidHz = spectralCentroid(mag, seg.sampleRate, SPECTRUM_SIZE);
  const centroidOctBody = centroidHz > 0 ? Math.log2(centroidHz / f0) : 0;
  const spreadHz = spectralSpread(mag, seg.sampleRate, SPECTRUM_SIZE, centroidHz);
  const spreadOct = centroidHz > 0 ? Math.log2(1 + spreadHz / centroidHz) : 0;
  const flatness = spectralFlatness(mag);

  // ---- centroid trajectory over the held note ----
  const times: number[] = [];
  const octs: number[] = [];
  const trajStart = attackFrame * ENV_HOP;
  const trajEnd = Math.max(trajStart + FFT_SIZE, seg.releaseAt);
  for (let k = 0; k < 5; k++) {
    const off = Math.floor(trajStart + ((trajEnd - trajStart - FFT_SIZE) * k) / 4);
    if (off < 0 || off + FFT_SIZE > seg.samples.length) continue;
    const f = Math.floor(off / ENV_HOP);
    if (f >= env.length || env[f] < peakVal * 0.02) continue; // too quiet to mean anything
    times.push(off / seg.sampleRate);
    octs.push(centroidOctavesAt(seg, off, f0));
  }
  const centroidSlope = octs.length >= 2 ? slope(times, octs) : 0;
  const centroidOct = octs.length ? octs.reduce((a, b) => a + b, 0) / octs.length : centroidOctBody;

  // ---- brightness and level, sampled across the held note ----
  const TRACK_POINTS = 4;
  const brightnessTrack: number[] = [];
  const loudnessTrack: number[] = [];
  const peakDb = dbFromAmp(peakVal);
  for (let k = 0; k < TRACK_POINTS; k++) {
    const frac = (k + 0.5) / TRACK_POINTS;
    const off = Math.floor(attackFrame * ENV_HOP + (seg.releaseAt - attackFrame * ENV_HOP) * frac);
    const envFrame = Math.min(env.length - 1, Math.max(0, Math.floor(off / ENV_HOP)));
    loudnessTrack.push(Math.max(-60, dbFromAmp(env[envFrame]) - peakDb));
    if (off >= 0 && off + FFT_SIZE <= seg.samples.length && env[envFrame] > peakVal * 0.01) {
      brightnessTrack.push(centroidOctavesAt(seg, off, f0));
    } else {
      // Too quiet to have a meaningful spectrum; hold the last known value so
      // the track does not jump to zero and read as a sudden darkening.
      brightnessTrack.push(brightnessTrack.length ? brightnessTrack[brightnessTrack.length - 1] : centroidOctBody);
    }
  }

  // Centre the brightness track on its own mean, so it carries the contour and
  // nothing else. Left absolute, all four points correlate above 0.94 with each
  // other and with centroidOct - six dimensions all saying "this patch is
  // bright", which is the redundancy the whitening exists to undo. Levelled,
  // they say "it blooms" or "it closes down", which centroidOct cannot.
  const trackMean = brightnessTrack.reduce((a, b) => a + b, 0) / Math.max(1, brightnessTrack.length);
  for (let k = 0; k < brightnessTrack.length; k++) brightnessTrack[k] -= trackMean;

  // ---- attack transient brightness ----
  const attackOffset = Math.max(0, attackFrame * ENV_HOP - FFT_SIZE / 4);
  const attackOct = attackOffset + FFT_SIZE <= seg.samples.length
    ? centroidOctavesAt(seg, attackOffset, f0)
    : centroidOctBody;

  // ---- held RMS ----
  let sum = 0;
  let n = 0;
  for (let f = 0; f <= releaseFrame; f++) {
    sum += env[f] * env[f];
    n++;
  }
  const rms = n ? Math.sqrt(sum / n) : 0;

  return {
    peak: seg.peak,
    rms,
    attackTime,
    decayTime,
    sustainRatio,
    releaseTime,
    releaseCensored: censored,
    centroidOct,
    brightnessTrack,
    loudnessTrack,
    absCentroidOct: centroidHz > 0 ? Math.log2(centroidHz / REFERENCE_HZ) : 0,
    registerOct: Math.log2(f0 / midiToHz(seg.note)),
    centroidSlope,
    spreadOct,
    inharmonicity: harm.inharmonicity,
    oddEvenRatio: harm.oddEvenRatio,
    brightnessHarmonic: harm.brightnessHarmonic,
    flatness,
    attackBrightness: attackOct - centroidOctBody,
  };
}

export interface AcousticFeatures {
  /** Per-segment detail, in probe order. */
  segments: SegmentFeatures[];
  // Reference segment: middle pitch, hard velocity.
  logAttackTime: number;
  logDecayTime: number;
  sustainRatio: number;
  logReleaseTime: number;
  releaseCensored: boolean;
  centroidOct: number;
  /** Brightness across the held note at the reference pitch, octaves above f0. */
  brightnessTrack: number[];
  /** Level across the held note at the reference pitch, dB below its peak. */
  loudnessTrack: number[];
  absBrightness: number;
  registerOct: number;
  centroidSlope: number;
  spreadOct: number;
  inharmonicity: number;
  oddEvenRatio: number;
  flatness: number;
  attackBrightness: number;
  loudnessDb: number;
  // Velocity response (hard minus soft, at the reference pitch).
  velLevelDb: number;
  velBrightnessOct: number;
  velAttackRatio: number;
  // Key response (top pitch minus bottom pitch, per octave).
  keyBrightnessSlope: number;
  keyLevelSlope: number;
  keyDecaySlope: number;
  /**
   * How much the patch reacts to the mod wheel overall, 0 (nothing) to 1
   * (dramatic), combining the vibrato and tremolo it adds.
   */
  modResponse: number;
  /** Pitch wobble the wheel adds, in cents. */
  modVibratoCents: number;
  /** Amplitude wobble the wheel adds, as a fraction of the mean level. */
  modTremoloDepth: number;
  /**
   * Timbre wobble the wheel adds: how much the spectral centroid moves over the
   * note, in octaves. This is the third thing the wheel can do and the one that
   * is neither vibrato nor tremolo - amplitude modulation applied to a
   * modulator changes the FM index rather than the level, so the patch growls
   * instead of wobbling in pitch or volume.
   */
  modTimbreOct: number;
  /** Mean brightness change with the wheel up, in octaves. */
  modBrightnessOct: number;
  /** True when the voice made no sound at any probed pitch. */
  silent: boolean;
}

function refIndices(spec: ProbeSpec) {
  const midPitch = Math.floor(spec.pitches.length / 2);
  const hard = 0; // velocities are listed loudest first
  const soft = spec.velocities.length - 1;
  const nv = spec.velocities.length;
  return {
    ref: midPitch * nv + hard,
    refSoft: midPitch * nv + soft,
    low: 0 * nv + hard,
    high: (spec.pitches.length - 1) * nv + hard,
    lowNote: spec.pitches[0],
    highNote: spec.pitches[spec.pitches.length - 1],
  };
}

const log10 = (x: number) => Math.log10(Math.max(x, 1e-4));

function rmsOf(s: Float32Array, from = 0, to = s.length): number {
  let sum = 0;
  const lo = Math.max(0, Math.floor(from));
  const hi = Math.min(s.length, Math.floor(to));
  for (let i = lo; i < hi; i++) sum += s[i] * s[i];
  return Math.sqrt(sum / Math.max(1, hi - lo));
}

/**
 * Compare the dry and wheel-up renders.
 *
 * Not by subtracting them: past a few cents of vibrato the two signals are
 * uncorrelated, so a difference measure pins at sqrt(2) and a gentle patch
 * scores the same as a violent one. Instead each render is measured for how
 * much its fundamental wobbles in pitch and in amplitude, and the wheel's
 * effect is the increase.
 */
function centroidWobbleOct(seg: ProbeSegment, from: number, to: number): { wobble: number; mean: number } {
  const size = 2048;
  const octs: number[] = [];
  const step = Math.max(size, Math.floor((to - from - size) / 11));
  for (let off = Math.floor(from); off + size <= Math.min(seg.samples.length, to); off += step) {
    const c = spectralCentroid(magnitudeSpectrum(seg.samples, off, size), seg.sampleRate, size);
    if (c > 0) octs.push(Math.log2(c));
  }
  if (octs.length < 3) return { wobble: 0, mean: 0 };
  const mean = octs.reduce((a, b) => a + b, 0) / octs.length;
  let v = 0;
  for (const o of octs) v += (o - mean) * (o - mean);
  return { wobble: Math.sqrt(v / octs.length), mean };
}

function modWheelResponse(probe: ProbeResult): {
  response: number; vibratoCents: number; tremoloDepth: number; timbreOct: number; brightnessOct: number;
} {
  const none = { response: 0, vibratoCents: 0, tremoloDepth: 0, timbreOct: 0, brightnessOct: 0 };
  if (probe.modIndex < 0) return none;
  const dry = probe.segments[probe.dryIndex];
  const wet = probe.segments[probe.modIndex];
  if (!dry || !wet || dry.peak < SILENCE) return none;

  const f0 = dry.f0Hz > 0 ? dry.f0Hz : midiToHz(dry.note);
  // Skip the attack: an envelope sweeping through its decay is not modulation.
  const from = Math.floor(0.2 * dry.sampleRate);
  const dryMod = modulationDepth(dry.samples, dry.sampleRate, f0, from, dry.releaseAt);
  const wetMod = modulationDepth(wet.samples, wet.sampleRate, f0, from, wet.releaseAt);
  if (dryMod.frames === 0 || wetMod.frames === 0) return none;

  const vibratoCents = Math.max(0, wetMod.vibratoCents - dryMod.vibratoCents);
  const tremoloDepth = Math.max(0, wetMod.tremoloDepth - dryMod.tremoloDepth);

  const dryC = centroidWobbleOct(dry, from, dry.releaseAt);
  const wetC = centroidWobbleOct(wet, from, wet.releaseAt);
  const timbreOct = Math.max(0, wetC.wobble - dryC.wobble);
  const brightnessOct = dryC.mean !== 0 && wetC.mean !== 0 ? wetC.mean - dryC.mean : 0;

  // Full scale is roughly what the DX7 can actually do at maximum sensitivity:
  // an octave of pitch swing, a tremolo half as deep as the note itself, or a
  // third of an octave of timbre movement.
  const response = Math.min(1,
    0.45 * Math.min(1, vibratoCents / 1200) +
    0.3 * Math.min(1, tremoloDepth / 0.5) +
    0.25 * Math.min(1, timbreOct / 0.33));
  return { response, vibratoCents, tremoloDepth, timbreOct, brightnessOct };
}

export function extractAcoustic(probe: ProbeResult): AcousticFeatures {
  const segments = probe.segments.map(analyseSegment);
  const ix = refIndices(probe.spec);
  const ref = segments[ix.ref] ?? SILENT_SEGMENT;
  const soft = segments[ix.refSoft] ?? SILENT_SEGMENT;
  const low = segments[ix.low] ?? SILENT_SEGMENT;
  const high = segments[ix.high] ?? SILENT_SEGMENT;
  const octaveSpan = Math.max(1 / 12, (ix.highNote - ix.lowNote) / 12);
  const mod = modWheelResponse(probe);

  return {
    segments,
    logAttackTime: log10(ref.attackTime),
    logDecayTime: log10(ref.decayTime),
    sustainRatio: ref.sustainRatio,
    logReleaseTime: log10(ref.releaseTime),
    releaseCensored: ref.releaseCensored,
    centroidOct: ref.centroidOct,
    brightnessTrack: ref.brightnessTrack,
    loudnessTrack: ref.loudnessTrack,
    absBrightness: ref.absCentroidOct,
    registerOct: ref.registerOct,
    centroidSlope: ref.centroidSlope,
    spreadOct: ref.spreadOct,
    inharmonicity: ref.inharmonicity,
    oddEvenRatio: ref.oddEvenRatio,
    flatness: ref.flatness,
    attackBrightness: ref.attackBrightness,
    loudnessDb: dbFromAmp(ref.rms),
    velLevelDb: dbFromAmp(ref.rms) - dbFromAmp(soft.rms),
    velBrightnessOct: ref.centroidOct - soft.centroidOct,
    velAttackRatio: log10(ref.attackTime) - log10(soft.attackTime),
    keyBrightnessSlope: (high.centroidOct - low.centroidOct) / octaveSpan,
    keyLevelSlope: (dbFromAmp(high.rms) - dbFromAmp(low.rms)) / octaveSpan,
    keyDecaySlope: (log10(high.decayTime) - log10(low.decayTime)) / octaveSpan,
    modResponse: mod.response,
    modVibratoCents: mod.vibratoCents,
    modTremoloDepth: mod.tremoloDepth,
    modTimbreOct: mod.timbreOct,
    modBrightnessOct: mod.brightnessOct,
    silent: probe.peak < SILENCE,
  };
}
