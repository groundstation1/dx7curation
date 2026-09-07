/*
 * Whitening the feature space before distances are measured.
 *
 * The feature vector has a lot of redundancy in it: attack time, carrier attack
 * rate and the velocity-attack delta all measure roughly the same thing, so a
 * plain Euclidean distance counts "how fast does it start" three times and
 * something with only one dimension - inharmonicity, say - once. Nobody chose
 * that weighting; it is an accident of which features happened to be easy to
 * compute.
 *
 * ZCA whitening removes it. The covariance is decorrelated and every direction
 * rescaled to unit variance, which is the same as measuring Mahalanobis rather
 * than Euclidean distance. Unlike PCA whitening it does not rotate the space
 * into unrecognisable axes, so a whitened vector still lines up roughly with the
 * features it came from.
 *
 * The catch with any whitening is that it amplifies low-variance directions,
 * which are often just noise. Both a ridge and a hard cap on the amplification
 * are applied to keep that in check - this is shrinkage whitening rather than
 * the textbook version.
 */

export interface Whitener {
  dim: number;
  mean: Float32Array;
  /** dim * dim, row-major. */
  matrix: Float32Array;
  /** Eigenvalues of the covariance, descending. Diagnostic. */
  eigenvalues: number[];
  /** How many directions hit the amplification cap. */
  cappedDirections: number;
}

/**
 * Jacobi eigenvalue iteration for a symmetric matrix.
 *
 * 51x51 is small enough that the simplest correct algorithm is also fast
 * enough, and unlike power iteration it gives every eigenpair at once, which is
 * what the inverse square root needs.
 */
function jacobiEigen(a: Float64Array, n: number, sweeps = 60): { values: Float64Array; vectors: Float64Array } {
  const m = Float64Array.from(a);
  const v = new Float64Array(n * n);
  for (let i = 0; i < n; i++) v[i * n + i] = 1;

  for (let sweep = 0; sweep < sweeps; sweep++) {
    let off = 0;
    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) off += m[p * n + q] * m[p * n + q];
    }
    if (off < 1e-18) break;

    for (let p = 0; p < n - 1; p++) {
      for (let q = p + 1; q < n; q++) {
        const apq = m[p * n + q];
        if (Math.abs(apq) < 1e-15) continue;
        const app = m[p * n + p];
        const aqq = m[q * n + q];
        const theta = (aqq - app) / (2 * apq);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;

        for (let k = 0; k < n; k++) {
          const akp = m[k * n + p];
          const akq = m[k * n + q];
          m[k * n + p] = c * akp - s * akq;
          m[k * n + q] = s * akp + c * akq;
        }
        for (let k = 0; k < n; k++) {
          const apk = m[p * n + k];
          const aqk = m[q * n + k];
          m[p * n + k] = c * apk - s * aqk;
          m[q * n + k] = s * apk + c * aqk;
        }
        for (let k = 0; k < n; k++) {
          const vkp = v[k * n + p];
          const vkq = v[k * n + q];
          v[k * n + p] = c * vkp - s * vkq;
          v[k * n + q] = s * vkp + c * vkq;
        }
      }
    }
  }

  const values = new Float64Array(n);
  for (let i = 0; i < n; i++) values[i] = m[i * n + i];
  return { values, vectors: v };
}

export interface WhitenOptions {
  /** Ridge added to the covariance, as a fraction of its mean eigenvalue. */
  ridge?: number;
  /** Largest factor any single direction may be scaled up by. */
  maxGain?: number;
}

export function fitWhitener(
  data: Float32Array, n: number, dim: number, opts: WhitenOptions = {},
): Whitener {
  const ridgeFraction = opts.ridge ?? 0.05;
  const maxGain = opts.maxGain ?? 3;

  const mean = new Float32Array(dim);
  for (let i = 0; i < n; i++) {
    const base = i * dim;
    for (let d = 0; d < dim; d++) mean[d] += data[base + d];
  }
  for (let d = 0; d < dim; d++) mean[d] /= Math.max(1, n);

  const cov = new Float64Array(dim * dim);
  const row = new Float64Array(dim);
  for (let i = 0; i < n; i++) {
    const base = i * dim;
    for (let d = 0; d < dim; d++) row[d] = data[base + d] - mean[d];
    for (let r = 0; r < dim; r++) {
      const rv = row[r];
      if (rv === 0) continue;
      for (let c = r; c < dim; c++) cov[r * dim + c] += rv * row[c];
    }
  }
  for (let r = 0; r < dim; r++) {
    for (let c = r; c < dim; c++) {
      const v = cov[r * dim + c] / Math.max(1, n);
      cov[r * dim + c] = v;
      cov[c * dim + r] = v;
    }
  }

  let trace = 0;
  for (let d = 0; d < dim; d++) trace += cov[d * dim + d];
  const ridge = (ridgeFraction * trace) / dim + 1e-9;
  for (let d = 0; d < dim; d++) cov[d * dim + d] += ridge;

  const { values, vectors } = jacobiEigen(cov, dim);

  // Scale each eigendirection by 1/sqrt(lambda), capped so a direction with
  // almost no variance cannot dominate the distance.
  const scales = new Float64Array(dim);
  let capped = 0;
  let reference = 0;
  for (let d = 0; d < dim; d++) reference += values[d];
  reference /= Math.max(1, dim);
  const unitScale = 1 / Math.sqrt(Math.max(reference, 1e-12));
  for (let d = 0; d < dim; d++) {
    const lambda = Math.max(values[d], 1e-12);
    let s = 1 / Math.sqrt(lambda);
    if (s > unitScale * maxGain) {
      s = unitScale * maxGain;
      capped++;
    }
    scales[d] = s;
  }

  // W = V diag(scales) V^T
  const matrix = new Float32Array(dim * dim);
  for (let r = 0; r < dim; r++) {
    for (let c = r; c < dim; c++) {
      let sum = 0;
      for (let k = 0; k < dim; k++) sum += vectors[r * dim + k] * scales[k] * vectors[c * dim + k];
      matrix[r * dim + c] = sum;
      matrix[c * dim + r] = sum;
    }
  }

  const eigenvalues = Array.from(values).sort((a, b) => b - a);
  return { dim, mean, matrix, eigenvalues, cappedDirections: capped };
}

/** Apply the whitener to every row, returning a new flat matrix. */
export function whitenAll(
  data: Float32Array, n: number, dim: number, w: Whitener,
  weights?: Float32Array,
): Float32Array {
  const out = new Float32Array(n * dim);
  const centred = new Float64Array(dim);
  for (let i = 0; i < n; i++) {
    const base = i * dim;
    for (let d = 0; d < dim; d++) centred[d] = data[base + d] - w.mean[d];
    for (let r = 0; r < dim; r++) {
      let sum = 0;
      for (let c = 0; c < dim; c++) sum += w.matrix[r * dim + c] * centred[c];
      out[base + r] = weights ? sum * weights[r] : sum;
    }
  }
  return out;
}

/**
 * How much redundancy the whitening actually removed.
 *
 * The ratio of the largest eigenvalue to the mean is a rough measure of how
 * lopsided the raw space was: 1.0 would mean every direction already carried
 * equal information and whitening changes nothing.
 */
export function redundancyRatio(w: Whitener): number {
  if (w.eigenvalues.length === 0) return 1;
  const mean = w.eigenvalues.reduce((a, b) => a + b, 0) / w.eigenvalues.length;
  return mean > 0 ? w.eigenvalues[0] / mean : 1;
}

/**
 * Per-feature weights that give each *concept* one vote, rather than each
 * column one vote.
 *
 * PCA is run on the standardised matrix, not the whitened one - whitening
 * equalises every direction, which would leave the principal axes arbitrary.
 * But that leaves PCA exposed to redundancy in a way that is easy to miss:
 * four highly correlated columns contribute four times the variance of one, so
 * any family of near-duplicate features can capture a whole principal axis.
 * Adding a four-point brightness contour did exactly that, taking 40% of the
 * second axis and turning it into a brightness-shape detector.
 *
 * The fix is to weight each column by the inverse root of how much company it
 * keeps: the sum of its squared correlations with every column, itself
 * included. A column correlated with three near-copies sums to about four and
 * is scaled by a half; an independent one sums to about one and is left alone.
 * No hand-maintained list of groups to keep in step with the feature set.
 */
export function redundancyWeights(data: Float32Array, n: number, dim: number): Float32Array {
  const mean = new Float64Array(dim);
  for (let i = 0; i < n; i++) {
    const base = i * dim;
    for (let d = 0; d < dim; d++) mean[d] += data[base + d];
  }
  for (let d = 0; d < dim; d++) mean[d] /= Math.max(1, n);

  const sd = new Float64Array(dim);
  for (let i = 0; i < n; i++) {
    const base = i * dim;
    for (let d = 0; d < dim; d++) {
      const x = data[base + d] - mean[d];
      sd[d] += x * x;
    }
  }
  for (let d = 0; d < dim; d++) sd[d] = Math.sqrt(sd[d] / Math.max(1, n));

  const cov = new Float64Array(dim * dim);
  const row = new Float64Array(dim);
  for (let i = 0; i < n; i++) {
    const base = i * dim;
    for (let d = 0; d < dim; d++) row[d] = data[base + d] - mean[d];
    for (let r = 0; r < dim; r++) {
      const rv = row[r];
      if (rv === 0) continue;
      for (let c = r; c < dim; c++) cov[r * dim + c] += rv * row[c];
    }
  }

  const weights = new Float32Array(dim);
  for (let r = 0; r < dim; r++) {
    let sum = 0;
    for (let c = 0; c < dim; c++) {
      const lo = Math.min(r, c);
      const hi = Math.max(r, c);
      const cv = cov[lo * dim + hi] / Math.max(1, n);
      const denom = sd[r] * sd[c];
      const corr = denom > 1e-9 ? cv / denom : 0;
      sum += corr * corr;
    }
    // Also divide out the column's own spread. The robust standardiser scales
    // by the median absolute deviation and then clips, which leaves a feature
    // with heavy tails - many voices piled on both clip bounds - with far more
    // variance than a well-behaved one. Without this, such a feature simply
    // becomes the first principal axis on its own: "decay per octave" was
    // loading 0.95 on axis 1 and the axis measured nothing else.
    weights[r] = 1 / (Math.sqrt(Math.max(1, sum)) * Math.max(sd[r], 1e-6));
  }
  return weights;
}
