/*
 * Exact deduplication.
 *
 * The name field is excluded, so the same patch under twenty different names
 * collapses to one voice - which is most of what the overlap between these
 * archives actually is. Every name and source that mapped onto a survivor is
 * kept, so provenance is never lost.
 */
import { UNPACKED_RANGES, NAME_OFFSET, packedKeyOf } from '../sysex/voice.ts';

export interface ExactDedupeResult {
  /** Index of the surviving voice for each input index. */
  groupOf: Int32Array;
  /** Input indices that survived, in first-seen order. */
  representatives: number[];
  /** For each representative, every input index that collapsed onto it. */
  members: number[][];
}

export { packedKeyOf } from '../sysex/voice.ts';

export function exactDedupe(packedVoices: Uint8Array[]): ExactDedupeResult {
  const seen = new Map<string, number>(); // key -> representative slot in `members`
  const groupOf = new Int32Array(packedVoices.length);
  const representatives: number[] = [];
  const members: number[][] = [];

  for (let i = 0; i < packedVoices.length; i++) {
    const key = packedKeyOf(packedVoices[i]);
    const slot = seen.get(key);
    if (slot === undefined) {
      seen.set(key, members.length);
      groupOf[i] = i;
      representatives.push(i);
      members.push([i]);
    } else {
      groupOf[i] = representatives[slot];
      members[slot].push(i);
    }
  }

  return { groupOf, representatives, members };
}

// ------------------------------------------------------ parameter distance

const INV_RANGE = (() => {
  const inv = new Float32Array(NAME_OFFSET);
  for (let i = 0; i < NAME_OFFSET; i++) {
    const [lo, hi] = UNPACKED_RANGES[i];
    inv[i] = hi > lo ? 1 / (hi - lo) : 0;
  }
  return inv;
})();

/**
 * Mean normalised parameter difference over the 145 non-name parameters.
 * Normalising by each parameter's own range means one step of detune counts
 * the same as one step of output level relative to what that control can do.
 */
export function paramDistance(a: Uint8Array, b: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < NAME_OFFSET; i++) {
    const d = a[i] - b[i];
    sum += (d < 0 ? -d : d) * INV_RANGE[i];
  }
  return sum / NAME_OFFSET;
}

/** Fraction of the 145 non-name parameters that differ at all. */
export function paramDiffFraction(a: Uint8Array, b: Uint8Array): number {
  let n = 0;
  for (let i = 0; i < NAME_OFFSET; i++) if (a[i] !== b[i]) n++;
  return n / NAME_OFFSET;
}
