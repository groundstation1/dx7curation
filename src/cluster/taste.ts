/*
 * Learning what the user's ratings have in common.
 *
 * Ridge regression from the standardised feature vector to the rating. It is
 * not trying to replace the user's ears - it is trying to answer two questions
 * they cannot answer by staring at a scatter plot: which measurable properties
 * their high ratings share, and where else in the corpus those properties turn
 * up.
 *
 * Deliberately a linear model. The coefficients are the whole point: a number
 * per feature saying "brighter is better, longer releases are worse", which can
 * be read, argued with, and turned into map axes and distance weights. A model
 * that predicted better but explained nothing would be worse for this job.
 */

export interface TasteModel {
  /** One coefficient per feature, on standardised inputs. */
  coefficients: Float32Array;
  intercept: number;
  /** Cross-validated R-squared. Below ~0.1 means it has learned nothing. */
  r2: number;
  /** Ratings the fit was built from. */
  samples: number;
  /** Mean rating, the baseline the R-squared is measured against. */
  meanRating: number;
  ridge: number;
}

/** Solve (A + lambda I) x = b for symmetric positive definite A, in place. */
function solveSymmetric(a: Float64Array, b: Float64Array, n: number): Float64Array | null {
  const m = Float64Array.from(a);
  const x = Float64Array.from(b);
  // Cholesky with forward and back substitution.
  const l = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let sum = m[i * n + j];
      for (let k = 0; k < j; k++) sum -= l[i * n + k] * l[j * n + k];
      if (i === j) {
        if (sum <= 1e-12) return null;
        l[i * n + j] = Math.sqrt(sum);
      } else {
        l[i * n + j] = sum / l[j * n + j];
      }
    }
  }
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let sum = x[i];
    for (let k = 0; k < i; k++) sum -= l[i * n + k] * y[k];
    y[i] = sum / l[i * n + i];
  }
  const out = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) {
    let sum = y[i];
    for (let k = i + 1; k < n; k++) sum -= l[k * n + i] * out[k];
    out[i] = sum / l[i * n + i];
  }
  return out;
}

interface FitResult {
  coefficients: Float64Array;
  intercept: number;
}

function fitRidge(
  rows: number[], data: Float32Array, dim: number, ratings: number[], ridge: number,
): FitResult | null {
  const n = rows.length;
  if (n < dim / 4 || n < 12) {
    // Not enough evidence for this many dimensions; the caller raises the ridge.
  }
  let meanY = 0;
  for (const r of ratings) meanY += r;
  meanY /= Math.max(1, n);

  const xtx = new Float64Array(dim * dim);
  const xty = new Float64Array(dim);
  const row = new Float64Array(dim);
  for (let i = 0; i < n; i++) {
    const base = rows[i] * dim;
    for (let d = 0; d < dim; d++) row[d] = data[base + d];
    const dy = ratings[i] - meanY;
    for (let r = 0; r < dim; r++) {
      const rv = row[r];
      xty[r] += rv * dy;
      if (rv === 0) continue;
      for (let c = r; c < dim; c++) xtx[r * dim + c] += rv * row[c];
    }
  }
  for (let r = 0; r < dim; r++) {
    for (let c = r; c < dim; c++) xtx[c * dim + r] = xtx[r * dim + c];
  }
  for (let d = 0; d < dim; d++) xtx[d * dim + d] += ridge * n;

  const beta = solveSymmetric(xtx, xty, dim);
  if (!beta) return null;
  return { coefficients: beta, intercept: meanY };
}

function predict(beta: Float64Array, intercept: number, data: Float32Array, dim: number, i: number): number {
  let sum = intercept;
  const base = i * dim;
  for (let d = 0; d < dim; d++) sum += beta[d] * data[base + d];
  return sum;
}

export interface TasteInput {
  /** Row index into `data` for each rated voice. */
  rows: number[];
  ratings: number[];
}

/**
 * Fit with five-fold cross-validation over a few ridge values, keeping the one
 * that generalises best. With a few hundred ratings and fifty features, the
 * ridge is doing most of the work of not overfitting.
 */
export function fitTaste(
  data: Float32Array, dim: number, input: TasteInput,
  ridges = [0.05, 0.2, 1, 5, 25],
): TasteModel | null {
  const n = input.rows.length;
  if (n < 12) return null;

  let meanRating = 0;
  for (const r of input.ratings) meanRating += r;
  meanRating /= n;

  let totalVar = 0;
  for (const r of input.ratings) totalVar += (r - meanRating) * (r - meanRating);
  if (totalVar <= 0) return null;

  const folds = Math.min(5, n);
  let bestRidge = ridges[0];
  let bestR2 = -Infinity;

  for (const ridge of ridges) {
    let sse = 0;
    let ok = true;
    for (let f = 0; f < folds; f++) {
      const trainRows: number[] = [];
      const trainY: number[] = [];
      const testRows: number[] = [];
      const testY: number[] = [];
      for (let i = 0; i < n; i++) {
        if (i % folds === f) {
          testRows.push(input.rows[i]);
          testY.push(input.ratings[i]);
        } else {
          trainRows.push(input.rows[i]);
          trainY.push(input.ratings[i]);
        }
      }
      if (trainRows.length < 4 || testRows.length === 0) continue;
      const fit = fitRidge(trainRows, data, dim, trainY, ridge);
      if (!fit) {
        ok = false;
        break;
      }
      for (let i = 0; i < testRows.length; i++) {
        const p = predict(fit.coefficients, fit.intercept, data, dim, testRows[i]);
        const e = testY[i] - p;
        sse += e * e;
      }
    }
    if (!ok) continue;
    const r2 = 1 - sse / totalVar;
    if (r2 > bestR2) {
      bestR2 = r2;
      bestRidge = ridge;
    }
  }

  const full = fitRidge(input.rows, data, dim, input.ratings, bestRidge);
  if (!full) return null;

  return {
    coefficients: Float32Array.from(full.coefficients),
    intercept: full.intercept,
    r2: Number.isFinite(bestR2) ? bestR2 : 0,
    samples: n,
    meanRating,
    ridge: bestRidge,
  };
}

/** Predicted rating for one row of the standardised matrix. */
export function predictRating(model: TasteModel, data: Float32Array, dim: number, i: number): number {
  let sum = model.intercept;
  const base = i * dim;
  for (let d = 0; d < dim; d++) sum += model.coefficients[d] * data[base + d];
  return sum;
}

/**
 * Per-feature distance weights derived from the model.
 *
 * A feature the ratings ignore should count for less when deciding whether two
 * patches are "similar" for the purpose of ordering the final bank - the point
 * of that ordering is that neighbouring slots feel adjacent, and what counts as
 * adjacent depends on what you are listening for. Weights are kept within a
 * bounded range so a weak model cannot collapse the space onto one axis.
 */
export function tasteWeights(model: TasteModel, dim: number, strength = 1): Float32Array {
  const w = new Float32Array(dim).fill(1);
  if (strength <= 0) return w;
  let maxAbs = 0;
  for (let d = 0; d < dim; d++) maxAbs = Math.max(maxAbs, Math.abs(model.coefficients[d]));
  if (maxAbs <= 1e-9) return w;
  // Confidence in the model scales how far the weights are allowed to move.
  const trust = Math.max(0, Math.min(1, model.r2 / 0.3)) * strength;
  for (let d = 0; d < dim; d++) {
    const rel = Math.abs(model.coefficients[d]) / maxAbs;
    w[d] = 1 - trust * 0.7 + trust * 1.4 * rel;
  }
  return w;
}

export interface TasteTerm {
  index: number;
  coefficient: number;
}

/** The features pushing ratings up and down hardest. */
export function topTerms(model: TasteModel, count = 8): { up: TasteTerm[]; down: TasteTerm[] } {
  const terms: TasteTerm[] = [];
  for (let d = 0; d < model.coefficients.length; d++) {
    terms.push({ index: d, coefficient: model.coefficients[d] });
  }
  terms.sort((a, b) => b.coefficient - a.coefficient);
  const up = terms.filter((t) => t.coefficient > 0).slice(0, count);
  const down = terms.filter((t) => t.coefficient < 0).slice(-count).reverse();
  return { up, down };
}
