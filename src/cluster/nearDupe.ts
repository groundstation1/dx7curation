/*
 * Near-duplicate detection.
 *
 * All-pairs on 40,000 voices is 800 million comparisons, so the corpus is first
 * blocked with k-means and pairs are only formed inside a block. Each voice is
 * assigned to its two nearest blocks, which keeps pairs that straddle a block
 * boundary from being missed.
 *
 * The distance combines audio features with parameter distance, and both halves
 * are scaled so a typical unrelated pair sits at about 1.0. That makes the
 * threshold a number the user can reason about, and the sweep below reports
 * cluster counts across a range so they can pick one from the data rather than
 * from a hard-coded default.
 */
import { kmeans, nearestCentroids } from './kmeans.ts';
import { paramDistance } from './dedupe.ts';

export interface NearDupeOptions {
  /** Target voices per block. */
  blockSize?: number;
  /** Blocks each voice is compared inside. */
  blocksPerVoice?: number;
  /** Pairs at or above this combined distance are discarded. */
  maxDistance?: number;
  featureWeight?: number;
  paramWeight?: number;
  seed?: number;
  /** Safety valve; the edge list stops growing past this. */
  maxEdges?: number;
  onProgress?: (done: number, total: number, stage: string) => void;
}

export interface NearDupeGraph {
  n: number;
  /** Parallel arrays of candidate pairs, sorted by distance. */
  a: Int32Array;
  b: Int32Array;
  d: Float32Array;
  /** Scale factors that put a typical unrelated pair at 1.0. */
  featureScale: number;
  paramScale: number;
  featureWeight: number;
  paramWeight: number;
  blocks: number;
  truncated: boolean;
}

function sqDistRows(data: Float32Array, i: number, j: number, dim: number): number {
  let sum = 0;
  const a = i * dim;
  const b = j * dim;
  for (let d = 0; d < dim; d++) {
    const x = data[a + d] - data[b + d];
    sum += x * x;
  }
  return sum;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function medianOf(xs: number[]): number {
  if (xs.length === 0) return 1;
  const s = Float64Array.from(xs).sort();
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Calibrate both halves of the distance from a random sample of pairs. */
export function calibrateScales(
  data: Float32Array, n: number, dim: number, unpacked: Uint8Array[], samples = 20000, seed = 7,
): { featureScale: number; paramScale: number } {
  if (n < 2) return { featureScale: 1, paramScale: 1 };
  const rng = mulberry32(seed);
  const feat: number[] = [];
  const par: number[] = [];
  for (let s = 0; s < samples; s++) {
    const i = Math.floor(rng() * n);
    let j = Math.floor(rng() * n);
    if (i === j) j = (j + 1) % n;
    feat.push(Math.sqrt(sqDistRows(data, i, j, dim)));
    par.push(paramDistance(unpacked[i], unpacked[j]));
  }
  const fm = medianOf(feat);
  const pm = medianOf(par);
  return { featureScale: fm > 1e-9 ? fm : 1, paramScale: pm > 1e-9 ? pm : 1 };
}

export function buildNearDupeGraph(
  data: Float32Array, n: number, dim: number, unpacked: Uint8Array[],
  opts: NearDupeOptions = {},
): NearDupeGraph {
  const blockSize = opts.blockSize ?? 400;
  const blocksPerVoice = opts.blocksPerVoice ?? 2;
  const maxDistance = opts.maxDistance ?? 0.35;
  const featureWeight = opts.featureWeight ?? 0.6;
  const paramWeight = opts.paramWeight ?? 0.4;
  const maxEdges = opts.maxEdges ?? 40_000_000;
  const progress = opts.onProgress ?? (() => {});

  const { featureScale, paramScale } = calibrateScales(data, n, dim, unpacked, 20000, opts.seed ?? 7);

  const k = Math.max(1, Math.min(n, Math.ceil(n / blockSize)));
  progress(0, 1, `blocking into ${k} groups`);
  const km = k > 1 ? kmeans(data, n, dim, k, { maxIterations: 25, seed: opts.seed ?? 1 }) : null;

  // Membership lists, with each voice in its `blocksPerVoice` nearest blocks.
  const blocks: number[][] = Array.from({ length: k }, () => []);
  if (km) {
    const m = Math.max(1, Math.min(k, blocksPerVoice));
    for (let i = 0; i < n; i++) {
      for (const c of nearestCentroids(data, i, km.centroids, k, dim, m)) blocks[c].push(i);
      if ((i & 1023) === 0) progress(i, n, 'assigning blocks');
    }
  } else {
    for (let i = 0; i < n; i++) blocks[0].push(i);
  }

  const ea: number[] = [];
  const eb: number[] = [];
  const ed: number[] = [];
  const seen = new Set<number>();
  let truncated = false;

  for (let bi = 0; bi < blocks.length && !truncated; bi++) {
    const members = blocks[bi];
    progress(bi, blocks.length, 'comparing within blocks');
    for (let x = 0; x < members.length; x++) {
      const i = members[x];
      for (let y = x + 1; y < members.length; y++) {
        const j = members[y];
        const lo = i < j ? i : j;
        const hi = i < j ? j : i;
        // Cantor-free pair key; safe while n < 2^26.
        const key = lo * 67108864 + hi;
        if (seen.has(key)) continue;
        const df = Math.sqrt(sqDistRows(data, i, j, dim)) / featureScale;
        if (df * featureWeight >= maxDistance) {
          seen.add(key);
          continue;
        }
        const dp = paramDistance(unpacked[i], unpacked[j]) / paramScale;
        const d = featureWeight * df + paramWeight * dp;
        seen.add(key);
        if (d < maxDistance) {
          ea.push(lo);
          eb.push(hi);
          ed.push(d);
          if (ea.length >= maxEdges) {
            truncated = true;
            break;
          }
        }
      }
      if (truncated) break;
    }
  }

  const order = Array.from(ed.keys()).sort((p, q) => ed[p] - ed[q]);
  const a = new Int32Array(order.length);
  const b = new Int32Array(order.length);
  const d = new Float32Array(order.length);
  for (let i = 0; i < order.length; i++) {
    a[i] = ea[order[i]];
    b[i] = eb[order[i]];
    d[i] = ed[order[i]];
  }

  return { n, a, b, d, featureScale, paramScale, featureWeight, paramWeight, blocks: k, truncated };
}

// ------------------------------------------------------------- union-find

class UnionFind {
  private parent: Int32Array;
  private rank: Uint8Array;
  constructor(n: number) {
    this.parent = new Int32Array(n);
    for (let i = 0; i < n; i++) this.parent[i] = i;
    this.rank = new Uint8Array(n);
  }
  find(x: number): number {
    let root = x;
    while (this.parent[root] !== root) root = this.parent[root];
    while (this.parent[x] !== root) {
      const next = this.parent[x];
      this.parent[x] = root;
      x = next;
    }
    return root;
  }
  union(x: number, y: number): boolean {
    const a = this.find(x);
    const b = this.find(y);
    if (a === b) return false;
    if (this.rank[a] < this.rank[b]) this.parent[a] = b;
    else if (this.rank[a] > this.rank[b]) this.parent[b] = a;
    else {
      this.parent[b] = a;
      this.rank[a]++;
    }
    return true;
  }
}

export interface NearDupeClusters {
  threshold: number;
  /** Cluster id per voice, 0..clusterCount-1. */
  labels: Int32Array;
  /** Member indices per cluster. */
  clusters: number[][];
  clusterCount: number;
  singletons: number;
  largest: number;
  /** Voices that would be dropped by keeping one representative per cluster. */
  collapsed: number;
}

export function clusterAtThreshold(graph: NearDupeGraph, threshold: number): NearDupeClusters {
  const uf = new UnionFind(graph.n);
  for (let e = 0; e < graph.d.length; e++) {
    if (graph.d[e] >= threshold) break; // edges are sorted
    uf.union(graph.a[e], graph.b[e]);
  }
  const labels = new Int32Array(graph.n).fill(-1);
  const clusters: number[][] = [];
  const rootTo = new Map<number, number>();
  for (let i = 0; i < graph.n; i++) {
    const r = uf.find(i);
    let id = rootTo.get(r);
    if (id === undefined) {
      id = clusters.length;
      rootTo.set(r, id);
      clusters.push([]);
    }
    labels[i] = id;
    clusters[id].push(i);
  }
  let singletons = 0;
  let largest = 0;
  for (const c of clusters) {
    if (c.length === 1) singletons++;
    if (c.length > largest) largest = c.length;
  }
  return {
    threshold,
    labels,
    clusters,
    clusterCount: clusters.length,
    singletons,
    largest,
    collapsed: graph.n - clusters.length,
  };
}

export interface SweepRow {
  threshold: number;
  clusters: number;
  singletons: number;
  largest: number;
  collapsed: number;
  /** Counts of clusters by size bucket: 1, 2, 3-4, 5-9, 10-49, 50+. */
  sizeBuckets: number[];
}

export const SIZE_BUCKETS: Array<[number, number, string]> = [
  [1, 1, '1'],
  [2, 2, '2'],
  [3, 4, '3-4'],
  [5, 9, '5-9'],
  [10, 49, '10-49'],
  [50, Infinity, '50+'],
];

export function thresholdSweep(graph: NearDupeGraph, thresholds: number[]): SweepRow[] {
  return thresholds.map((t) => {
    const c = clusterAtThreshold(graph, t);
    const sizeBuckets = SIZE_BUCKETS.map(() => 0);
    for (const cl of c.clusters) {
      for (let b = 0; b < SIZE_BUCKETS.length; b++) {
        if (cl.length >= SIZE_BUCKETS[b][0] && cl.length <= SIZE_BUCKETS[b][1]) {
          sizeBuckets[b]++;
          break;
        }
      }
    }
    return {
      threshold: t,
      clusters: c.clusterCount,
      singletons: c.singletons,
      largest: c.largest,
      collapsed: c.collapsed,
      sizeBuckets,
    };
  });
}

/**
 * Pick the cluster member that sits closest to the cluster's centre in feature
 * space - the one that best represents what the whole cluster sounds like.
 */
export function chooseRepresentatives(
  clusters: number[][], data: Float32Array, dim: number,
): number[] {
  const centre = new Float32Array(dim);
  return clusters.map((members) => {
    if (members.length === 1) return members[0];
    centre.fill(0);
    for (const i of members) {
      const base = i * dim;
      for (let d = 0; d < dim; d++) centre[d] += data[base + d];
    }
    for (let d = 0; d < dim; d++) centre[d] /= members.length;
    let best = members[0];
    let bestD = Infinity;
    for (const i of members) {
      let sum = 0;
      const base = i * dim;
      for (let d = 0; d < dim; d++) {
        const x = data[base + d] - centre[d];
        sum += x * x;
      }
      if (sum < bestD) {
        bestD = sum;
        best = i;
      }
    }
    return best;
  });
}
