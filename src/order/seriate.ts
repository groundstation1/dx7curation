/*
 * Ordering the final 128 as one continuum.
 *
 * This is a shortest-Hamiltonian-path problem with fixed endpoints: nearest
 * neighbour to build, then 2-opt and Or-opt to improve. Segment reversal never
 * moves the first or last element, so the endpoints stay pinned for free.
 *
 * The macro shape - keys through to abstract texture - is imposed by appending
 * a category-rank dimension to the vectors before solving. Weight it high and
 * the path marches through the categories in order; weight it low and the path
 * follows the sound wherever it goes. Either way the split into banks A-D at
 * 32/64/96 ignores category boundaries, because the point is that neighbouring
 * slots sound adjacent wherever the user happens to land while scrolling.
 */
import { type Category } from '../cluster/category.ts';

/** The intended macro order of the finished 128. */
export const CATEGORY_ORDER: Category[] = [
  'keys',
  'bells',
  'plucked',
  'bass',
  'brass',
  'lead',
  'organ',
  'strings',
  'abstract',
];

export function categoryRank(c: Category): number {
  const i = CATEGORY_ORDER.indexOf(c);
  return i < 0 ? CATEGORY_ORDER.length : i;
}

export interface SeriateOptions {
  /** Index of the voice that must come first. */
  startIndex?: number;
  /** Index of the voice that must come last. */
  endIndex?: number;
  /** 2-opt / Or-opt passes. */
  maxPasses?: number;
}

function buildDistanceMatrix(vectors: Float32Array[]): Float32Array {
  const n = vectors.length;
  const dim = vectors[0]?.length ?? 0;
  const d = new Float32Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      let sum = 0;
      const a = vectors[i];
      const b = vectors[j];
      for (let k = 0; k < dim; k++) {
        const x = a[k] - b[k];
        sum += x * x;
      }
      const dist = Math.sqrt(sum);
      d[i * n + j] = dist;
      d[j * n + i] = dist;
    }
  }
  return d;
}

export function pathLength(order: number[], d: Float32Array, n: number): number {
  let sum = 0;
  for (let i = 1; i < order.length; i++) sum += d[order[i - 1] * n + order[i]];
  return sum;
}

/**
 * Append a category dimension so the path traverses categories in the intended
 * order. `weight` is in units of the standardised feature space; a value near
 * the typical inter-voice distance keeps categories contiguous while still
 * letting an acoustically adjacent pair cross a boundary.
 */
export function withCategoryAxis(
  vectors: Float32Array[], categories: Category[], weight: number,
): Float32Array[] {
  return vectors.map((v, i) => {
    const out = new Float32Array(v.length + 1);
    out.set(v, 0);
    out[v.length] = categoryRank(categories[i]) * weight;
    return out;
  });
}

/** Nearest-neighbour path from `start`, ending at `end`. */
function nearestNeighbourPath(n: number, d: Float32Array, start: number, end: number): number[] {
  const visited = new Uint8Array(n);
  const order: number[] = [start];
  visited[start] = 1;
  if (end !== start) visited[end] = 1;
  let current = start;
  for (let step = 1; step < n - (end === start ? 0 : 1); step++) {
    let best = -1;
    let bestD = Infinity;
    for (let j = 0; j < n; j++) {
      if (visited[j]) continue;
      const dist = d[current * n + j];
      if (dist < bestD) {
        bestD = dist;
        best = j;
      }
    }
    if (best < 0) break;
    visited[best] = 1;
    order.push(best);
    current = best;
  }
  if (end !== start) order.push(end);
  return order;
}

/** 2-opt: reverse an interior segment when it shortens the path. */
function twoOpt(order: number[], d: Float32Array, n: number, maxPasses: number): number {
  let improvements = 0;
  const len = order.length;
  for (let pass = 0; pass < maxPasses; pass++) {
    let improved = false;
    for (let i = 1; i < len - 2; i++) {
      const a = order[i - 1];
      const b = order[i];
      for (let j = i + 1; j < len - 1; j++) {
        const c = order[j];
        const e = order[j + 1];
        const before = d[a * n + b] + d[c * n + e];
        const after = d[a * n + c] + d[b * n + e];
        if (after < before - 1e-6) {
          for (let lo = i, hi = j; lo < hi; lo++, hi--) {
            const t = order[lo];
            order[lo] = order[hi];
            order[hi] = t;
          }
          improved = true;
          improvements++;
          break;
        }
      }
    }
    if (!improved) break;
  }
  return improvements;
}

/** Or-opt: move a run of 1-3 voices somewhere else in the path. */
function orOpt(order: number[], d: Float32Array, n: number, maxPasses: number): number {
  let improvements = 0;
  for (let pass = 0; pass < maxPasses; pass++) {
    let improved = false;
    for (let runLength = 1; runLength <= 3; runLength++) {
      for (let i = 1; i + runLength < order.length - 1; i++) {
        const prev = order[i - 1];
        const first = order[i];
        const last = order[i + runLength - 1];
        const next = order[i + runLength];
        const removed = d[prev * n + first] + d[last * n + next] - d[prev * n + next];
        if (removed <= 1e-6) continue;
        const run = order.slice(i, i + runLength);
        const rest = order.slice(0, i).concat(order.slice(i + runLength));
        let bestGain = 0;
        let bestAt = -1;
        let bestReversed = false;
        for (let j = 1; j < rest.length; j++) {
          const a = rest[j - 1];
          const b = rest[j];
          const base = d[a * n + b];
          const fwd = d[a * n + run[0]] + d[run[run.length - 1] * n + b] - base;
          const rev = d[a * n + run[run.length - 1]] + d[run[0] * n + b] - base;
          const gain = removed - Math.min(fwd, rev);
          if (gain > bestGain + 1e-6) {
            bestGain = gain;
            bestAt = j;
            bestReversed = rev < fwd;
          }
        }
        if (bestAt >= 0) {
          const insert = bestReversed ? [...run].reverse() : run;
          rest.splice(bestAt, 0, ...insert);
          order.length = 0;
          order.push(...rest);
          improved = true;
          improvements++;
        }
      }
    }
    if (!improved) break;
  }
  return improvements;
}

export interface SeriateResult {
  order: number[];
  length: number;
  initialLength: number;
  improvements: number;
}

export function seriate(vectors: Float32Array[], opts: SeriateOptions = {}): SeriateResult {
  const n = vectors.length;
  if (n === 0) return { order: [], length: 0, initialLength: 0, improvements: 0 };
  if (n === 1) return { order: [0], length: 0, initialLength: 0, improvements: 0 };

  const d = buildDistanceMatrix(vectors);
  const start = opts.startIndex ?? 0;
  let end = opts.endIndex ?? n - 1;
  if (end === start) end = start === 0 ? n - 1 : 0;
  const maxPasses = opts.maxPasses ?? 60;

  const order = nearestNeighbourPath(n, d, start, end);
  const initialLength = pathLength(order, d, n);
  let improvements = 0;
  for (let round = 0; round < 6; round++) {
    const a = twoOpt(order, d, n, maxPasses);
    const b = orOpt(order, d, n, 4);
    improvements += a + b;
    if (a + b === 0) break;
  }
  return { order, length: pathLength(order, d, n), initialLength, improvements };
}

/**
 * Pick the endpoints: the voice deepest inside the first category and the one
 * deepest inside the last, measured as distance to that category's centroid.
 */
export function chooseEndpoints(
  vectors: Float32Array[], categories: Category[],
): { startIndex: number; endIndex: number } {
  const deepest = (target: Category, fallbackIndex: number): number => {
    const members = categories.flatMap((c, i) => (c === target ? [i] : []));
    if (members.length === 0) return fallbackIndex;
    const dim = vectors[0].length;
    const centre = new Float32Array(dim);
    for (const i of members) for (let k = 0; k < dim; k++) centre[k] += vectors[i][k];
    for (let k = 0; k < dim; k++) centre[k] /= members.length;
    let best = members[0];
    let bestD = Infinity;
    for (const i of members) {
      let sum = 0;
      for (let k = 0; k < dim; k++) {
        const x = vectors[i][k] - centre[k];
        sum += x * x;
      }
      if (sum < bestD) {
        bestD = sum;
        best = i;
      }
    }
    return best;
  };
  const startIndex = deepest(CATEGORY_ORDER[0], 0);
  let endIndex = deepest(CATEGORY_ORDER[CATEGORY_ORDER.length - 1], vectors.length - 1);
  if (endIndex === startIndex) endIndex = (startIndex + 1) % vectors.length;
  return { startIndex, endIndex };
}

/** Split an ordered list into four equal banks, ignoring category boundaries. */
export function splitIntoBanks<T>(ordered: T[]): T[][] {
  const per = Math.ceil(ordered.length / 4);
  return [0, 1, 2, 3].map((b) => ordered.slice(b * per, (b + 1) * per));
}


