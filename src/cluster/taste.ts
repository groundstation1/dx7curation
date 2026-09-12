/*
 * Learning what the user's ratings have in common.
 *
 * Three things, fitted together, because taste is not one shape:
 *
 *   the line       ridge regression from the standardised feature vector to the
 *                  rating. The coefficients are the point - a number per feature
 *                  saying "brighter is better, longer releases are worse" - which
 *                  can be read, argued with, and turned into map axes and
 *                  distance weights.
 *
 *   the categories a per-category offset on top of the line. "I am a sucker for
 *                  organs" is not a statement about brightness or attack time; it
 *                  is a whole family scoring above whatever the features predict,
 *                  and no amount of linear coefficients will say it.
 *
 *   the neighbours a kernel-weighted average of the ratings of nearby patches.
 *                  Someone who likes glassy electric pianos AND filthy basses has
 *                  a taste no straight line can express: the two groups pull the
 *                  line in opposite directions and it settles on nothing, which is
 *                  exactly the "no better than guessing the average" case. Local
 *                  averages have no such problem - they simply say "this corner of
 *                  the space scored well and that one did not".
 *
 * How much of each is used is decided by cross-validation, so a component that
 * does not pay for itself contributes nothing, and the R-squared reported is
 * still the honest out-of-sample one.
 */

export interface CategoryOffset {
  category: string;
  /** How far this category sits above or below what the features predict. */
  offset: number;
  /** Ratings behind it, and their plain average. */
  count: number;
  mean: number;
}

export interface NeighbourSet {
  /** Rows of the rated voices, and what they were rated. */
  rows: number[];
  ratings: number[];
  /** How many neighbours the kernel looks at. */
  k: number;
}

export interface TasteModel {
  /** One coefficient per feature, on standardised inputs. */
  coefficients: Float32Array;
  intercept: number;
  /** Cross-validated R-squared of the model as it is actually used. */
  r2: number;
  /** What each component manages on its own, for honest reporting. */
  linearR2: number;
  categoryR2: number;
  neighbourR2: number;
  /** How much of the prediction comes from neighbours rather than the line. */
  neighbourWeight: number;
  /** Per-category offsets, biggest first. */
  categories: CategoryOffset[];
  neighbours: NeighbourSet | null;
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
  /** The category of any row, for the per-category offsets. */
  categoryOf?: (row: number) => string | null;
  /**
   * An alternative space for the neighbour search, same rows and dimensions.
   *
   * Whitened, in practice: see the note at the top of `fitTaste`.
   */
  neighbourData?: Float32Array;
}

/**
 * How many ratings a category needs before its offset is taken at face value.
 *
 * A shrunken mean: the offset is the sum of the category's residuals over
 * `count + PRIOR`, so two ratings of organs move the organ offset barely at
 * all and twenty move it most of the way. Without this, any category with a
 * single lucky rating would claim a full point of preference.
 */
const CATEGORY_PRIOR = 6;

function categoryOffsets(
  rows: number[], ratings: number[], residuals: number[], categoryOf: (row: number) => string | null,
): Map<string, number> {
  const sum = new Map<string, number>();
  const count = new Map<string, number>();
  for (let i = 0; i < rows.length; i++) {
    const c = categoryOf(rows[i]);
    if (!c) continue;
    sum.set(c, (sum.get(c) ?? 0) + residuals[i]);
    count.set(c, (count.get(c) ?? 0) + 1);
  }
  const out = new Map<string, number>();
  for (const [c, total] of sum) out.set(c, total / ((count.get(c) ?? 0) + CATEGORY_PRIOR));
  return out;
}

/**
 * A kernel-weighted average of the nearest rated voices.
 *
 * The bandwidth is the distance to the k-th neighbour rather than a fixed
 * number, because the corpus is wildly uneven: a patch in the middle of the
 * electric piano mass has fifty rated voices within the radius that leaves a
 * sound effect with none. `skip` excludes a row from its own estimate, which
 * is what makes the cross-validation honest.
 */
/**
 * Kernel estimates for several neighbourhood sizes, from one scan.
 *
 * The scan is the expensive part - every rated voice against every other - and
 * it is the same scan whatever k turns out to be, so the k values are derived
 * from a single sorted shortlist rather than by repeating the work per k.
 */
function neighbourEstimates(
  data: Float32Array, dim: number, row: number,
  rows: number[], ratings: number[], ks: readonly number[], skip = -1,
): Array<number | null> {
  const k = Math.max(...ks);
  const out = neighbourScan(data, dim, row, rows, ratings, k, skip, ks);
  return out;
}

function neighbourEstimate(
  data: Float32Array, dim: number, row: number,
  rows: number[], ratings: number[], k: number, skip = -1,
): number | null {
  return neighbourScan(data, dim, row, rows, ratings, k, skip, [k])[0];
}

function neighbourScan(
  data: Float32Array, dim: number, row: number,
  rows: number[], ratings: number[], k: number, skip: number, ks: readonly number[],
): Array<number | null> {
  const none = ks.map(() => null);
  if (rows.length === 0) return none;
  const base = row * dim;
  // The k nearest are picked by insertion rather than by sorting everything:
  // this runs once per voice in the corpus, and an array of objects per call
  // would be twenty-six thousand short-lived arrays of a hundred-odd entries.
  const bestD = new Float64Array(k).fill(Infinity);
  const bestY = new Float64Array(k);
  let found = 0;
  for (let i = 0; i < rows.length; i++) {
    if (rows[i] === skip || rows[i] === row) continue;
    const other = rows[i] * dim;
    let sum = 0;
    for (let d = 0; d < dim; d++) {
      const diff = data[base + d] - data[other + d];
      sum += diff * diff;
    }
    if (sum >= bestD[k - 1]) {
      found++;
      continue;
    }
    let at = k - 1;
    while (at > 0 && bestD[at - 1] > sum) {
      bestD[at] = bestD[at - 1];
      bestY[at] = bestY[at - 1];
      at--;
    }
    bestD[at] = sum;
    bestY[at] = ratings[i];
    found++;
  }
  if (found === 0) return none;

  return ks.map((want) => {
    const use = Math.min(want, k, found);
    if (use <= 0 || !Number.isFinite(bestD[use - 1])) return null;
    // Bandwidth is the distance to the furthest of the k, not a fixed radius:
    // the corpus is wildly uneven, and a patch in the middle of the electric
    // piano mass has fifty rated voices inside a radius that leaves a sound
    // effect with none.
    const sigma = Math.max(Math.sqrt(bestD[use - 1]), 1e-6);
    let wsum = 0;
    let acc = 0;
    for (let i = 0; i < use; i++) {
      if (!Number.isFinite(bestD[i])) break;
      const t = Math.sqrt(bestD[i]) / sigma;
      const w = Math.exp(-t * t);
      wsum += w;
      acc += w * bestY[i];
    }
    return wsum > 1e-9 ? acc / wsum : null;
  });
}

/**
 * Neighbourhood sizes to choose between, and how finely to mix.
 *
 * Eight was a guess and a single guess cannot be right across the range this
 * has to work over: with forty ratings, eight neighbours is most of the
 * evidence there is, and with four thousand it is a handful of the nearest
 * near-duplicates agreeing with each other. Offering the fold a choice costs
 * one shortlist - the scan finds the largest k and the rest are read off it.
 */
const NEIGHBOUR_KS = [4, 8, 16, 32, 64] as const;
const BLENDS = [0, 0.15, 0.3, 0.45, 0.6, 0.75, 0.9, 1];

/**
 * Fit with five-fold cross-validation over a few ridge values and a few blends
 * of line against neighbours, keeping the combination that generalises best.
 * With a few hundred ratings and sixty features, the ridge and the blend are
 * doing most of the work of not overfitting.
 */
export function fitTaste(
  data: Float32Array, dim: number, input: TasteInput,
  ridges = [0.05, 0.2, 1, 5, 25],
): TasteModel | null {
  /*
   * Neighbours are found in their own space, if the caller has a better one.
   *
   * The line wants the standardised features, because its coefficients are
   * meant to be read one per feature. A nearest-neighbour search wants
   * something else entirely: Euclidean distance counts every dimension once,
   * so a property measured by four correlated features counts four times and
   * "nearby" comes to mean "agrees about brightness" whatever else is going
   * on. Whitening removes exactly that, and it is fitted from the features
   * alone, so using it here does not make the model depend on itself.
   */
  const space = input.neighbourData ?? data;
  const n = input.rows.length;
  if (n < 12) return null;
  const categoryOf = input.categoryOf ?? (() => null);

  let meanRating = 0;
  for (const r of input.ratings) meanRating += r;
  meanRating /= n;

  let totalVar = 0;
  for (const r of input.ratings) totalVar += (r - meanRating) * (r - meanRating);
  if (totalVar <= 0) return null;

  const folds = Math.min(5, n);
  const foldOf = (i: number) => i % folds;

  /** Out-of-fold predictions for one ridge: the line, and the line plus offsets. */
  const outOfFold = (ridge: number): { linear: number[]; withCats: number[] } | null => {
    const linear = new Array<number>(n).fill(meanRating);
    const withCats = new Array<number>(n).fill(meanRating);
    for (let f = 0; f < folds; f++) {
      const trainRows: number[] = [];
      const trainY: number[] = [];
      for (let i = 0; i < n; i++) {
        if (foldOf(i) === f) continue;
        trainRows.push(input.rows[i]);
        trainY.push(input.ratings[i]);
      }
      if (trainRows.length < 4) continue;
      const fit = fitRidge(trainRows, data, dim, trainY, ridge);
      if (!fit) return null;
      const residuals = trainY.map((y, i) => y - predict(fit.coefficients, fit.intercept, data, dim, trainRows[i]));
      const offsets = categoryOffsets(trainRows, trainY, residuals, categoryOf);
      for (let i = 0; i < n; i++) {
        if (foldOf(i) !== f) continue;
        const p = predict(fit.coefficients, fit.intercept, data, dim, input.rows[i]);
        linear[i] = p;
        withCats[i] = p + (offsets.get(categoryOf(input.rows[i]) ?? '') ?? 0);
      }
    }
    return { linear, withCats };
  };

  // Neighbours do not depend on the ridge, so they are computed once - for
  // every candidate k at the same time, off one shortlist per voice. Each
  // rated voice is predicted from the other folds only.
  const byK = NEIGHBOUR_KS.map(() => new Array<number>(n).fill(meanRating));
  for (let f = 0; f < folds; f++) {
    const trainRows: number[] = [];
    const trainY: number[] = [];
    for (let i = 0; i < n; i++) {
      if (foldOf(i) === f) continue;
      trainRows.push(input.rows[i]);
      trainY.push(input.ratings[i]);
    }
    for (let i = 0; i < n; i++) {
      if (foldOf(i) !== f) continue;
      const ests = neighbourEstimates(space, dim, input.rows[i], trainRows, trainY, NEIGHBOUR_KS);
      ests.forEach((est, ki) => {
        if (est !== null) byK[ki][i] = est;
      });
    }
  }

  const r2Of = (pred: number[]): number => {
    let sse = 0;
    for (let i = 0; i < n; i++) {
      const e = input.ratings[i] - pred[i];
      sse += e * e;
    }
    return 1 - sse / totalVar;
  };

  // The k that does best on its own is the one reported and the one used; the
  // blend then decides how much of it to believe.
  let bestKi = 0;
  let neighbourR2 = -Infinity;
  byK.forEach((pred, ki) => {
    const r2 = r2Of(pred);
    if (r2 > neighbourR2) {
      neighbourR2 = r2;
      bestKi = ki;
    }
  });
  const neighbourPred = byK[bestKi];
  const neighbourK = NEIGHBOUR_KS[bestKi];

  let best: { ridge: number; blend: number; r2: number; linearR2: number; categoryR2: number } | null = null;
  for (const ridge of ridges) {
    const oof = outOfFold(ridge);
    if (!oof) continue;
    const linearR2 = r2Of(oof.linear);
    const categoryR2 = r2Of(oof.withCats);
    for (const blend of BLENDS) {
      const mixed = oof.withCats.map((p, i) => (1 - blend) * p + blend * neighbourPred[i]);
      const r2 = r2Of(mixed);
      if (!best || r2 > best.r2) best = { ridge, blend, r2, linearR2, categoryR2 };
    }
  }
  if (!best) return null;

  // The final fit uses everything, with the settings the folds chose.
  const full = fitRidge(input.rows, data, dim, input.ratings, best.ridge);
  if (!full) return null;
  const residuals = input.ratings.map((y, i) => y - predict(full.coefficients, full.intercept, data, dim, input.rows[i]));
  const offsets = categoryOffsets(input.rows, input.ratings, residuals, categoryOf);

  const counts = new Map<string, { n: number; sum: number }>();
  for (let i = 0; i < n; i++) {
    const c = categoryOf(input.rows[i]);
    if (!c) continue;
    const entry = counts.get(c) ?? { n: 0, sum: 0 };
    entry.n++;
    entry.sum += input.ratings[i];
    counts.set(c, entry);
  }
  const categories: CategoryOffset[] = [...offsets].map(([category, offset]) => ({
    category,
    offset,
    count: counts.get(category)?.n ?? 0,
    mean: (counts.get(category)?.sum ?? 0) / Math.max(1, counts.get(category)?.n ?? 1),
  })).sort((a, b) => Math.abs(b.offset) - Math.abs(a.offset));

  return {
    coefficients: Float32Array.from(full.coefficients),
    intercept: full.intercept,
    r2: Number.isFinite(best.r2) ? best.r2 : 0,
    linearR2: Number.isFinite(best.linearR2) ? best.linearR2 : 0,
    categoryR2: Number.isFinite(best.categoryR2) ? best.categoryR2 : 0,
    neighbourR2: Number.isFinite(neighbourR2) ? neighbourR2 : 0,
    neighbourWeight: best.blend,
    categories,
    neighbours: best.blend > 0 ? { rows: [...input.rows], ratings: [...input.ratings], k: neighbourK } : null,
    samples: n,
    meanRating,
    ridge: best.ridge,
  };
}

/**
 * Predicted rating for one row of the standardised matrix.
 *
 * `category` is optional: without it the per-category offsets are skipped,
 * which is the right answer for a voice whose category is unknown.
 */
export function predictRating(
  model: TasteModel, data: Float32Array, dim: number, i: number, category?: string | null,
): number {
  let sum = model.intercept;
  const base = i * dim;
  for (let d = 0; d < dim; d++) sum += model.coefficients[d] * data[base + d];
  if (category) {
    const found = model.categories.find((c) => c.category === category);
    if (found) sum += found.offset;
  }
  if (model.neighbourWeight > 0 && model.neighbours) {
    const est = neighbourEstimate(
      data, dim, i, model.neighbours.rows, model.neighbours.ratings, model.neighbours.k, i,
    );
    if (est !== null) sum = (1 - model.neighbourWeight) * sum + model.neighbourWeight * est;
  }
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
