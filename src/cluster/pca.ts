/*
 * PCA by power iteration with deflation.
 *
 * Two components is all the map view needs, and on 45 dimensions that is a few
 * passes over the data rather than a full eigendecomposition. Deterministic,
 * which matters: the map should look the same every time the user opens it.
 */

export interface PcaResult {
  /** components * dim, row-major. */
  components: Float32Array;
  /** Projected coordinates, n * components. */
  projection: Float32Array;
  /** Share of total variance captured by each component. */
  explained: number[];
  mean: Float32Array;
}

export function pca(data: Float32Array, n: number, dim: number, components = 2, iterations = 80): PcaResult {
  const mean = new Float32Array(dim);
  for (let i = 0; i < n; i++) {
    const base = i * dim;
    for (let d = 0; d < dim; d++) mean[d] += data[base + d];
  }
  for (let d = 0; d < dim; d++) mean[d] /= Math.max(1, n);

  // Work on a centred copy so deflation can subtract each component out.
  const x = new Float64Array(n * dim);
  for (let i = 0; i < n; i++) {
    const base = i * dim;
    for (let d = 0; d < dim; d++) x[base + d] = data[base + d] - mean[d];
  }

  let totalVariance = 0;
  for (let i = 0; i < n * dim; i++) totalVariance += x[i] * x[i];

  const comps = new Float32Array(components * dim);
  const projection = new Float32Array(n * components);
  const explained: number[] = [];
  const v = new Float64Array(dim);
  const scores = new Float64Array(n);

  for (let c = 0; c < components; c++) {
    // Deterministic seed vector, varied per component so they do not collide.
    for (let d = 0; d < dim; d++) v[d] = Math.sin((d + 1) * (c + 1) * 0.7) + 0.1;
    let norm = Math.hypot(...v);
    for (let d = 0; d < dim; d++) v[d] /= norm;

    for (let it = 0; it < iterations; it++) {
      // w = X^T (X v), one pass, no covariance matrix.
      const w = new Float64Array(dim);
      for (let i = 0; i < n; i++) {
        const base = i * dim;
        let s = 0;
        for (let d = 0; d < dim; d++) s += x[base + d] * v[d];
        for (let d = 0; d < dim; d++) w[d] += s * x[base + d];
      }
      norm = Math.sqrt(w.reduce((a, b) => a + b * b, 0));
      if (norm < 1e-12) break;
      let delta = 0;
      for (let d = 0; d < dim; d++) {
        const nv = w[d] / norm;
        delta += Math.abs(nv - v[d]);
        v[d] = nv;
      }
      if (delta < 1e-9) break;
    }

    let variance = 0;
    for (let i = 0; i < n; i++) {
      const base = i * dim;
      let s = 0;
      for (let d = 0; d < dim; d++) s += x[base + d] * v[d];
      scores[i] = s;
      projection[i * components + c] = s;
      variance += s * s;
    }
    explained.push(totalVariance > 0 ? variance / totalVariance : 0);
    for (let d = 0; d < dim; d++) comps[c * dim + d] = v[d];

    // Deflate so the next component is orthogonal to this one.
    for (let i = 0; i < n; i++) {
      const base = i * dim;
      const s = scores[i];
      for (let d = 0; d < dim; d++) x[base + d] -= s * v[d];
    }
  }

  return { components: comps, projection, explained, mean };
}

/**
 * Top eigenvectors of a symmetric matrix, by power iteration with deflation.
 *
 * The counterpart to `pca` above for data that is sparse and wide. That one
 * multiplies through the data matrix on every iteration, which is right when
 * the data is dense and the dimension is small. Name indicators are the other
 * shape: thirty thousand rows, two hundred columns, and six non-zeros in a
 * row. Their covariance can be accumulated in one sparse pass and is then a
 * two-hundred-square matrix, so iterating on the covariance instead turns the
 * cost of the decomposition from billions of multiplications into millions.
 *
 * Returns unit eigenvectors, largest eigenvalue first.
 */
export function eigenTop(
  cov: Float64Array, dim: number, count: number, iterations = 200,
): { vectors: Float64Array; values: number[] } {
  const a = Float64Array.from(cov);
  const vectors = new Float64Array(count * dim);
  const values: number[] = [];
  const v = new Float64Array(dim);
  const w = new Float64Array(dim);

  for (let c = 0; c < count; c++) {
    for (let d = 0; d < dim; d++) v[d] = Math.sin((d + 1) * (c + 1) * 0.7) + 0.1;
    let norm = Math.hypot(...v);
    if (norm < 1e-12) break;
    for (let d = 0; d < dim; d++) v[d] /= norm;

    let value = 0;
    for (let it = 0; it < iterations; it++) {
      w.fill(0);
      for (let r = 0; r < dim; r++) {
        let s = 0;
        const base = r * dim;
        for (let k = 0; k < dim; k++) s += a[base + k] * v[k];
        w[r] = s;
      }
      norm = Math.sqrt(w.reduce((acc, x) => acc + x * x, 0));
      if (norm < 1e-12) break;
      let delta = 0;
      for (let d = 0; d < dim; d++) {
        const nv = w[d] / norm;
        delta += Math.abs(nv - v[d]);
        v[d] = nv;
      }
      value = norm;
      if (delta < 1e-10) break;
    }
    if (norm < 1e-12 || !Number.isFinite(value)) break;

    // Rayleigh quotient rather than the iteration's norm: it stays right for a
    // negative eigenvalue, which a numerically ragged covariance can produce.
    let rq = 0;
    for (let r = 0; r < dim; r++) {
      let s = 0;
      const base = r * dim;
      for (let k = 0; k < dim; k++) s += a[base + k] * v[k];
      rq += v[r] * s;
    }
    values.push(rq);
    vectors.set(v.subarray(0, dim), c * dim);

    // Deflate: A <- A - rq v v^T, so the next pass finds the next component.
    for (let r = 0; r < dim; r++) {
      const base = r * dim;
      for (let k = 0; k < dim; k++) a[base + k] -= rq * v[r] * v[k];
    }
  }
  return { vectors, values };
}
