/*
 * Who each patch's nearest neighbours are.
 *
 * The map's axes have always been principal components, and principal
 * components answer a question nobody asked. They find the directions the
 * whole corpus varies in most, which is a statement about the corpus as a
 * block; what you want from a map of sounds is that two patches which sound
 * alike are drawn near each other. Those are different goals, and PCA
 * regularly sacrifices the second for the first - a strong global direction
 * spreads a tight family across half the plot because that is where the
 * variance is.
 *
 * Fixing that needs a layout built from neighbourhoods, and a layout built
 * from neighbourhoods needs to know them. Hence this.
 *
 * Exact nearest neighbours are out of reach. Thirty-five thousand voices is
 * six hundred million pairs, sixty-eight multiplications each, and the corpus
 * grows. So this is NN-descent, which is the standard answer and rests on one
 * observation: a neighbour of your neighbour is a good candidate for being
 * your neighbour. Start from random guesses, repeatedly look at the
 * neighbours of your current neighbours, keep the best. It converges in a
 * handful of passes and touches a tiny fraction of the pairs.
 *
 * The result is approximate. For a picture that is the right trade: a
 * neighbour list that is ninety-something percent right produces a layout
 * nobody can tell from the exact one, in a twentieth of the time.
 */

export interface KnnGraph {
  n: number;
  k: number;
  /** n * k neighbour indices, nearest first. */
  indices: Int32Array;
  /** n * k distances, matching `indices`. */
  distances: Float32Array;
}

export interface KnnOptions {
  k?: number;
  /** Stop when a pass improves fewer than this fraction of slots. */
  tolerance?: number;
  maxIterations?: number;
  seed?: number;
  /** Called between passes so the caller can yield and report. */
  onProgress?: (pass: number, total: number, changed: number) => void;
}

const DEFAULTS = { k: 12, tolerance: 0.002, maxIterations: 12, seed: 1 } as const;

function sqDist(data: Float32Array, dim: number, a: number, b: number): number {
  let sum = 0;
  const i = a * dim;
  const j = b * dim;
  for (let d = 0; d < dim; d++) {
    const x = data[i + d] - data[j + d];
    sum += x * x;
  }
  return sum;
}

/**
 * A fixed-size max-heap of the k best neighbours seen so far, per point.
 *
 * Flat arrays rather than objects: at thirty-five thousand points and twelve
 * neighbours this is half a million slots that are rewritten dozens of times,
 * and the allocation alone would dominate.
 */
class Candidates {
  readonly dist: Float32Array;
  readonly idx: Int32Array;
  readonly fresh: Uint8Array;
  readonly k: number;

  constructor(n: number, k: number) {
    this.k = k;
    this.dist = new Float32Array(n * k).fill(Infinity);
    this.idx = new Int32Array(n * k).fill(-1);
    this.fresh = new Uint8Array(n * k);
  }

  /** Insert if it beats the current worst. Returns 1 if it did. */
  push(point: number, other: number, d: number): number {
    const base = point * this.k;
    if (d >= this.dist[base]) return 0;
    for (let i = 0; i < this.k; i++) {
      if (this.idx[base + i] === other) return 0;
    }
    // Sift down from the root of a max-heap kept as a sorted-by-worst array.
    let i = 0;
    for (;;) {
      const left = 2 * i + 1;
      const right = left + 1;
      let swap = i;
      if (left < this.k && this.dist[base + left] > d) swap = left;
      if (right < this.k && this.dist[base + right] > this.dist[base + swap]) swap = right;
      if (swap === i) break;
      this.dist[base + i] = this.dist[base + swap];
      this.idx[base + i] = this.idx[base + swap];
      this.fresh[base + i] = this.fresh[base + swap];
      i = swap;
    }
    this.dist[base + i] = d;
    this.idx[base + i] = other;
    this.fresh[base + i] = 1;
    return 1;
  }
}

export function buildKnn(
  data: Float32Array, n: number, dim: number, opts: KnnOptions = {},
): KnnGraph {
  const k = Math.max(2, Math.min(opts.k ?? DEFAULTS.k, n - 1));
  const tolerance = opts.tolerance ?? DEFAULTS.tolerance;
  const maxIterations = opts.maxIterations ?? DEFAULTS.maxIterations;
  let seed = (opts.seed ?? DEFAULTS.seed) >>> 0;
  const rnd = () => {
    // xorshift32: deterministic, so the same corpus always gets the same map.
    seed ^= seed << 13; seed >>>= 0;
    seed ^= seed >>> 17;
    seed ^= seed << 5; seed >>>= 0;
    return seed / 4294967296;
  };

  const heap = new Candidates(n, k);
  for (let i = 0; i < n; i++) {
    for (let s = 0; s < k; s++) {
      const j = Math.floor(rnd() * n);
      if (j !== i) heap.push(i, j, sqDist(data, dim, i, j));
    }
  }

  // Reverse neighbours matter as much as forward ones: if you are in my list
  // and I am not in yours, my other neighbours are still worth you seeing.
  const newFwd = new Int32Array(n * k);
  const newCount = new Int32Array(n);
  const oldFwd = new Int32Array(n * k);
  const oldCount = new Int32Array(n);

  for (let pass = 0; pass < maxIterations; pass++) {
    newCount.fill(0);
    oldCount.fill(0);
    for (let i = 0; i < n; i++) {
      const base = i * k;
      for (let s = 0; s < k; s++) {
        const j = heap.idx[base + s];
        if (j < 0) continue;
        if (heap.fresh[base + s]) {
          if (newCount[i] < k) newFwd[i * k + newCount[i]++] = j;
          if (newCount[j] < k) newFwd[j * k + newCount[j]++] = i;
          heap.fresh[base + s] = 0;
        } else {
          if (oldCount[i] < k) oldFwd[i * k + oldCount[i]++] = j;
          if (oldCount[j] < k) oldFwd[j * k + oldCount[j]++] = i;
        }
      }
    }

    let changed = 0;
    for (let i = 0; i < n; i++) {
      const nc = newCount[i];
      const oc = oldCount[i];
      for (let a = 0; a < nc; a++) {
        const x = newFwd[i * k + a];
        // new against new, each pair once
        for (let b = a + 1; b < nc; b++) {
          const y = newFwd[i * k + b];
          if (x === y) continue;
          const d = sqDist(data, dim, x, y);
          changed += heap.push(x, y, d);
          changed += heap.push(y, x, d);
        }
        // new against old
        for (let b = 0; b < oc; b++) {
          const y = oldFwd[i * k + b];
          if (x === y) continue;
          const d = sqDist(data, dim, x, y);
          changed += heap.push(x, y, d);
          changed += heap.push(y, x, d);
        }
      }
    }

    opts.onProgress?.(pass + 1, maxIterations, changed);
    if (changed <= tolerance * n * k) break;
  }

  // Sort each list nearest-first; the layout wants the closest one to set the
  // scale for the rest.
  const indices = new Int32Array(n * k);
  const distances = new Float32Array(n * k);
  const order: number[] = [];
  for (let i = 0; i < n; i++) {
    const base = i * k;
    order.length = 0;
    for (let s = 0; s < k; s++) if (heap.idx[base + s] >= 0) order.push(s);
    order.sort((a, b) => heap.dist[base + a] - heap.dist[base + b]);
    for (let s = 0; s < k; s++) {
      if (s < order.length) {
        indices[base + s] = heap.idx[base + order[s]];
        distances[base + s] = Math.sqrt(heap.dist[base + order[s]]);
      } else {
        indices[base + s] = -1;
        distances[base + s] = Infinity;
      }
    }
  }
  return { n, k, indices, distances };
}

/**
 * How often the approximate list agrees with the exact one.
 *
 * Only for tests and for reassuring yourself on a new corpus - it is the
 * quadratic computation the rest of this file exists to avoid.
 */
export function knnRecall(
  data: Float32Array, n: number, dim: number, graph: KnnGraph, sample = 200, seed = 7,
): number {
  let s = seed >>> 0;
  const rnd = () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
  const k = graph.k;
  let hit = 0;
  let total = 0;
  const pairs: Array<[number, number]> = [];
  for (let t = 0; t < Math.min(sample, n); t++) {
    const i = Math.floor(rnd() * n);
    pairs.length = 0;
    for (let j = 0; j < n; j++) {
      if (j !== i) pairs.push([j, sqDist(data, dim, i, j)]);
    }
    pairs.sort((a, b) => a[1] - b[1]);
    const truth = new Set(pairs.slice(0, k).map(([j]) => j));
    for (let s2 = 0; s2 < k; s2++) {
      const got = graph.indices[i * k + s2];
      if (got >= 0 && truth.has(got)) hit++;
      total++;
    }
  }
  return total > 0 ? hit / total : 0;
}
