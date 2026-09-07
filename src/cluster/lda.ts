/*
 * Category-aligned axes, by linear discriminant analysis.
 *
 * The PCA axes show the directions the corpus varies in most, which is useful
 * but has no reason to line up with the categories: organs land wherever their
 * attack and brightness put them, spread across the plot. LDA instead finds the
 * two directions that separate the categories best - the projection where
 * things that belong together are together, even when they differ sharply in
 * some individual feature.
 *
 * Computed as whiten-then-PCA-on-the-class-means, which is LDA and needs only a
 * Cholesky factorisation and a tiny power iteration rather than a general
 * non-symmetric eigensolver.
 */

export interface LdaResult {
  /** n * components, row-major. */
  projection: Float32Array;
  /** Share of between-class scatter captured by each axis. */
  explained: number[];
  ok: boolean;
  reason?: string;
}

/** Lower-triangular Cholesky factor, or null when the matrix is not positive definite. */
function cholesky(a: Float64Array, dim: number): Float64Array | null {
  const l = new Float64Array(dim * dim);
  for (let i = 0; i < dim; i++) {
    for (let j = 0; j <= i; j++) {
      let sum = a[i * dim + j];
      for (let k = 0; k < j; k++) sum -= l[i * dim + k] * l[j * dim + k];
      if (i === j) {
        if (sum <= 1e-12) return null;
        l[i * dim + j] = Math.sqrt(sum);
      } else {
        l[i * dim + j] = sum / l[j * dim + j];
      }
    }
  }
  return l;
}

/** Solve L y = b in place for lower-triangular L. */
function forwardSolve(l: Float64Array, dim: number, b: Float64Array, out: Float64Array): void {
  for (let i = 0; i < dim; i++) {
    let sum = b[i];
    for (let k = 0; k < i; k++) sum -= l[i * dim + k] * out[k];
    out[i] = sum / l[i * dim + i];
  }
}

export function lda(
  data: Float32Array, n: number, dim: number,
  labels: Int32Array, classCount: number,
  components = 2, ridge = 0.08,
): LdaResult {
  const projection = new Float32Array(n * components);
  if (n < classCount * 2 || classCount < 2) {
    return { projection, explained: [], ok: false, reason: 'not enough labelled voices' };
  }

  // ---- class means and the global mean ----
  const counts = new Float64Array(classCount);
  const means = new Float64Array(classCount * dim);
  const global = new Float64Array(dim);
  let used = 0;
  for (let i = 0; i < n; i++) {
    const c = labels[i];
    if (c < 0 || c >= classCount) continue;
    counts[c]++;
    used++;
    const base = i * dim;
    const mbase = c * dim;
    for (let d = 0; d < dim; d++) {
      means[mbase + d] += data[base + d];
      global[d] += data[base + d];
    }
  }
  if (used < classCount * 2) {
    return { projection, explained: [], ok: false, reason: 'not enough labelled voices' };
  }
  for (let c = 0; c < classCount; c++) {
    if (counts[c] === 0) continue;
    for (let d = 0; d < dim; d++) means[c * dim + d] /= counts[c];
  }
  for (let d = 0; d < dim; d++) global[d] /= used;

  // ---- within-class scatter ----
  const sw = new Float64Array(dim * dim);
  const diff = new Float64Array(dim);
  for (let i = 0; i < n; i++) {
    const c = labels[i];
    if (c < 0 || c >= classCount || counts[c] === 0) continue;
    const base = i * dim;
    const mbase = c * dim;
    for (let d = 0; d < dim; d++) diff[d] = data[base + d] - means[mbase + d];
    for (let r = 0; r < dim; r++) {
      const dr = diff[r];
      if (dr === 0) continue;
      for (let s = 0; s <= r; s++) sw[r * dim + s] += dr * diff[s];
    }
  }
  for (let r = 0; r < dim; r++) {
    for (let s = 0; s < r; s++) sw[s * dim + r] = sw[r * dim + s];
  }
  for (let i = 0; i < dim * dim; i++) sw[i] /= used;

  // Ridge, so a feature that is constant inside every class cannot make the
  // scatter singular and blow the projection up.
  let trace = 0;
  for (let d = 0; d < dim; d++) trace += sw[d * dim + d];
  const lambda = (ridge * trace) / dim + 1e-9;

  let l: Float64Array | null = null;
  for (let attempt = 0; attempt < 6 && !l; attempt++) {
    const scaled = Float64Array.from(sw);
    const bump = lambda * Math.pow(4, attempt);
    for (let d = 0; d < dim; d++) scaled[d * dim + d] += bump;
    l = cholesky(scaled, dim);
  }
  if (!l) return { projection, explained: [], ok: false, reason: 'within-class scatter is singular' };

  // ---- whiten the class means, weighted by class size ----
  const m = new Float64Array(classCount * dim);
  const tmp = new Float64Array(dim);
  const solved = new Float64Array(dim);
  let rows = 0;
  for (let c = 0; c < classCount; c++) {
    if (counts[c] === 0) continue;
    for (let d = 0; d < dim; d++) tmp[d] = means[c * dim + d] - global[d];
    forwardSolve(l, dim, tmp, solved);
    const w = Math.sqrt(counts[c] / used);
    for (let d = 0; d < dim; d++) m[rows * dim + d] = solved[d] * w;
    rows++;
  }
  if (rows < 2) return { projection, explained: [], ok: false, reason: 'only one category present' };

  // ---- top components of the between-class scatter, by power iteration ----
  const dirs: Float64Array[] = [];
  const explained: number[] = [];
  let totalBetween = 0;
  for (let i = 0; i < rows * dim; i++) totalBetween += m[i] * m[i];

  const work = Float64Array.from(m);
  const v = new Float64Array(dim);
  for (let comp = 0; comp < components; comp++) {
    for (let d = 0; d < dim; d++) v[d] = Math.sin((d + 1) * (comp + 1) * 0.7) + 0.1;
    let norm = Math.sqrt(v.reduce((a, b) => a + b * b, 0));
    for (let d = 0; d < dim; d++) v[d] /= norm;

    for (let it = 0; it < 200; it++) {
      const next = new Float64Array(dim);
      for (let r = 0; r < rows; r++) {
        let s = 0;
        for (let d = 0; d < dim; d++) s += work[r * dim + d] * v[d];
        for (let d = 0; d < dim; d++) next[d] += s * work[r * dim + d];
      }
      norm = Math.sqrt(next.reduce((a, b) => a + b * b, 0));
      if (norm < 1e-14) break;
      let delta = 0;
      for (let d = 0; d < dim; d++) {
        const nv = next[d] / norm;
        delta += Math.abs(nv - v[d]);
        v[d] = nv;
      }
      if (delta < 1e-10) break;
    }

    let variance = 0;
    for (let r = 0; r < rows; r++) {
      let s = 0;
      for (let d = 0; d < dim; d++) s += work[r * dim + d] * v[d];
      variance += s * s;
      for (let d = 0; d < dim; d++) work[r * dim + d] -= s * v[d];
    }
    dirs.push(Float64Array.from(v));
    explained.push(totalBetween > 0 ? variance / totalBetween : 0);
  }

  // ---- project every point through the same whitening ----
  for (let i = 0; i < n; i++) {
    const base = i * dim;
    for (let d = 0; d < dim; d++) tmp[d] = data[base + d] - global[d];
    forwardSolve(l, dim, tmp, solved);
    for (let comp = 0; comp < components; comp++) {
      let s = 0;
      const dir = dirs[comp];
      for (let d = 0; d < dim; d++) s += solved[d] * dir[d];
      projection[i * components + comp] = s;
    }
  }

  return { projection, explained, ok: true };
}
