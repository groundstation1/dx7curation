/*
 * k-means with k-means++ seeding, over a flat Float32Array of row-major
 * vectors. Used for blocking before near-duplicate detection and for the map
 * view's diagnostic colouring.
 */

export interface KMeansResult {
  /** k * dim centroids, row-major. */
  centroids: Float32Array;
  /** Cluster index per row. */
  assignment: Int32Array;
  /** Rows per cluster. */
  counts: Int32Array;
  inertia: number;
  iterations: number;
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

function sqDist(data: Float32Array, i: number, centroids: Float32Array, c: number, dim: number): number {
  let sum = 0;
  const a = i * dim;
  const b = c * dim;
  for (let d = 0; d < dim; d++) {
    const x = data[a + d] - centroids[b + d];
    sum += x * x;
  }
  return sum;
}

export function kmeans(
  data: Float32Array, n: number, dim: number, k: number,
  { maxIterations = 40, seed = 1, tolerance = 1e-4 } = {},
): KMeansResult {
  k = Math.max(1, Math.min(k, n));
  const rng = mulberry32(seed);
  const centroids = new Float32Array(k * dim);
  const assignment = new Int32Array(n).fill(-1);
  const counts = new Int32Array(k);
  const best = new Float64Array(n);

  // ---- k-means++ seeding ----
  const first = Math.floor(rng() * n);
  centroids.set(data.subarray(first * dim, first * dim + dim), 0);
  for (let i = 0; i < n; i++) best[i] = sqDist(data, i, centroids, 0, dim);
  for (let c = 1; c < k; c++) {
    let total = 0;
    for (let i = 0; i < n; i++) total += best[i];
    let target = rng() * total;
    let pick = n - 1;
    for (let i = 0; i < n; i++) {
      target -= best[i];
      if (target <= 0) {
        pick = i;
        break;
      }
    }
    centroids.set(data.subarray(pick * dim, pick * dim + dim), c * dim);
    for (let i = 0; i < n; i++) {
      const d = sqDist(data, i, centroids, c, dim);
      if (d < best[i]) best[i] = d;
    }
  }

  // ---- Lloyd iterations ----
  const sums = new Float64Array(k * dim);
  let inertia = 0;
  let iter = 0;
  for (; iter < maxIterations; iter++) {
    let changed = 0;
    inertia = 0;
    counts.fill(0);
    sums.fill(0);
    for (let i = 0; i < n; i++) {
      let bestC = 0;
      let bestD = Infinity;
      for (let c = 0; c < k; c++) {
        const d = sqDist(data, i, centroids, c, dim);
        if (d < bestD) {
          bestD = d;
          bestC = c;
        }
      }
      if (assignment[i] !== bestC) {
        assignment[i] = bestC;
        changed++;
      }
      inertia += bestD;
      counts[bestC]++;
      const base = i * dim;
      const cbase = bestC * dim;
      for (let d = 0; d < dim; d++) sums[cbase + d] += data[base + d];
    }
    for (let c = 0; c < k; c++) {
      if (counts[c] === 0) {
        // Re-seed an empty cluster on the point furthest from its centroid.
        let worst = 0;
        let worstD = -1;
        for (let i = 0; i < n; i++) {
          const d = sqDist(data, i, centroids, assignment[i], dim);
          if (d > worstD) {
            worstD = d;
            worst = i;
          }
        }
        centroids.set(data.subarray(worst * dim, worst * dim + dim), c * dim);
        continue;
      }
      const cbase = c * dim;
      for (let d = 0; d < dim; d++) centroids[cbase + d] = sums[cbase + d] / counts[c];
    }
    if (changed / n < tolerance) {
      iter++;
      break;
    }
  }

  return { centroids, assignment, counts, inertia, iterations: iter };
}

/** Indices of the `m` nearest centroids to row `i`, nearest first. */
export function nearestCentroids(
  data: Float32Array, i: number, centroids: Float32Array, k: number, dim: number, m: number,
): number[] {
  const scored: Array<[number, number]> = [];
  for (let c = 0; c < k; c++) scored.push([sqDist(data, i, centroids, c, dim), c]);
  scored.sort((a, b) => a[0] - b[0]);
  return scored.slice(0, m).map(([, c]) => c);
}
