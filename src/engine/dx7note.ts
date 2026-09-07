/*
 * A single DX7 voice - port of msfa dx7note.cc (Google Inc. / Pascal Gauthier),
 * Apache 2.0.
 *
 * Trimmed to what offline patch auditioning needs: standard 12-TET tuning only,
 * no MTS/Scala, no portamento, no MPE, no live controllers. All six operators
 * are always enabled (the DX7 sysex has no operator on/off - that is a
 * front-panel-only state - so an operator is "off" only by having output
 * level 0).
 */
import { Env, scaleOutLevel } from './env.ts';
import { FmCore, makeOpParams, isCarrier, type FmOpParams } from './fmcore.ts';
import { PitchEnv } from './pitchenv.ts';
import { freqlutLookup } from './tables.ts';

const FEEDBACK_BITDEPTH = 8;

const coarsemul = [
  -16777216, 0, 16777216, 26591258, 33554432, 38955489, 43368474, 47099600,
  50331648, 53182516, 55732705, 58039632, 60145690, 62083076, 63876816,
  65546747, 67108864, 68576247, 69959732, 71268397, 72509921, 73690858,
  74816848, 75892776, 76922906, 77910978, 78860292, 79773775, 80654032,
  81503396, 82323963, 83117622,
];

const velocityData = [
  0, 70, 86, 97, 106, 114, 121, 126, 132, 138, 142, 148, 152, 156, 160, 163,
  166, 170, 173, 174, 178, 181, 184, 186, 189, 190, 194, 196, 198, 200, 202,
  205, 206, 209, 211, 214, 216, 218, 220, 222, 224, 225, 227, 229, 230, 232,
  233, 235, 237, 238, 240, 241, 242, 243, 244, 246, 246, 248, 249, 250, 251,
  252, 253, 254,
];

const expScaleData = [
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 14, 16, 19, 23, 27, 33, 39, 47, 56, 66,
  80, 94, 110, 126, 142, 158, 174, 190, 206, 222, 238, 250,
];

const pitchmodsenstab = [0, 10, 20, 33, 55, 92, 153, 255];
const ampmodsenstab = [0, 4342338, 7171437, 16777216];

/** Standard 12-TET: base is (1 << 24) * (log2(440) - 69/12). */
export function midinoteToLogfreq(midinote: number): number {
  return 50857777 + Math.trunc((1 << 24) / 12) * midinote;
}

export function oscFreq(
  midinote: number, mode: number, coarse: number, fine: number, detune: number,
): number {
  let logfreq: number;
  if (mode === 0) {
    logfreq = midinoteToLogfreq(midinote);
    // Detune curve measured from hardware by the Dexed authors.
    const detuneRatio = (0.0209 * Math.exp(-0.396 * (logfreq / (1 << 24)))) / 7;
    logfreq = Math.trunc(logfreq + detuneRatio * logfreq * (detune - 7));
    logfreq += coarsemul[coarse & 31];
    if (fine) {
      logfreq += Math.floor(24204406.323123 * Math.log(1 + 0.01 * fine) + 0.5);
    }
  } else {
    logfreq = (4458616 * ((coarse & 3) * 100 + fine)) >> 3;
    logfreq += detune > 7 ? 13457 * (detune - 7) : 0;
  }
  return logfreq;
}

/** Velocity delta in envelope microsteps. */
function scaleVelocity(velocity: number, sensitivity: number): number {
  const clamped = Math.max(0, Math.min(127, velocity));
  const velValue = velocityData[clamped >> 1] - 239;
  return ((sensitivity * velValue + 7) >> 3) << 4;
}

function scaleRate(midinote: number, sensitivity: number): number {
  const x = Math.min(31, Math.max(0, Math.trunc(midinote / 3) - 7));
  return (sensitivity * x) >> 3;
}

function scaleCurve(group: number, depth: number, curve: number): number {
  let scale: number;
  if (curve === 0 || curve === 3) {
    scale = (group * depth * 329) >> 12;
  } else {
    const rawExp = expScaleData[Math.min(group, expScaleData.length - 1)];
    scale = (rawExp * depth * 329) >> 15;
  }
  return curve < 2 ? -scale : scale;
}

function scaleLevel(
  midinote: number, breakPt: number, leftDepth: number, rightDepth: number,
  leftCurve: number, rightCurve: number,
): number {
  const offset = midinote - breakPt - 17;
  if (offset >= 0) {
    return scaleCurve(Math.trunc((offset + 1) / 3), rightDepth, rightCurve);
  }
  return scaleCurve(Math.trunc(-(offset - 1) / 3), leftDepth, leftCurve);
}

export class Dx7Note {
  private env = [new Env(), new Env(), new Env(), new Env(), new Env(), new Env()];
  private params: FmOpParams[] = makeOpParams();
  private pitchenv = new PitchEnv();
  private basepitch = new Int32Array(6);
  private fbBuf = new Int32Array(2);
  private fbShift = 16;
  private ampmodsens = new Int32Array(6);
  private opMode = new Int32Array(6);
  private ampmoddepth = 0;
  private algorithm = 0;
  private pitchmoddepth = 0;
  private pitchmodsens = 0;
  private initialised = false;
  private core = new FmCore();

  /** patch is the 155-byte unpacked voice. midinote already includes transpose. */
  init(patch: Uint8Array, midinote: number, velocity: number): void {
    this.initialised = true;
    const rates = [0, 0, 0, 0];
    const levels = [0, 0, 0, 0];

    for (let op = 0; op < 6; op++) {
      const off = op * 21;
      for (let i = 0; i < 4; i++) {
        rates[i] = patch[off + i];
        levels[i] = patch[off + 4 + i];
      }
      let outlevel = scaleOutLevel(patch[off + 16]);
      outlevel += scaleLevel(midinote, patch[off + 8], patch[off + 9],
        patch[off + 10], patch[off + 11], patch[off + 12]);
      outlevel = Math.min(127, outlevel);
      outlevel = outlevel << 5;
      outlevel += scaleVelocity(velocity, patch[off + 15]);
      outlevel = Math.max(0, outlevel);
      const rateScaling = scaleRate(midinote, patch[off + 13]);
      this.env[op].init(rates, levels, outlevel, rateScaling);

      const mode = patch[off + 17];
      this.opMode[op] = mode;
      this.basepitch[op] = oscFreq(midinote, mode, patch[off + 18], patch[off + 19], patch[off + 20]);
      this.ampmodsens[op] = ampmodsenstab[patch[off + 14] & 3];
    }

    for (let i = 0; i < 4; i++) {
      rates[i] = patch[126 + i];
      levels[i] = patch[130 + i];
    }
    this.pitchenv.set(rates, levels);
    this.algorithm = patch[134];
    const feedback = patch[135];
    this.fbShift = feedback !== 0 ? FEEDBACK_BITDEPTH - feedback : 16;
    this.pitchmoddepth = (patch[139] * 165) >> 6;
    this.pitchmodsens = pitchmodsenstab[patch[143] & 7];
    this.ampmoddepth = (patch[140] * 165) >> 6;
    this.fbBuf[0] = 0;
    this.fbBuf[1] = 0;
  }

  /**
   * Controller state, in msfa's units. Both are 0..127 after the mod source's
   * range has been applied. The DX7 mod wheel's destination is a function
   * parameter rather than voice data, so there is no "correct" default; the
   * wheel here drives both pitch and amplitude, which is the assignment that
   * makes a patch's LFO settings audible.
   */
  pitchModCc = 0;
  ampModCc = 0;

  setModWheel(value01: number): void {
    const cc = Math.max(0, Math.min(127, Math.round(value01 * 127)));
    this.pitchModCc = cc;
    this.ampModCc = cc;
  }

  /** Adds one block of N samples into buf (Q24-ish fixed point). */
  compute(buf: Int32Array, lfoVal: number, lfoDelay: number): void {
    // ---- pitch ----
    const pmd = this.pitchmoddepth * lfoDelay;
    const senslfo = this.pitchmodsens * (lfoVal - (1 << 23));
    // 63-bit product; a double loses ~10 low bits, which is < 1e-8 after >> 39.
    let pmod1 = Math.floor((pmd * senslfo) / 549755813888);
    pmod1 = Math.abs(pmod1);
    let pmod2 = Math.floor((this.pitchModCc * senslfo) / 16384);
    pmod2 = Math.abs(pmod2);
    let pitchMod = Math.max(pmod1, pmod2);
    pitchMod = this.pitchenv.getsample() + pitchMod * (senslfo < 0 ? -1 : 1);
    const pitchBase = 0; // no pitch bend, no master tune
    pitchMod += pitchBase;

    // ---- amp mod ----
    const invLfo = (1 << 24) - lfoVal;
    let amod1 = Math.floor((this.ampmoddepth * lfoDelay) / 256);
    amod1 = Math.floor((amod1 * invLfo) / 16777216);
    const amod2 = Math.floor((this.ampModCc * invLfo) / 128);
    // eg_mod is 127 with no EG-routed controller, so amod_3 == 1 << 24 and the
    // EG-mod floor contributes nothing.
    const amdMod = Math.max(amod1, amod2);

    // ---- operators ----
    for (let op = 0; op < 6; op++) {
      const p = this.params[op];
      if (this.opMode[op]) {
        p.freq = freqlutLookup(this.basepitch[op] + pitchBase);
      } else {
        p.freq = freqlutLookup(this.basepitch[op] + pitchMod);
      }
      let level = this.env[op].getsample();
      if (this.ampmodsens[op] !== 0 && amdMod !== 0) {
        const sensamp = Math.floor((amdMod * this.ampmodsens[op]) / 16777216);
        const pt = Math.exp((sensamp / 262144) * 0.07 + 12.2);
        // (level * (pt << 4)) >> 28 exceeds 2^53 as an exact integer product;
        // the double form differs by at most 1 microstep.
        const ldiff = Math.floor(level * ((pt * 16) / 268435456));
        level -= ldiff;
      }
      p.levelIn = level;
    }
    this.core.render(buf, this.params, this.algorithm, this.fbBuf, this.fbShift);
  }

  keyup(): void {
    for (let op = 0; op < 6; op++) this.env[op].keydown(false);
    this.pitchenv.keydown(false);
  }

  /**
   * True once every carrier has run out of envelope stages.
   *
   * A DX7 envelope's fourth level is where it settles after key-up, not
   * necessarily silence: with L4 above zero the release ends on an audible
   * level and the voice sounds until something takes it away. Thirteen of the
   * 128 factory voices do this, TRAIN at full scale. On the hardware the next
   * note steals it; a live engine that never steals has to notice for itself,
   * which is what this is for. `isPlaying` stays true throughout - the voice
   * genuinely is still making sound.
   */
  get settled(): boolean {
    if (!this.initialised) return true;
    for (let op = 0; op < 6; op++) {
      if (isCarrier(this.algorithm, op) && this.env[op].stage < 4) return false;
    }
    return true;
  }

  isPlaying(): boolean {
    if (!this.initialised) return false;
    for (let op = 0; op < 6; op++) {
      if (isCarrier(this.algorithm, op) && this.env[op].isActive()) return true;
    }
    return false;
  }
}
