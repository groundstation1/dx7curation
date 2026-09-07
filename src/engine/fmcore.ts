/*
 * DX7 algorithm graph and operator kernels - port of msfa fm_core.cc and
 * fm_op_kernel.cc (Google Inc. / Pascal Gauthier), Apache 2.0.
 *
 * Operator index 0 is OP6 and index 5 is OP1, matching the order operators are
 * stored in the sysex voice data. The algorithm table is indexed 0..31 for
 * algorithms 1..32.
 */
import { LG_N, N, exp2Lookup, sinLookup } from './tables.ts';

export const OUT_BUS_ONE = 1 << 0;
export const OUT_BUS_TWO = 1 << 1;
export const OUT_BUS_ADD = 1 << 2;
export const IN_BUS_ONE = 1 << 4;
export const IN_BUS_TWO = 1 << 5;
export const FB_IN = 1 << 6;
export const FB_OUT = 1 << 7;

/** algorithms[alg][op] - op 0 is OP6. */
export const algorithms: number[][] = [
  [0xc1, 0x11, 0x11, 0x14, 0x01, 0x14], // 1
  [0x01, 0x11, 0x11, 0x14, 0xc1, 0x14], // 2
  [0xc1, 0x11, 0x14, 0x01, 0x11, 0x14], // 3
  [0xc1, 0x11, 0x94, 0x01, 0x11, 0x14], // 4
  [0xc1, 0x14, 0x01, 0x14, 0x01, 0x14], // 5
  [0xc1, 0x94, 0x01, 0x14, 0x01, 0x14], // 6
  [0xc1, 0x11, 0x05, 0x14, 0x01, 0x14], // 7
  [0x01, 0x11, 0xc5, 0x14, 0x01, 0x14], // 8
  [0x01, 0x11, 0x05, 0x14, 0xc1, 0x14], // 9
  [0x01, 0x05, 0x14, 0xc1, 0x11, 0x14], // 10
  [0xc1, 0x05, 0x14, 0x01, 0x11, 0x14], // 11
  [0x01, 0x05, 0x05, 0x14, 0xc1, 0x14], // 12
  [0xc1, 0x05, 0x05, 0x14, 0x01, 0x14], // 13
  [0xc1, 0x05, 0x11, 0x14, 0x01, 0x14], // 14
  [0x01, 0x05, 0x11, 0x14, 0xc1, 0x14], // 15
  [0xc1, 0x11, 0x02, 0x25, 0x05, 0x14], // 16
  [0x01, 0x11, 0x02, 0x25, 0xc5, 0x14], // 17
  [0x01, 0x11, 0x11, 0xc5, 0x05, 0x14], // 18
  [0xc1, 0x14, 0x14, 0x01, 0x11, 0x14], // 19
  [0x01, 0x05, 0x14, 0xc1, 0x14, 0x14], // 20
  [0x01, 0x14, 0x14, 0xc1, 0x14, 0x14], // 21
  [0xc1, 0x14, 0x14, 0x14, 0x01, 0x14], // 22
  [0xc1, 0x14, 0x14, 0x01, 0x14, 0x04], // 23
  [0xc1, 0x14, 0x14, 0x14, 0x04, 0x04], // 24
  [0xc1, 0x14, 0x14, 0x04, 0x04, 0x04], // 25
  [0xc1, 0x05, 0x14, 0x01, 0x14, 0x04], // 26
  [0x01, 0x05, 0x14, 0xc1, 0x14, 0x04], // 27
  [0x04, 0xc1, 0x11, 0x14, 0x01, 0x14], // 28
  [0xc1, 0x14, 0x01, 0x14, 0x04, 0x04], // 29
  [0x04, 0xc1, 0x11, 0x14, 0x04, 0x04], // 30
  [0xc1, 0x14, 0x04, 0x04, 0x04, 0x04], // 31
  [0xc4, 0x04, 0x04, 0x04, 0x04, 0x04], // 32
];

/**
 * True when operator `op` (0 = OP6) feeds the output bus in `algorithm`.
 *
 * Tested against the output bus rather than the OUT_BUS_ADD flag. Dexed's own
 * isCarrier uses the flag, but the flag only means "add to whichever bus you
 * are writing to", and several algorithms have operators that add into an
 * intermediate bus - 0x05 writes to bus 1 with add, and is a modulator. Using
 * the flag over-counts carriers on eleven of the thirty-two algorithms, which
 * matters here because the lowest carrier is what sets a voice's perceived
 * fundamental. In Dexed the looser test only decides when a note has finished
 * sounding, so it goes unnoticed.
 */
export function isCarrier(algorithm: number, op: number): boolean {
  return (algorithms[algorithm][op] & 3) === 0;
}

/** Number of carriers in an algorithm. */
export function carrierCount(algorithm: number): number {
  let n = 0;
  for (let op = 0; op < 6; op++) if (isCarrier(algorithm, op)) n++;
  return n;
}

/** Operator index (0 = OP6) that carries the feedback loop, or -1. */
export function feedbackOp(algorithm: number): number {
  for (let op = 0; op < 6; op++) {
    if ((algorithms[algorithm][op] & 0xc0) === 0xc0) return op;
  }
  return -1;
}

export interface FmOpParams {
  levelIn: number;
  gainOut: number;
  freq: number;
  phase: number;
}

export function makeOpParams(): FmOpParams[] {
  return Array.from({ length: 6 }, () => ({ levelIn: 0, gainOut: 0, freq: 0, phase: 0 }));
}

// ------------------------------------------------------------------ kernels

function computeOp(
  output: Int32Array, input: Int32Array,
  phase0: number, freq: number, gain1: number, gain2: number, add: boolean,
): void {
  const dgain = (gain2 - gain1 + (N >> 1)) >> LG_N;
  let gain = gain1;
  let phase = phase0;
  for (let i = 0; i < N; i++) {
    gain += dgain;
    const y = sinLookup((phase + input[i]) | 0);
    const y1 = Math.floor((y * gain) / 16777216);
    output[i] = add ? (output[i] + y1) | 0 : y1 | 0;
    phase = (phase + freq) | 0;
  }
}

function computePure(
  output: Int32Array,
  phase0: number, freq: number, gain1: number, gain2: number, add: boolean,
): void {
  const dgain = (gain2 - gain1 + (N >> 1)) >> LG_N;
  let gain = gain1;
  let phase = phase0;
  for (let i = 0; i < N; i++) {
    gain += dgain;
    const y = sinLookup(phase);
    const y1 = Math.floor((y * gain) / 16777216);
    output[i] = add ? (output[i] + y1) | 0 : y1 | 0;
    phase = (phase + freq) | 0;
  }
}

function computeFb(
  output: Int32Array,
  phase0: number, freq: number, gain1: number, gain2: number,
  fbBuf: Int32Array, fbShift: number, add: boolean,
): void {
  const dgain = (gain2 - gain1 + (N >> 1)) >> LG_N;
  let gain = gain1;
  let phase = phase0;
  let y0 = fbBuf[0];
  let y = fbBuf[1];
  for (let i = 0; i < N; i++) {
    gain += dgain;
    const scaledFb = ((y0 + y) | 0) >> (fbShift + 1);
    y0 = y;
    y = sinLookup((phase + scaledFb) | 0);
    y = Math.floor((y * gain) / 16777216) | 0;
    output[i] = add ? (output[i] + y) | 0 : y;
    phase = (phase + freq) | 0;
  }
  fbBuf[0] = y0;
  fbBuf[1] = y;
}

// --------------------------------------------------------------------- core

const K_LEVEL_THRESH = 1120;

export class FmCore {
  private bus1 = new Int32Array(N);
  private bus2 = new Int32Array(N);

  render(
    output: Int32Array, params: FmOpParams[], algorithm: number,
    fbBuf: Int32Array, feedbackShift: number,
  ): void {
    const alg = algorithms[algorithm];
    const hasContents = [true, false, false];
    for (let op = 0; op < 6; op++) {
      const flags = alg[op];
      let add = (flags & OUT_BUS_ADD) !== 0;
      const param = params[op];
      const inbus = (flags >> 4) & 3;
      const outbus = flags & 3;
      const outptr = outbus === 0 ? output : outbus === 1 ? this.bus1 : this.bus2;
      const gain1 = param.gainOut;
      const gain2 = exp2Lookup(param.levelIn - 234881024); // 14 << 24
      param.gainOut = gain2;

      if (gain1 >= K_LEVEL_THRESH || gain2 >= K_LEVEL_THRESH) {
        if (!hasContents[outbus]) add = false;
        if (inbus === 0 || !hasContents[inbus]) {
          if ((flags & 0xc0) === 0xc0 && feedbackShift < 16) {
            computeFb(outptr, param.phase, param.freq, gain1, gain2, fbBuf, feedbackShift, add);
          } else {
            computePure(outptr, param.phase, param.freq, gain1, gain2, add);
          }
        } else {
          computeOp(outptr, inbus === 1 ? this.bus1 : this.bus2,
            param.phase, param.freq, gain1, gain2, add);
        }
        hasContents[outbus] = true;
      } else if (!add) {
        hasContents[outbus] = false;
      }
      param.phase = (param.phase + ((param.freq << LG_N) | 0)) | 0;
    }
  }
}
