/*
 * The probe: the fixed set of renders every voice gets, and the only audio the
 * feature extractor ever sees.
 *
 * Held note then captured release tail, at several pitches and two velocities.
 * The tail matters - it is where near-duplicates diverge - and the two
 * velocities are what velocity sensitivity is measured from.
 */
import { renderVoice } from '../engine/render.ts';
import { isCarrier } from '../engine/fmcore.ts';
import { P } from '../sysex/voice.ts';

/**
 * The fundamental a voice actually sounds at a given MIDI note.
 *
 * This is not midiToHz(note): the voice transpose parameter shifts it, and the
 * perceived fundamental is set by the lowest-frequency operator that reaches
 * the output bus - many bass patches carry every carrier at ratio 0.50 on top
 * of a -12 transpose, four times below the note they were asked for.
 */
export function voiceFundamentalHz(patch: Uint8Array, note: number): number {
  const transposed = Math.max(0, Math.min(127, note + patch[P.transpose] - 24));
  const noteHz = 440 * Math.pow(2, (transposed - 69) / 12);
  const algorithm = patch[P.algorithm] & 31;
  let lowest = Infinity;
  for (let op = 0; op < 6; op++) {
    if (patch[P.opOutputLevel(op)] === 0) continue;
    if (!isCarrier(algorithm, op)) continue;
    const coarse = patch[P.opCoarse(op)];
    const fine = patch[P.opFine(op)];
    const hz = patch[P.opMode(op)] === 1
      ? Math.pow(10, (coarse & 3) + fine / 100)
      : noteHz * (coarse === 0 ? 0.5 : coarse) * (1 + fine / 100);
    if (hz > 0 && hz < lowest) lowest = hz;
  }
  return Number.isFinite(lowest) ? lowest : noteHz;
}

export interface ProbeSpec {
  pitches: number[];
  velocities: number[];
  holdSec: number;
  releaseSec: number;
  sampleRate: number;
  /** Stop a segment early once the carriers are done and the block is silent. */
  earlyExit: boolean;
  /**
   * Render one extra segment at the reference pitch with the mod wheel fully
   * up, so how much a patch reacts to the wheel can be measured rather than
   * only inferred from its parameters.
   */
  modWheelProbe: boolean;
}

export const DEFAULT_PROBE: ProbeSpec = {
  pitches: [36, 60, 84],
  velocities: [120, 40],
  holdSec: 1.0,
  releaseSec: 1.0,
  sampleRate: 44100,
  earlyExit: true,
  modWheelProbe: true,
};

export interface ProbeSegment {
  note: number;
  velocity: number;
  samples: Float32Array;
  sampleRate: number;
  /** Sample index of key-up within `samples`. */
  releaseAt: number;
  peak: number;
  /** The fundamental this segment actually sounds at. See voiceFundamentalHz. */
  f0Hz: number;
  /** Mod wheel position this segment was rendered at. */
  modWheel: number;
}

export interface ProbeResult {
  segments: ProbeSegment[];
  spec: ProbeSpec;
  /** Loudest peak across all segments. */
  peak: number;
  /** Index of the mod-wheel-up segment, or -1. Its dry twin is `dryIndex`. */
  modIndex: number;
  dryIndex: number;
}

export function probeIndex(spec: ProbeSpec, pitchIndex: number, velocityIndex: number): number {
  return pitchIndex * spec.velocities.length + velocityIndex;
}

export function renderProbe(patch: Uint8Array, spec: ProbeSpec = DEFAULT_PROBE): ProbeResult {
  const segments: ProbeSegment[] = [];
  let peak = 0;
  for (const note of spec.pitches) {
    for (const velocity of spec.velocities) {
      const r = renderVoice(patch, {
        note,
        velocity,
        holdSec: spec.holdSec,
        releaseSec: spec.releaseSec,
        sampleRate: spec.sampleRate,
        gain: 1,
        earlyExit: spec.earlyExit,
      });
      segments.push({
        note,
        velocity,
        samples: r.samples,
        sampleRate: r.sampleRate,
        releaseAt: r.releaseAt,
        peak: r.peak,
        f0Hz: voiceFundamentalHz(patch, note),
        modWheel: 0,
      });
      if (r.peak > peak) peak = r.peak;
    }
  }

  // The dry reference the mod-wheel segment is compared against: middle pitch,
  // loudest velocity, which is also what the rest of the features are measured
  // from.
  const dryIndex = Math.floor(spec.pitches.length / 2) * spec.velocities.length;
  let modIndex = -1;

  if (spec.modWheelProbe && segments[dryIndex]) {
    const dry = segments[dryIndex];
    const r = renderVoice(patch, {
      note: dry.note,
      velocity: dry.velocity,
      holdSec: spec.holdSec,
      releaseSec: spec.releaseSec,
      sampleRate: spec.sampleRate,
      gain: 1,
      // Not early-exited: the wet render must stay sample-aligned with the dry
      // one for the difference between them to mean anything.
      earlyExit: false,
      modWheel: 1,
    });
    modIndex = segments.length;
    segments.push({
      note: dry.note,
      velocity: dry.velocity,
      samples: r.samples,
      sampleRate: r.sampleRate,
      releaseAt: r.releaseAt,
      peak: r.peak,
      f0Hz: dry.f0Hz,
      modWheel: 1,
    });
    if (r.peak > peak) peak = r.peak;
  }

  return { segments, spec, peak, modIndex, dryIndex };
}
