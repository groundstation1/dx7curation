/*
 * Structural features, read straight out of the sysex. These cost nothing and
 * carry real information the audio does not always expose - a patch built on
 * algorithm 32 with no feedback is a different animal from a four-deep stack
 * even when they happen to render similarly at the probed pitches.
 */
import { P } from '../sysex/voice.ts';
import { carrierCount, isCarrier } from '../engine/fmcore.ts';

export interface StructuralFeatures {
  /** 0-31, meaning algorithms 1-32. */
  algorithm: number;
  feedback: number;
  carriers: number;
  /** Operators with output level above zero. */
  activeOps: number;
  /** Mean output level of the active modulators, 0-99. */
  modulatorDepth: number;
  /** Mean output level of the carriers, 0-99. */
  carrierLevel: number;
  /** log2 of the highest active operator ratio. */
  maxLogRatio: number;
  /** Standard deviation of active operators' log2 ratios. */
  ratioSpread: number;
  /** Share of active ratio-mode operators whose ratio is not near an integer. */
  nonIntegerRatios: number;
  /** Operators in fixed-frequency mode. */
  fixedOps: number;
  /** Standard deviation of detune across active operators, in DX7 units. */
  detuneSpread: number;
  /** Mean EG rate 1 across carriers, 0-99 (high is a fast attack). */
  carrierAttackRate: number;
  /** Mean EG level 4 across carriers, 0-99 (high sustains after key-up). */
  carrierEndLevel: number;
  /** Mean EG level 3 across carriers, 0-99. */
  carrierSustainLevel: number;
  /** Mean of left plus right keyboard level scaling depth. */
  keyScaling: number;
  /** Mean key velocity sensitivity across operators, 0-7. */
  velSens: number;
  /** Mean keyboard rate scaling, 0-7. */
  rateScaling: number;
  /** Mean amplitude modulation sensitivity, 0-3. */
  ampModSens: number;
  lfoSpeed: number;
  lfoDelay: number;
  lfoPmDepth: number;
  lfoAmDepth: number;
  lfoWaveform: number;
  /** LFO waveform 5 is sample and hold - a strong character marker. */
  lfoSampleHold: number;
  pitchModSens: number;
  /**
   * Predicted mod wheel reactivity, 0..1, straight from the parameters.
   *
   * The wheel does not go through the patch's own LFO depth settings: it feeds
   * the modulation path directly, scaled by pitch mod sensitivity for vibrato
   * and by each operator's amplitude mod sensitivity for tremolo and timbre. A
   * patch with both at zero cannot respond to the wheel at all, whatever its
   * LFO is set to. Compare against the measured `modResponse`.
   */
  modWheelDepth: number;
  /** Highest amplitude mod sensitivity across the sounding operators, 0-3. */
  ampModMax: number;
  /**
   * Amplitude mod sensitivity split by role, because it does two completely
   * different things depending on where it sits. On a carrier it modulates the
   * level and you hear tremolo; on a modulator it modulates the FM index and
   * you hear the timbre growl, with the level barely moving.
   */
  ampModOnCarriers: number;
  ampModOnModulators: number;
  /** Any movement in the pitch envelope, as total deviation from centre. */
  pitchEgDepth: number;
  transpose: number;
}

/** msfa's pitchmodsenstab, normalised. */
const PITCH_MOD_SENS = [0, 10, 20, 33, 55, 92, 153, 255];
/** msfa's ampmodsenstab, normalised. */
const AMP_MOD_SENS = [0, 4342338, 7171437, 16777216];

function modWheelDepthOf(pitchModSens: number, ampModMax: number): number {
  const pitch = PITCH_MOD_SENS[pitchModSens & 7] / 255;
  const amp = AMP_MOD_SENS[ampModMax & 3] / 16777216;
  return Math.min(1, 0.6 * pitch + 0.4 * amp);
}

function stddev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const v = xs.reduce((a, b) => a + (b - mean) * (b - mean), 0) / xs.length;
  return Math.sqrt(v);
}

/** DX7 operator frequency ratio: coarse 0 means 0.5, and fine adds up to 99%. */
export function operatorRatio(coarse: number, fine: number): number {
  const base = coarse === 0 ? 0.5 : coarse;
  return base * (1 + fine / 100);
}

export function extractStructural(v: Uint8Array): StructuralFeatures {
  const algorithm = v[P.algorithm] & 31;

  const active: number[] = [];
  const logRatios: number[] = [];
  const detunes: number[] = [];
  let modulatorLevels: number[] = [];
  let carrierLevels: number[] = [];
  let fixedOps = 0;
  let nonInteger = 0;
  let ratioOps = 0;
  let keyScaling = 0;
  let velSens = 0;
  let rateScaling = 0;
  let ampModSens = 0;
  let ampModMax = 0;
  let ampModOnCarriers = 0;
  let ampModOnModulators = 0;
  const carrierAttack: number[] = [];
  const carrierEnd: number[] = [];
  const carrierSustain: number[] = [];

  for (let op = 0; op < 6; op++) {
    const level = v[P.opOutputLevel(op)];
    keyScaling += v[P.opLeftDepth(op)] + v[P.opRightDepth(op)];
    velSens += v[P.opVelSens(op)];
    rateScaling += v[P.opRateScaling(op)];
    ampModSens += v[P.opAmpModSens(op)];
    if (level === 0) continue;
    active.push(op);
    ampModMax = Math.max(ampModMax, v[P.opAmpModSens(op)] & 3);
    detunes.push(v[P.opDetune(op)] - 7);
    if (v[P.opMode(op)] === 1) {
      fixedOps++;
    } else {
      ratioOps++;
      const ratio = operatorRatio(v[P.opCoarse(op)], v[P.opFine(op)]);
      logRatios.push(Math.log2(ratio));
      const nearest = Math.round(ratio);
      if (nearest < 1 || Math.abs(ratio - nearest) > 0.02) nonInteger++;
    }
    if (isCarrier(algorithm, op)) {
      ampModOnCarriers = Math.max(ampModOnCarriers, v[P.opAmpModSens(op)] & 3);
      carrierLevels.push(level);
      carrierAttack.push(v[P.opRate(op, 0)]);
      carrierEnd.push(v[P.opLevel(op, 3)]);
      carrierSustain.push(v[P.opLevel(op, 2)]);
    } else {
      ampModOnModulators = Math.max(ampModOnModulators, v[P.opAmpModSens(op)] & 3);
      modulatorLevels.push(level);
    }
  }

  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

  let pitchEgDepth = 0;
  for (let i = 0; i < 4; i++) pitchEgDepth += Math.abs(v[P.pitchEgLevel(i)] - 50);

  return {
    algorithm,
    feedback: v[P.feedback] & 7,
    carriers: carrierCount(algorithm),
    activeOps: active.length,
    modulatorDepth: mean(modulatorLevels),
    carrierLevel: mean(carrierLevels),
    maxLogRatio: logRatios.length ? Math.max(...logRatios) : 0,
    ratioSpread: stddev(logRatios),
    nonIntegerRatios: ratioOps ? nonInteger / ratioOps : 0,
    fixedOps,
    detuneSpread: stddev(detunes),
    carrierAttackRate: mean(carrierAttack),
    carrierEndLevel: mean(carrierEnd),
    carrierSustainLevel: mean(carrierSustain),
    keyScaling: keyScaling / 6,
    velSens: velSens / 6,
    rateScaling: rateScaling / 6,
    ampModSens: ampModSens / 6,
    lfoSpeed: v[P.lfoSpeed],
    lfoDelay: v[P.lfoDelay],
    lfoPmDepth: v[P.lfoPmDepth],
    lfoAmDepth: v[P.lfoAmDepth],
    lfoWaveform: v[P.lfoWaveform] & 7,
    lfoSampleHold: (v[P.lfoWaveform] & 7) === 5 ? 1 : 0,
    pitchModSens: v[P.pitchModSens] & 7,
    modWheelDepth: modWheelDepthOf(v[P.pitchModSens] & 7, ampModMax),
    ampModMax,
    ampModOnCarriers,
    ampModOnModulators,
    pitchEgDepth,
    transpose: v[P.transpose] - 24,
  };
}
