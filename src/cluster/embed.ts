/*
 * A map laid out from neighbourhoods rather than from variance.
 *
 * The complaint this answers: near-duplicates and families feel right, the
 * chart only feels "ok". That is the expected result of drawing the chart with
 * principal components. PCA preserves the directions the corpus varies in most
 * - a global property - and is indifferent to whether two patches that sound
 * alike end up near each other, which is the only thing a map of sounds is
 * for. A tight family gets smeared across the plot whenever some unrelated
 * high-variance direction runs through it, and nothing about the features or
 * the distance is wrong when that happens. The layout is wrong.
 *
 * So: force layout on the nearest-neighbour graph, in the manner of UMAP.
 * Neighbours pull, random non-neighbours push, and the result is a picture
 * where distance on screen means what you want it to mean locally.
 *
 * What that costs, and it is worth knowing before trusting the picture:
 *
 *   Distance between clusters is not meaningful. Two blobs an inch apart are
 *   not twice as different as two blobs half an inch apart. Only the
 *   neighbourhoods are faithful, which is precisely the trade being made -
 *   PCA has the opposite property, honest globally and unreliable locally.
 *
 *   Empty space is not evidence. The repulsion invents gaps; a gap between two
 *   groups does not prove nothing lies between them.
 *
 *   It is an optimisation, so it is only as repeatable as its seed. The seed
 *   is fixed and the start is the PCA projection, so the same corpus gives the
 *   same picture, and the overall orientation stays close to the axes people
 *   have already been looking at.
 */
import type { KnnGraph } from './neighbours.ts';

export interface EmbedOptions {
  /** Iterations of the optimiser. */
  epochs?: number;
  /** Starting coordinates, n * 2. The PCA projection, in practice. */
  init?: Float32Array;
  /** How tightly neighbours are allowed to bunch. */
  minDist?: number;
  /** Repulsions sampled per attraction. */
  negatives?: number;
  learningRate?: number;
  seed?: number;
  onProgress?: (epoch: number, total: number) => void;
}

const DEFAULTS = {
  epochs: 200,
  minDist: 0.1,
  negatives: 5,
  learningRate: 1,
  seed: 42,
} as const;

/**
 * Turn distances into memberships.
 *
 * A fixed distance means different things in different parts of the corpus:
 * an electric piano sits in a dense crowd where everything is close, a sound
 * effect in emptiness where its nearest neighbour is far. So each point gets
 * its own scale, chosen so that its memberships sum to a constant. That is
 * what stops the dense regions from dominating the layout entirely.
 *
 * The nearest neighbour is subtracted off first, which guarantees every point
 * is strongly attached to something and keeps isolated patches from being
 * flung to the edge.
 */
function memberships(knn: KnnGraph): Float32Array {
  const { n, k, distances } = knn;
  const target = Math.log2(k);
  const out = new Float32Array(n * k);
  for (let i = 0; i < n; i++) {
    const base = i * k;
    let rho = Infinity;
    for (let s = 0; s < k; s++) {
      const d = distances[base + s];
      if (Number.isFinite(d) && d > 0 && d < rho) rho = d;
    }
    if (!Number.isFinite(rho)) rho = 0;

    // Bisection on the scale until the memberships sum to log2(k).
    let lo = 0;
    let hi = Infinity;
    let sigma = 1;
    for (let iter = 0; iter < 64; iter++) {
      let sum = 0;
      for (let s = 0; s < k; s++) {
        const d = distances[base + s];
        if (!Number.isFinite(d)) continue;
        sum += d > rho ? Math.exp(-(d - rho) / sigma) : 1;
      }
      if (Math.abs(sum - target) < 1e-5) break;
      if (sum > target) {
        hi = sigma;
        sigma = (lo + hi) / 2;
      } else {
        lo = sigma;
        sigma = hi === Infinity ? sigma * 2 : (lo + hi) / 2;
      }
    }
    if (sigma <= 0) sigma = 1e-6;
    for (let s = 0; s < k; s++) {
      const d = distances[base + s];
      out[base + s] = !Number.isFinite(d) ? 0 : d > rho ? Math.exp(-(d - rho) / sigma) : 1;
    }
  }
  return out;
}

interface Edges { from: Int32Array; to: Int32Array; weight: Float32Array }

/**
 * One undirected edge set.
 *
 * A neighbour relation is not symmetric - a patch in a crowd is in nobody's
 * list while half the crowd is in its - and a layout needs one number per
 * pair. The union rule keeps an edge that either end believes in.
 */
function symmetrise(knn: KnnGraph, weights: Float32Array): Edges {
  const { n, k, indices } = knn;
  const seen = new Map<number, number>();
  const from: number[] = [];
  const to: number[] = [];
  const weight: number[] = [];
  for (let i = 0; i < n; i++) {
    for (let s = 0; s < k; s++) {
      const j = indices[i * k + s];
      if (j < 0 || j === i) continue;
      const a = Math.min(i, j);
      const b = Math.max(i, j);
      const key = a * n + b;
      const w = weights[i * k + s];
      const at = seen.get(key);
      if (at === undefined) {
        seen.set(key, from.length);
        from.push(a);
        to.push(b);
        weight.push(w);
      } else {
        // Either believing strongly is enough; both believing is stronger.
        const other = weight[at];
        weight[at] = other + w - other * w;
      }
    }
  }
  return { from: Int32Array.from(from), to: Int32Array.from(to), weight: Float32Array.from(weight) };
}

/** The curve UMAP fits to min-dist; these are its standard coefficients. */
function curve(minDist: number): { a: number; b: number } {
  // Fitted offline for spread 1. Interpolating two known points is plenty:
  // the parameter only decides how tightly a cluster is allowed to ball up.
  const a = 1.929 - 3.53 * minDist + 2.4 * minDist * minDist;
  const b = 0.7915 + 0.5 * minDist;
  return { a: Math.max(0.1, a), b: Math.max(0.1, b) };
}

export function embed(knn: KnnGraph, opts: EmbedOptions = {}): Float32Array {
  const n = knn.n;
  const epochs = opts.epochs ?? DEFAULTS.epochs;
  const negatives = opts.negatives ?? DEFAULTS.negatives;
  const alpha0 = opts.learningRate ?? DEFAULTS.learningRate;
  const { a, b } = curve(opts.minDist ?? DEFAULTS.minDist);
  let seed = (opts.seed ?? DEFAULTS.seed) >>> 0;
  const rnd = () => {
    seed ^= seed << 13; seed >>>= 0;
    seed ^= seed >>> 17;
    seed ^= seed << 5; seed >>>= 0;
    return seed / 4294967296;
  };

  const edges = symmetrise(knn, memberships(knn));
  const m = edges.weight.length;
  if (m === 0) return opts.init ? Float32Array.from(opts.init) : new Float32Array(n * 2);

  /*
   * Start from the principal components, scaled to a sensible size.
   *
   * A random start works and throws away two things worth keeping: the global
   * arrangement PCA does get right, and any resemblance between this map and
   * the one that was there before it.
   */
  const pos = new Float32Array(n * 2);
  if (opts.init && opts.init.length >= n * 2) {
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < n * 2; i++) {
      if (opts.init[i] < lo) lo = opts.init[i];
      if (opts.init[i] > hi) hi = opts.init[i];
    }
    const span = hi - lo || 1;
    for (let i = 0; i < n * 2; i++) pos[i] = ((opts.init[i] - lo) / span - 0.5) * 20;
  } else {
    for (let i = 0; i < n * 2; i++) pos[i] = (rnd() - 0.5) * 20;
  }

  let maxWeight = 0;
  for (let e = 0; e < m; e++) if (edges.weight[e] > maxWeight) maxWeight = edges.weight[e];

  /*
   * Edges are visited in proportion to how much they are believed.
   *
   * Rather than scaling each step by its weight - which makes weak edges
   * jitter everything constantly - a weak edge simply comes up for its turn
   * less often, and every step that does happen is full strength.
   */
  const period = new Float32Array(m);
  const nextEpoch = new Float32Array(m);
  for (let e = 0; e < m; e++) {
    const w = edges.weight[e] / maxWeight;
    period[e] = w > 0 ? 1 / w : epochs + 1;
    nextEpoch[e] = period[e];
  }

  const CLAMP = 4;
  for (let epoch = 1; epoch <= epochs; epoch++) {
    const alpha = alpha0 * (1 - (epoch - 1) / epochs);
    for (let e = 0; e < m; e++) {
      if (nextEpoch[e] > epoch) continue;
      nextEpoch[e] += period[e];

      const i = edges.from[e] * 2;
      const j = edges.to[e] * 2;
      let dx = pos[i] - pos[j];
      let dy = pos[i + 1] - pos[j + 1];
      let d2 = dx * dx + dy * dy;

      // Attraction: the gradient of the fitted curve, which falls off so that
      // things already together stop pulling and the cluster stops collapsing.
      if (d2 > 0) {
        const grad = (-2 * a * b * Math.pow(d2, b - 1)) / (a * Math.pow(d2, b) + 1);
        let gx = grad * dx;
        let gy = grad * dy;
        gx = gx > CLAMP ? CLAMP : gx < -CLAMP ? -CLAMP : gx;
        gy = gy > CLAMP ? CLAMP : gy < -CLAMP ? -CLAMP : gy;
        pos[i] += gx * alpha;
        pos[i + 1] += gy * alpha;
        pos[j] -= gx * alpha;
        pos[j + 1] -= gy * alpha;
      }

      // Repulsion from a few random points, which is what opens the space up.
      for (let s = 0; s < negatives; s++) {
        const c = Math.floor(rnd() * n);
        if (c === edges.from[e]) continue;
        const t = c * 2;
        dx = pos[i] - pos[t];
        dy = pos[i + 1] - pos[t + 1];
        d2 = dx * dx + dy * dy;
        let gx: number;
        let gy: number;
        if (d2 > 0) {
          const grad = (2 * b) / ((0.001 + d2) * (a * Math.pow(d2, b) + 1));
          gx = grad * dx;
          gy = grad * dy;
          gx = gx > CLAMP ? CLAMP : gx < -CLAMP ? -CLAMP : gx;
          gy = gy > CLAMP ? CLAMP : gy < -CLAMP ? -CLAMP : gy;
        } else {
          gx = CLAMP;
          gy = 0;
        }
        pos[i] += gx * alpha;
        pos[i + 1] += gy * alpha;
      }
    }
    opts.onProgress?.(epoch, epochs);
  }
  return pos;
}

/**
 * How much of each point's neighbourhood survived the flattening.
 *
 * The honest score for a layout like this, and the one worth quoting: of the
 * k patches nearest a voice in the full feature space, how many are still
 * among its k nearest on screen. PCA can be measured the same way, which is
 * the only fair way to claim one is better than the other.
 */
export function neighbourhoodPreserved(
  knn: KnnGraph, coords: Float32Array, sample = 500, seed = 5,
): number {
  const { n, k, indices } = knn;
  let s = seed >>> 0;
  const rnd = () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
  const pairs: Array<[number, number]> = [];
  let hit = 0;
  let total = 0;
  for (let t = 0; t < Math.min(sample, n); t++) {
    const i = Math.floor(rnd() * n);
    const truth = new Set<number>();
    for (let sIdx = 0; sIdx < k; sIdx++) {
      const j = indices[i * k + sIdx];
      if (j >= 0) truth.add(j);
    }
    if (truth.size === 0) continue;
    pairs.length = 0;
    for (let j = 0; j < n; j++) {
      if (j === i) continue;
      const dx = coords[i * 2] - coords[j * 2];
      const dy = coords[i * 2 + 1] - coords[j * 2 + 1];
      pairs.push([j, dx * dx + dy * dy]);
    }
    pairs.sort((x, y) => x[1] - y[1]);
    for (let r = 0; r < truth.size; r++) if (truth.has(pairs[r][0])) hit++;
    total += truth.size;
  }
  return total > 0 ? hit / total : 0;
}
