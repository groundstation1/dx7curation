/*
 * Turning what the names say into a few numbers the rest of the app can use.
 *
 * features/nameTokens.ts produces, per voice, a set of flags: which curated
 * concepts its names mention and which common words they use. That is two
 * hundred sparse binary columns, which is the wrong shape for everything
 * downstream. The ridge would need a Gram matrix seventy thousand entries
 * wide and refit twenty-five times; Euclidean distance over binary flags is
 * dominated by whichever flags are most common; and a map axis called
 * "column 143" is not an axis anyone can read.
 *
 * So the flags are reduced to about a dozen dense components, and the
 * components are labelled by what loads on them. That is latent semantic
 * analysis, and on this vocabulary it does the obvious useful thing: the
 * first components come out as the big families - keys against basses,
 * bright metal against soft pads - because those are the words that vary
 * together across thirty thousand names.
 *
 * Three decisions worth knowing about:
 *
 * Rare words count for more. A concept on a third of the corpus separates
 * almost nothing; one on two percent separates a great deal. Weighting each
 * column by inverse document frequency is the standard fix and it matters
 * here more than usual, because the curated concepts are deliberately broad
 * and would otherwise be the only thing the components see.
 *
 * Long names do not count for more. A row is normalised before it is used, so
 * "SOFT WARM PAD" is not three times the evidence of "PAD" - it is one voice
 * saying one thing, in more words.
 *
 * The covariance is accumulated sparsely. Six flags per voice means thirty-six
 * pairs to touch, not two hundred squared, and the decomposition then runs on
 * a two-hundred-square matrix instead of the whole corpus. The difference is
 * between milliseconds and a frozen tab.
 */
import { eigenTop } from './pca.ts';
import {
  buildNameVocabulary, nameColumns, nameDimensions,
  type NameVocabulary, type VocabularyOptions,
} from '../features/nameTokens.ts';

/**
 * The name flags themselves, sparse, one row per voice.
 *
 * Kept alongside the components because the two answer different questions and
 * the components are the wrong tool for the second one.
 *
 * Components are a projection: every voice gets coordinates, including the
 * twenty-eight percent of this corpus whose names the table does not
 * recognise - TRW, FLEXATONE, WATER GDN. Those all land on the origin, which
 * in a distance makes ten thousand unrelated patches each other's nearest
 * neighbours. Exactly the banding you get from leaning on a discrete
 * coordinate.
 *
 * The flags have no such point. A voice with no recognised word has an empty
 * row and is similar to nothing, itself included, which is the truthful answer.
 * Rows are weighted by inverse document frequency and normalised, so their dot
 * product is a cosine in 0..1: two patches sharing the word WASP agree
 * strongly, two sharing PIANO barely at all.
 */
export interface NameVectors {
  /** Start of each row in `indices`/`values`, length n + 1. */
  indptr: Int32Array;
  indices: Int32Array;
  values: Float32Array;
}

/** How alike two voices' names are, 0 to 1. */
export function nameSimilarity(v: NameVectors, i: number, j: number): number {
  const ai = v.indptr[i];
  const ae = v.indptr[i + 1];
  const bi = v.indptr[j];
  const be = v.indptr[j + 1];
  if (ai === ae || bi === be) return 0;
  // Both rows are sorted by column, so this is a merge.
  let a = ai;
  let b = bi;
  let dot = 0;
  while (a < ae && b < be) {
    const ca = v.indices[a];
    const cb = v.indices[b];
    if (ca === cb) {
      dot += v.values[a] * v.values[b];
      a++;
      b++;
    } else if (ca < cb) a++;
    else b++;
  }
  return dot > 0 ? Math.min(1, dot) : 0;
}

export interface NameSpace {
  /** How many components came out. Zero when there was nothing to reduce. */
  dims: number;
  /** n * dims, row-major, each column scaled to unit variance. */
  coords: Float32Array;
  /** What each component is made of, most strongly loading first. */
  labels: string[];
  /** Share of the name variance each component carries. */
  explained: number[];
  vocabulary: NameVocabulary;
  /** The flags themselves, for similarity between two named voices. */
  vectors: NameVectors;
  /** Voices with no recognised word at all: they sit at the origin. */
  unnamed: number;
}

export interface NameSpaceOptions {
  dims?: number;
  vocabulary?: VocabularyOptions;
  /** Words per component label. */
  labelTerms?: number;
}

/**
 * Components whose share of the variance is below this are dropped.
 *
 * Whitening divides by the standard deviation, so a component carrying almost
 * nothing would be amplified into pure noise and handed to the model as if it
 * were a real axis.
 */
const MIN_EXPLAINED = 0.005;

const DEFAULT_DIMS = 12;

export function buildNameSpace(
  docs: readonly (readonly string[])[], opts: NameSpaceOptions = {},
): NameSpace | null {
  const n = docs.length;
  if (n === 0) return null;
  const vocabulary = buildNameVocabulary(docs, opts.vocabulary);
  const dim = nameDimensions(vocabulary);
  if (dim < 2) return null;

  /*
   * Column weights: rarer words say a little more, but only a little.
   *
   * The textbook weighting here is inverse document frequency, and it is the
   * wrong instinct for this job. Idf answers "which word best narrows a
   * search". The question here is "how reliably does this word mean the same
   * thing", and rarity is a poor proxy for that - in patch names a rare word
   * is often rare precisely because it is somebody's private coinage, while
   * the most reliable descriptions in the whole corpus are the commonest ones.
   * Straight idf gave `agitato`, on 0.1% of voices, a weight of 6.8 against
   * 2.7 for `piano` on 7.2%: it valued the obscure term at two and a half
   * times the established one, which is backwards.
   *
   * True one-offs are already gone - a word has to appear on a few dozen
   * voices to get a column at all - so what is left is a range of established
   * terms, and among those the spread should be gentle. The square root keeps
   * the ordering and compresses the ratio to about 1.6, which is a discount
   * for being everywhere rather than a reversal of the ranking.
   */
  const weight = new Float64Array(dim);
  for (let d = 0; d < dim; d++) {
    const df = Math.max(1, vocabulary.documentFrequency[d]);
    weight[d] = Math.sqrt(Math.log(1 + n / df));
  }

  // One sparse row per voice: the columns it lights up, and their weights
  // after the row has been normalised to unit length.
  const rowCols: number[][] = new Array(n);
  const rowVals: Float64Array[] = new Array(n);
  let unnamed = 0;
  for (let i = 0; i < n; i++) {
    const cols = nameColumns(docs[i], vocabulary);
    rowCols[i] = cols;
    if (cols.length === 0) {
      rowVals[i] = new Float64Array(0);
      unnamed++;
      continue;
    }
    const vals = new Float64Array(cols.length);
    let norm = 0;
    for (let k = 0; k < cols.length; k++) norm += weight[cols[k]] * weight[cols[k]];
    norm = Math.sqrt(norm) || 1;
    for (let k = 0; k < cols.length; k++) vals[k] = weight[cols[k]] / norm;
    rowVals[i] = vals;
  }
  if (unnamed === n) return null;

  // Mean and second moment, both from the sparse rows.
  const mean = new Float64Array(dim);
  for (let i = 0; i < n; i++) {
    const cols = rowCols[i];
    const vals = rowVals[i];
    for (let k = 0; k < cols.length; k++) mean[cols[k]] += vals[k];
  }
  for (let d = 0; d < dim; d++) mean[d] /= n;

  const cov = new Float64Array(dim * dim);
  for (let i = 0; i < n; i++) {
    const cols = rowCols[i];
    const vals = rowVals[i];
    for (let a = 0; a < cols.length; a++) {
      const base = cols[a] * dim;
      const va = vals[a];
      for (let b = 0; b < cols.length; b++) cov[base + cols[b]] += va * vals[b];
    }
  }
  let totalVariance = 0;
  for (let r = 0; r < dim; r++) {
    const base = r * dim;
    for (let c = 0; c < dim; c++) cov[base + c] = cov[base + c] / n - mean[r] * mean[c];
    totalVariance += cov[base + r];
  }
  if (!(totalVariance > 1e-12)) return null;

  const want = Math.min(opts.dims ?? DEFAULT_DIMS, dim);
  const { vectors, values } = eigenTop(cov, dim, want);
  const keep: number[] = [];
  for (let c = 0; c < values.length; c++) {
    if (values[c] / totalVariance >= MIN_EXPLAINED) keep.push(c);
  }
  if (keep.length === 0) return null;

  // Project, then scale each component to unit variance so the block arrives
  // on the same footing as the standardised audio features.
  const dims = keep.length;
  const coords = new Float32Array(n * dims);
  const scale = keep.map((c) => 1 / Math.max(Math.sqrt(Math.max(values[c], 0)), 1e-6));
  const offset = keep.map((c) => {
    let s = 0;
    for (let d = 0; d < dim; d++) s += mean[d] * vectors[c * dim + d];
    return s;
  });
  for (let i = 0; i < n; i++) {
    const cols = rowCols[i];
    const vals = rowVals[i];
    for (let k = 0; k < dims; k++) {
      const vec = keep[k] * dim;
      let s = 0;
      for (let a = 0; a < cols.length; a++) s += vals[a] * vectors[vec + cols[a]];
      coords[i * dims + k] = (s - offset[k]) * scale[k];
    }
  }

  // Flatten the sparse rows for the similarity measure.
  let total = 0;
  for (let i = 0; i < n; i++) total += rowCols[i].length;
  const indptr = new Int32Array(n + 1);
  const indices = new Int32Array(total);
  const flatValues = new Float32Array(total);
  let at = 0;
  for (let i = 0; i < n; i++) {
    indptr[i] = at;
    const cols = rowCols[i];
    const vals = rowVals[i];
    for (let k = 0; k < cols.length; k++) {
      indices[at] = cols[k];
      flatValues[at] = vals[k];
      at++;
    }
  }
  indptr[n] = at;

  return {
    dims,
    coords,
    vectors: { indptr, indices, values: flatValues },
    labels: keep.map((c) => componentLabel(vectors, c, dim, vocabulary, opts.labelTerms ?? 3)),
    explained: keep.map((c) => values[c] / totalVariance),
    vocabulary,
    unnamed,
  };
}

/**
 * Name a component after the words that load on it.
 *
 * Both ends, because a component is an axis and its negative end is as real as
 * its positive one: "bass, sub / bell, chime" is a readable axis and "bass,
 * sub" on its own is only half of one.
 */
function componentLabel(
  vectors: Float64Array, c: number, dim: number, vocabulary: NameVocabulary, terms: number,
): string {
  const order = Array.from({ length: dim }, (_, d) => d)
    .sort((a, b) => Math.abs(vectors[c * dim + b]) - Math.abs(vectors[c * dim + a]));
  const up: string[] = [];
  const down: string[] = [];
  // A category and its subcategory can share a label - "brass" is both - and
  // "brass, brass, reed" reads as a mistake rather than as emphasis.
  const taken = new Set<string>();
  for (const d of order) {
    const label = vocabulary.labels[d];
    if (taken.has(label)) continue;
    const v = vectors[c * dim + d];
    const side = v >= 0 ? up : down;
    if (side.length >= terms) continue;
    taken.add(label);
    side.push(label);
    if (up.length >= terms && down.length >= terms) break;
  }
  if (up.length === 0) return down.join(', ');
  if (down.length === 0) return up.join(', ');
  return `${up.join(', ')} / ${down.join(', ')}`;
}
