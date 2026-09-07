/*
 * DX7 voice representation: the 128-byte packed form found in bulk dumps and
 * the 155-byte unpacked form the engine plays.
 *
 * Format reference: Dave Benson's sysex-format.txt and Dexed's
 * Documentation/sysex-format.txt, cross-checked against probonopd/dx-specs.
 */

export const PACKED_SIZE = 128;
export const UNPACKED_SIZE = 155;
export const NAME_OFFSET = 145;
export const NAME_LENGTH = 10;
/** Bytes of the packed voice that are not the name - what dedupe hashes. */
export const PACKED_NAME_OFFSET = 118;

/** Inclusive [min, max] for each of the 155 unpacked parameters. */
export const UNPACKED_RANGES: Array<[number, number]> = (() => {
  const r: Array<[number, number]> = new Array(UNPACKED_SIZE);
  const perOp: Array<[number, number]> = [
    [0, 99], [0, 99], [0, 99], [0, 99], // EG rate 1-4
    [0, 99], [0, 99], [0, 99], [0, 99], // EG level 1-4
    [0, 99], // level scaling break point
    [0, 99], // scale left depth
    [0, 99], // scale right depth
    [0, 3], // scale left curve
    [0, 3], // scale right curve
    [0, 7], // rate scaling
    [0, 3], // amp mod sensitivity
    [0, 7], // key velocity sensitivity
    [0, 99], // output level
    [0, 1], // osc mode (0 = ratio, 1 = fixed)
    [0, 31], // freq coarse
    [0, 99], // freq fine
    [0, 14], // detune (7 = centre)
  ];
  for (let op = 0; op < 6; op++) {
    for (let i = 0; i < 21; i++) r[op * 21 + i] = perOp[i];
  }
  for (let i = 0; i < 4; i++) r[126 + i] = [0, 99]; // pitch EG rates
  for (let i = 0; i < 4; i++) r[130 + i] = [0, 99]; // pitch EG levels
  r[134] = [0, 31]; // algorithm
  r[135] = [0, 7]; // feedback
  r[136] = [0, 1]; // osc key sync
  r[137] = [0, 99]; // LFO speed
  r[138] = [0, 99]; // LFO delay
  r[139] = [0, 99]; // LFO pitch mod depth
  r[140] = [0, 99]; // LFO amp mod depth
  r[141] = [0, 1]; // LFO key sync
  r[142] = [0, 5]; // LFO waveform
  r[143] = [0, 7]; // pitch mod sensitivity
  r[144] = [0, 48]; // transpose (24 = centre)
  for (let i = 0; i < NAME_LENGTH; i++) r[NAME_OFFSET + i] = [32, 127];
  return r;
})();

/** Named offsets into the unpacked voice. */
export const P = {
  opRate: (op: number, i: number) => op * 21 + i,
  opLevel: (op: number, i: number) => op * 21 + 4 + i,
  opBreakPoint: (op: number) => op * 21 + 8,
  opLeftDepth: (op: number) => op * 21 + 9,
  opRightDepth: (op: number) => op * 21 + 10,
  opLeftCurve: (op: number) => op * 21 + 11,
  opRightCurve: (op: number) => op * 21 + 12,
  opRateScaling: (op: number) => op * 21 + 13,
  opAmpModSens: (op: number) => op * 21 + 14,
  opVelSens: (op: number) => op * 21 + 15,
  opOutputLevel: (op: number) => op * 21 + 16,
  opMode: (op: number) => op * 21 + 17,
  opCoarse: (op: number) => op * 21 + 18,
  opFine: (op: number) => op * 21 + 19,
  opDetune: (op: number) => op * 21 + 20,
  pitchEgRate: (i: number) => 126 + i,
  pitchEgLevel: (i: number) => 130 + i,
  algorithm: 134,
  feedback: 135,
  oscKeySync: 136,
  lfoSpeed: 137,
  lfoDelay: 138,
  lfoPmDepth: 139,
  lfoAmDepth: 140,
  lfoKeySync: 141,
  lfoWaveform: 142,
  pitchModSens: 143,
  transpose: 144,
} as const;

/** Unpack 128 packed bytes into the 155-byte parameter array. */
export function unpackVoice(packed: Uint8Array, offset = 0): Uint8Array {
  const v = new Uint8Array(UNPACKED_SIZE);
  for (let op = 0; op < 6; op++) {
    const s = offset + op * 17;
    const d = op * 21;
    for (let i = 0; i < 11; i++) v[d + i] = packed[s + i];
    const b11 = packed[s + 11];
    v[d + 11] = b11 & 3; // left curve
    v[d + 12] = (b11 >> 2) & 3; // right curve
    const b12 = packed[s + 12];
    v[d + 13] = b12 & 7; // rate scaling
    v[d + 20] = (b12 >> 3) & 15; // detune
    const b13 = packed[s + 13];
    v[d + 14] = b13 & 3; // amp mod sensitivity
    v[d + 15] = (b13 >> 2) & 7; // key velocity sensitivity
    v[d + 16] = packed[s + 14]; // output level
    const b15 = packed[s + 15];
    v[d + 17] = b15 & 1; // osc mode
    v[d + 18] = (b15 >> 1) & 31; // freq coarse
    v[d + 19] = packed[s + 16]; // freq fine
  }
  const g = offset + 102;
  for (let i = 0; i < 8; i++) v[126 + i] = packed[g + i]; // pitch EG
  v[134] = packed[g + 8] & 31; // algorithm
  const b111 = packed[g + 9];
  v[135] = b111 & 7; // feedback
  v[136] = (b111 >> 3) & 1; // osc key sync
  v[137] = packed[g + 10];
  v[138] = packed[g + 11];
  v[139] = packed[g + 12];
  v[140] = packed[g + 13];
  const b116 = packed[g + 14];
  v[141] = b116 & 1; // LFO key sync
  v[142] = (b116 >> 1) & 7; // LFO waveform
  v[143] = (b116 >> 4) & 7; // pitch mod sensitivity
  v[144] = packed[g + 15]; // transpose
  for (let i = 0; i < NAME_LENGTH; i++) v[NAME_OFFSET + i] = packed[g + 16 + i];
  return v;
}

/** Pack a 155-byte parameter array back into 128 bytes. */
export function packVoice(v: Uint8Array, out = new Uint8Array(PACKED_SIZE), offset = 0): Uint8Array {
  for (let op = 0; op < 6; op++) {
    const s = op * 21;
    const d = offset + op * 17;
    for (let i = 0; i < 11; i++) out[d + i] = v[s + i];
    out[d + 11] = (v[s + 11] & 3) | ((v[s + 12] & 3) << 2);
    out[d + 12] = (v[s + 13] & 7) | ((v[s + 20] & 15) << 3);
    out[d + 13] = (v[s + 14] & 3) | ((v[s + 15] & 7) << 2);
    out[d + 14] = v[s + 16];
    out[d + 15] = (v[s + 17] & 1) | ((v[s + 18] & 31) << 1);
    out[d + 16] = v[s + 19];
  }
  const g = offset + 102;
  for (let i = 0; i < 8; i++) out[g + i] = v[126 + i];
  out[g + 8] = v[134] & 31;
  out[g + 9] = (v[135] & 7) | ((v[136] & 1) << 3);
  out[g + 10] = v[137];
  out[g + 11] = v[138];
  out[g + 12] = v[139];
  out[g + 13] = v[140];
  out[g + 14] = (v[141] & 1) | ((v[142] & 7) << 1) | ((v[143] & 7) << 4);
  out[g + 15] = v[144];
  for (let i = 0; i < NAME_LENGTH; i++) out[g + 16 + i] = v[NAME_OFFSET + i];
  return out;
}

/**
 * Force every parameter into its legal range. Several archives contain voices
 * with out-of-range bytes - "watermarks" a real DX7 silently clamps - and those
 * bytes otherwise make byte-identical patches hash differently.
 */
export function clampVoice(v: Uint8Array): { voice: Uint8Array; changed: number } {
  let changed = 0;
  for (let i = 0; i < UNPACKED_SIZE; i++) {
    if (i >= NAME_OFFSET) continue;
    const [lo, hi] = UNPACKED_RANGES[i];
    const x = v[i];
    if (x < lo) {
      v[i] = lo;
      changed++;
    } else if (x > hi) {
      v[i] = hi;
      changed++;
    }
  }
  for (let i = NAME_OFFSET; i < UNPACKED_SIZE; i++) {
    const c = v[i] & 0x7f;
    v[i] = c < 32 ? 32 : c;
  }
  return { voice: v, changed };
}

/**
 * Exact-dedupe key: the packed voice with the 10-byte name field excluded, so
 * the same patch under twenty different names collapses to one.
 */
export function packedKeyOf(packed: Uint8Array): string {
  let s = '';
  for (let i = 0; i < PACKED_NAME_OFFSET; i++) s += String.fromCharCode(packed[i]);
  return s;
}

export function voiceName(v: Uint8Array): string {
  let s = '';
  for (let i = 0; i < NAME_LENGTH; i++) {
    const c = v[NAME_OFFSET + i] & 0x7f;
    s += c >= 32 && c < 127 ? String.fromCharCode(c) : ' ';
  }
  return s.replace(/\s+$/, '');
}

export function setVoiceName(v: Uint8Array, name: string): void {
  const padded = (name + '          ').slice(0, NAME_LENGTH);
  for (let i = 0; i < NAME_LENGTH; i++) {
    const c = padded.charCodeAt(i);
    v[NAME_OFFSET + i] = c >= 32 && c < 127 ? c : 32;
  }
}

/** The factory INIT VOICE, parameters only (name excluded). */
export const INIT_VOICE_PARAMS: Uint8Array = (() => {
  const v = new Uint8Array(UNPACKED_SIZE);
  for (let op = 0; op < 6; op++) {
    const d = op * 21;
    v[d + 0] = 99; v[d + 1] = 99; v[d + 2] = 99; v[d + 3] = 99;
    v[d + 4] = 99; v[d + 5] = 99; v[d + 6] = 99; v[d + 7] = 0;
    v[d + 8] = 39; // break point C3
    v[d + 16] = op === 5 ? 99 : 0; // only OP1 (index 5) is audible
    v[d + 18] = 1; // coarse 1
    v[d + 20] = 7; // detune centre
  }
  for (let i = 0; i < 4; i++) v[126 + i] = 99;
  for (let i = 0; i < 4; i++) v[130 + i] = 50;
  v[136] = 1; // osc key sync
  v[137] = 35; // LFO speed
  v[141] = 1; // LFO key sync
  v[143] = 3; // pitch mod sensitivity
  v[144] = 24; // transpose centre
  return v;
})();

export function isInitVoice(v: Uint8Array): boolean {
  for (let i = 0; i < NAME_OFFSET; i++) {
    if (v[i] !== INIT_VOICE_PARAMS[i]) return false;
  }
  return true;
}

/** True when no operator that reaches the output bus has any level. */
export function isSilentByParams(v: Uint8Array, isCarrier: (alg: number, op: number) => boolean): boolean {
  const alg = v[P.algorithm] & 31;
  for (let op = 0; op < 6; op++) {
    if (isCarrier(alg, op) && v[P.opOutputLevel(op)] > 0) return false;
  }
  return true;
}

/** True when every parameter byte is zero. */
export function isZeroVoice(v: Uint8Array): boolean {
  for (let i = 0; i < NAME_OFFSET; i++) if (v[i] !== 0) return false;
  return true;
}
