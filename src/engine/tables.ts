/*
 * DX7 FM engine — TypeScript port of msfa (music-synthesizer-for-android)
 * Copyright 2012-2013 Google Inc. (Raph Levien)
 * Copyright 2017 Pascal Gauthier (Dexed)
 * Licensed under the Apache License, Version 2.0.
 *
 * Fixed-point lookup tables. All of these are direct transliterations; the only
 * changes are the ones JS forces: int64 intermediates become Math.floor on
 * doubles (every product here stays under 2^53), and the sine table is built
 * with BigInt because its Q30 recurrence does exceed 2^53.
 */

export const LG_N = 6;
export const N = 1 << LG_N;

// ---------------------------------------------------------------- Sin (Q24)

const SIN_LG_N_SAMPLES = 10;
const SIN_N_SAMPLES = 1 << SIN_LG_N_SAMPLES;
export const sintab = new Int32Array(SIN_N_SAMPLES << 1);

function sinInit(): void {
  const dphase = (2 * Math.PI) / SIN_N_SAMPLES;
  const R = 1n << 29n;
  const c = BigInt(Math.floor(Math.cos(dphase) * (1 << 30) + 0.5));
  const s = BigInt(Math.floor(Math.sin(dphase) * (1 << 30) + 0.5));
  let u = 1n << 30n;
  let v = 0n;
  for (let i = 0; i < SIN_N_SAMPLES / 2; i++) {
    const q = Number((v + 32n) >> 6n);
    sintab[(i << 1) + 1] = q;
    sintab[((i + SIN_N_SAMPLES / 2) << 1) + 1] = -q;
    const t = (u * s + v * c + R) >> 30n;
    u = (u * c - v * s + R) >> 30n;
    v = t;
  }
  for (let i = 0; i < SIN_N_SAMPLES - 1; i++) {
    sintab[i << 1] = sintab[(i << 1) + 3] - sintab[(i << 1) + 1];
  }
  sintab[(SIN_N_SAMPLES << 1) - 2] = -sintab[(SIN_N_SAMPLES << 1) - 1];
}

/** phase is Q24 turns (2^24 == one cycle); result is Q24 in [-2^24, 2^24]. */
export function sinLookup(phase: number): number {
  const lowbits = phase & 16383; // SHIFT = 24 - 10 = 14
  const phaseInt = (phase >> 13) & ((SIN_N_SAMPLES - 1) << 1);
  const dy = sintab[phaseInt];
  const y0 = sintab[phaseInt + 1];
  return (y0 + Math.floor((dy * lowbits) / 16384)) | 0;
}

// --------------------------------------------------------------- Exp2 (Q24)

const EXP2_LG_N_SAMPLES = 10;
const EXP2_N_SAMPLES = 1 << EXP2_LG_N_SAMPLES;
export const exp2tab = new Int32Array(EXP2_N_SAMPLES << 1);

function exp2Init(): void {
  const inc = Math.pow(2, 1 / EXP2_N_SAMPLES);
  let y = 1 << 30;
  for (let i = 0; i < EXP2_N_SAMPLES; i++) {
    exp2tab[(i << 1) + 1] = Math.floor(y + 0.5);
    y *= inc;
  }
  for (let i = 0; i < EXP2_N_SAMPLES - 1; i++) {
    exp2tab[i << 1] = exp2tab[(i << 1) + 3] - exp2tab[(i << 1) + 1];
  }
  exp2tab[(EXP2_N_SAMPLES << 1) - 2] = 2147483648 - exp2tab[(EXP2_N_SAMPLES << 1) - 1];
}

/** Q24 in, Q24 out: 2^(x / 2^24). Valid for x < 7 * 2^24. */
export function exp2Lookup(x: number): number {
  const lowbits = x & 16383;
  const xInt = (x >> 13) & ((EXP2_N_SAMPLES - 1) << 1);
  const dy = exp2tab[xInt];
  const y0 = exp2tab[xInt + 1];
  const y = y0 + Math.floor((dy * lowbits) / 16384);
  return Math.floor(y / Math.pow(2, 6 - (x >> 24)));
}

// ------------------------------------------------------------------ Freqlut

const FREQLUT_N_SAMPLES = 1024;
const MAX_LOGFREQ_INT = 20;
export const freqlutTab = new Int32Array(FREQLUT_N_SAMPLES + 1);

function freqlutInit(sampleRate: number): void {
  let y = Math.pow(2, 24 + MAX_LOGFREQ_INT) / sampleRate;
  const inc = Math.pow(2, 1 / FREQLUT_N_SAMPLES);
  for (let i = 0; i < FREQLUT_N_SAMPLES + 1; i++) {
    freqlutTab[i] = Math.floor(y + 0.5);
    y *= inc;
  }
}

/** logfreq is Q24 with 1.0 == one octave; result is a Q24 phase delta. */
export function freqlutLookup(logfreq: number): number {
  const ix = (logfreq & 0xffffff) >> 14;
  const y0 = freqlutTab[ix];
  const y1 = freqlutTab[ix + 1];
  const lowbits = logfreq & 16383;
  const y = y0 + Math.floor(((y1 - y0) * lowbits) / 16384);
  const hibits = logfreq >> 24;
  return y >> (MAX_LOGFREQ_INT - hibits);
}

// ------------------------------------------------------- Pitch envelope LUTs

export const pitchenvRate = new Uint8Array([
  1, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12,
  12, 13, 13, 14, 14, 15, 16, 16, 17, 18, 18, 19, 20, 21, 22, 23, 24,
  25, 26, 27, 28, 30, 31, 33, 34, 36, 37, 38, 39, 41, 42, 44, 46, 47,
  49, 51, 53, 54, 56, 58, 60, 62, 64, 66, 68, 70, 72, 74, 76, 79, 82,
  85, 88, 91, 94, 98, 102, 106, 110, 115, 120, 125, 130, 135, 141, 147,
  153, 159, 165, 171, 178, 185, 193, 202, 211, 232, 243, 254, 255,
]);

export const pitchenvTab = new Int8Array([
  -128, -116, -104, -95, -85, -76, -68, -61, -56, -52, -49, -46, -43,
  -41, -39, -37, -35, -33, -32, -31, -30, -29, -28, -27, -26, -25, -24,
  -23, -22, -21, -20, -19, -18, -17, -16, -15, -14, -13, -12, -11, -10,
  -9, -8, -7, -6, -5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
  11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27,
  28, 29, 30, 31, 32, 33, 34, 35, 38, 40, 43, 46, 49, 53, 58, 65, 73,
  82, 92, 103, 115, 127,
]);

// --------------------------------------------------------------- global init

/** Per-sample-rate state shared by the envelope, pitch envelope and LFO. */
export const rateState = {
  sampleRate: 0,
  /** Env: (44100 / sr) in Q24. */
  envSrMultiplier: 1 << 24,
  /** PitchEnv::unit_ */
  pitchEnvUnit: 0,
  /** Lfo::unit_ */
  lfoUnit: 0,
  /** Lfo::lforatio_ */
  lfoRatio: 0,
};

let tablesReady = false;

export function initEngine(sampleRate: number): void {
  if (!tablesReady) {
    sinInit();
    exp2Init();
    tablesReady = true;
  }
  if (rateState.sampleRate === sampleRate) return;
  freqlutInit(sampleRate);
  rateState.sampleRate = sampleRate;
  rateState.envSrMultiplier = Math.trunc((44100.0 / sampleRate) * (1 << 24));
  rateState.pitchEnvUnit = Math.trunc((N * (1 << 24)) / (21.3 * sampleRate) + 0.5);
  rateState.lfoUnit = Math.trunc((N * 25190424) / sampleRate + 0.5);
  rateState.lfoRatio = Math.trunc((4437500000.0 * N) / sampleRate);
}
