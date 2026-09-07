/*
 * Blending several voices into one.
 *
 * Used by the map's interpolation mode: point anywhere in the plot, not just at
 * a patch, and hear what a patch at that position would sound like.
 *
 * Averaging DX7 parameters is only meaningful once the algorithm is fixed.
 * Operator 3 in algorithm 5 and operator 3 in algorithm 22 are doing completely
 * different jobs - one may be a carrier and the other a modulator four levels
 * deep - so averaging their envelopes produces noise. Pick the algorithm first,
 * keep only the neighbours that share it, and every operator index then refers
 * to the same position in the same graph.
 *
 * Even then, not every parameter can be averaged. A frequency ratio is
 * perceptually categorical: halfway between 1:1 and 3:1 is not "a bit
 * detuned", it is a different interval, and 2:1 is not the sound either
 * neighbour was making. Those take a weighted vote. Continuous controls -
 * envelope rates, levels, depths - take a weighted mean.
 */
import { NAME_OFFSET, UNPACKED_SIZE, clampVoice, setVoiceName, P } from '../sysex/voice.ts';

type Blend = 'mean' | 'vote' | 'level';

/** How each of the 155 unpacked parameters combines. */
export const BLEND_RULES: Blend[] = (() => {
  const rules: Blend[] = new Array(UNPACKED_SIZE).fill('mean');
  const perOp: Blend[] = [
    'mean', 'mean', 'mean', 'mean', // EG rates
    'mean', 'mean', 'mean', 'mean', // EG levels, but see ENVELOPE_PARAMS
    'mean', // break point
    'mean', 'mean', // scaling depths
    'vote', 'vote', // scaling curves: four named shapes, not a continuum
    'mean', // rate scaling
    'mean', // amp mod sensitivity
    'mean', // key velocity sensitivity
    'mean', // output level
    'vote', // osc mode; all four of these are donated intact by a single
    'vote', // coarse frequency; contributor rather than blended, because a
    'vote', // fine frequency; mixed tuning is an out-of-tune tuning.
    'vote', // detune; see TUNING_PARAMS.
  ];
  for (let op = 0; op < 6; op++) {
    for (let k = 0; k < 21; k++) rules[op * 21 + k] = perOp[k];
  }
  rules[P.algorithm] = 'vote';
  rules[P.oscKeySync] = 'vote';
  rules[P.lfoKeySync] = 'vote';
  rules[P.lfoWaveform] = 'vote';
  return rules;
})();


/**
 * Averaging a DX7 level parameter in the engine's own scale.
 *
 * Kept because it is the honest way to average a level, but deliberately not
 * used for envelopes. The 0-99 controls are close to linear in decibels, so the
 * true midpoint of 99 and 0 is level 36, not 50 - about 48 dB down, effectively
 * silent. Averaging the raw numbers is the more forgiving of the two, and for
 * envelopes neither is really right, which is what ENVELOPE_PARAMS is about.
 */
const LEVEL_LUT = [0, 5, 9, 13, 17, 20, 23, 25, 27, 29, 31, 33, 35, 37, 39, 41, 42, 43, 45, 46];

function toEngineLevel(v: number): number {
  return v >= 20 ? 28 + v : LEVEL_LUT[Math.max(0, Math.min(19, v))];
}

function fromEngineLevel(s: number): number {
  if (s >= 47) return Math.max(0, Math.min(99, Math.round(s - 28)));
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < LEVEL_LUT.length; i++) {
    const d = Math.abs(LEVEL_LUT[i] - s);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

export function blendLevel(values: number[], weights: number[]): number {
  let sum = 0;
  let total = 0;
  for (let i = 0; i < values.length; i++) {
    sum += toEngineLevel(values[i]) * weights[i];
    total += weights[i];
  }
  return total > 0 ? fromEngineLevel(sum / total) : 0;
}


/**
 * The envelope shape: every operator's four rates and four levels.
 *
 * Averaged envelopes were the second thing wrong with the blend. An envelope is
 * a shape, not a quantity. Mixing a percussive patch that decays to nothing with
 * a pad that holds at full gives a sustain level halfway between - which in
 * decibels is a long way down, and sounds like neither: not a percussive sound,
 * not a sustaining one, just a limp one. The user notices this as "the blend
 * keeps losing its sustain", and no amount of adjusting the arithmetic fixes it,
 * because the midpoint of two incompatible shapes is not a shape anybody wants.
 *
 * So the envelope is donated whole, like the tuning, by a weighted vote. The
 * two donors are voted on separately, so a blend can take its pitch structure
 * from one neighbour and its envelope from another and genuinely be a hybrid
 * rather than the nearest patch with decoration.
 */
export const ENVELOPE_PARAMS: number[] = (() => {
  const ix: number[] = [];
  for (let op = 0; op < 6; op++) {
    for (let k = 0; k < 4; k++) ix.push(P.opRate(op, k));
    for (let k = 0; k < 4; k++) ix.push(P.opLevel(op, k));
  }
  return ix;
})();

export interface Contribution {
  /** Index of the source voice, in whatever list the caller is using. */
  index: number;
  weight: number;
}

export interface InterpolationResult {
  voice: Uint8Array;
  algorithm: number;
  contributions: Contribution[];
  /** Neighbours rejected for being on a different algorithm. */
  rejected: number;
  /** The contributor whose tuning was taken wholesale. See TUNING_PARAMS. */
  tuningDonor: number;
  /** The contributor whose envelope was taken wholesale, or null if blended. */
  envelopeDonor: number | null;
}

/**
 * Everything that decides what pitches come out, taken from one contributor
 * rather than blended.
 *
 * This was the single worst thing about the first version of the blend. Coarse
 * frequency was voted on and fine frequency was averaged - but they are two
 * halves of one number. Voting gave the coarse ratio from one patch and
 * averaging gave the fine offset from another, so the result was a ratio
 * neither of them had: reliably, slightly, miserably out of tune. Averaging
 * transpose was worse still, landing between two octaves.
 *
 * Blending a detune of 0 with a detune of 14 has the same problem from the
 * other direction: the answer, 7, is not a compromise between two chorused
 * sounds, it is the absence of the effect both of them had.
 *
 * So the whole tuning skeleton - every operator's mode, ratio and detune, the
 * pitch envelope, and the transpose - is donated intact by whichever
 * contributor wins a weighted vote. Envelopes, levels, scaling and the LFO
 * still blend smoothly. The result is a genuine mix of the things that blend
 * meaningfully, sitting on a harmonic structure that some real patch actually
 * used, and therefore in tune.
 */
export const TUNING_PARAMS: number[] = (() => {
  const ix: number[] = [];
  for (let op = 0; op < 6; op++) {
    ix.push(P.opMode(op), P.opCoarse(op), P.opFine(op), P.opDetune(op));
  }
  for (let i = 0; i < 4; i++) ix.push(P.pitchEgRate(i), P.pitchEgLevel(i));
  ix.push(P.transpose);
  return ix;
})();

function weightedVote(values: number[], weights: number[]): number {
  const tally = new Map<number, number>();
  for (let i = 0; i < values.length; i++) {
    tally.set(values[i], (tally.get(values[i]) ?? 0) + weights[i]);
  }
  let best = values[0] ?? 0;
  let bestWeight = -Infinity;
  for (const [value, weight] of tally) {
    if (weight > bestWeight) {
      bestWeight = weight;
      best = value;
    }
  }
  return best;
}

/**
 * Decide which algorithm the blend should use, by weighted vote across the
 * candidates. Returns the winner and how much of the total weight it carried,
 * which is a useful confidence signal: a 30% winner means the cursor is sitting
 * somewhere the corpus does not agree about.
 */
export function dominantAlgorithm(
  patches: Uint8Array[], weights: number[],
): { algorithm: number; share: number } {
  const tally = new Map<number, number>();
  let total = 0;
  for (let i = 0; i < patches.length; i++) {
    const alg = patches[i][P.algorithm] & 31;
    tally.set(alg, (tally.get(alg) ?? 0) + weights[i]);
    total += weights[i];
  }
  let best = 0;
  let bestWeight = -Infinity;
  for (const [alg, w] of tally) {
    if (w > bestWeight) {
      bestWeight = w;
      best = alg;
    }
  }
  return { algorithm: best, share: total > 0 ? bestWeight / total : 0 };
}

export interface InterpolateOptions {
  /** Force a particular algorithm rather than voting for one. */
  algorithm?: number;
  /** Most contributors to use once the algorithm is fixed. */
  maxContributors?: number;
  /**
   * Average the envelopes instead of taking one contributor's whole. Smoother,
   * but tends to produce shapes that sustain less than any of the inputs.
   */
  blendEnvelopes?: boolean;
  name?: string;
}

/**
 * Blend the given voices. `weights` need not be normalised; anything at or
 * below zero is ignored.
 */
export function interpolateVoices(
  patches: Uint8Array[], weights: number[], indices: number[], opts: InterpolateOptions = {},
): InterpolationResult | null {
  if (patches.length === 0) return null;

  const algorithm = opts.algorithm ?? dominantAlgorithm(patches, weights).algorithm;

  const chosen: Array<{ patch: Uint8Array; weight: number; index: number }> = [];
  let rejected = 0;
  for (let i = 0; i < patches.length; i++) {
    if (weights[i] <= 0) continue;
    if ((patches[i][P.algorithm] & 31) !== algorithm) {
      rejected++;
      continue;
    }
    chosen.push({ patch: patches[i], weight: weights[i], index: indices[i] });
  }
  if (chosen.length === 0) return null;

  chosen.sort((a, b) => b.weight - a.weight);
  const kept = chosen.slice(0, opts.maxContributors ?? chosen.length);
  const total = kept.reduce((s, c) => s + c.weight, 0);
  if (total <= 0) return null;

  const out = new Uint8Array(UNPACKED_SIZE);
  const values: number[] = [];
  const w: number[] = [];
  for (let p = 0; p < NAME_OFFSET; p++) {
    if (BLEND_RULES[p] === 'vote') {
      values.length = 0;
      w.length = 0;
      for (const c of kept) {
        values.push(c.patch[p]);
        w.push(c.weight);
      }
      out[p] = weightedVote(values, w);
    } else if (BLEND_RULES[p] === 'level') {
      values.length = 0;
      w.length = 0;
      for (const c of kept) {
        values.push(c.patch[p]);
        w.push(c.weight);
      }
      out[p] = blendLevel(values, w);
    } else {
      let sum = 0;
      for (const c of kept) sum += c.patch[p] * c.weight;
      out[p] = Math.round(sum / total);
    }
  }
  // The algorithm is not up for negotiation once it has been chosen: the vote
  // above could otherwise be overruled by the per-parameter vote.
  out[P.algorithm] = algorithm;

  // Groups that are donated whole rather than blended, each voted on separately
  // so the result can be a genuine hybrid.
  const donate = (params: number[]): { patch: Uint8Array; index: number } => {
    const tally = new Map<string, { weight: number; donor: number }>();
    for (let i = 0; i < kept.length; i++) {
      let key = '';
      for (const p of params) key += String.fromCharCode(kept[i].patch[p]);
      const seen = tally.get(key);
      if (seen) seen.weight += kept[i].weight;
      else tally.set(key, { weight: kept[i].weight, donor: i });
    }
    let at = 0;
    let best = -Infinity;
    for (const entry of tally.values()) {
      if (entry.weight > best) {
        best = entry.weight;
        at = entry.donor;
      }
    }
    for (const p of params) out[p] = kept[at].patch[p];
    return { patch: kept[at].patch, index: kept[at].index };
  };

  const donor = donate(TUNING_PARAMS);
  const envelopeDonor = opts.blendEnvelopes ? null : donate(ENVELOPE_PARAMS);

  clampVoice(out);
  setVoiceName(out, opts.name ?? 'BLEND');

  return {
    voice: out,
    algorithm,
    contributions: kept.map((c) => ({ index: c.index, weight: c.weight / total })),
    rejected,
    tuningDonor: donor.index,
    envelopeDonor: envelopeDonor ? envelopeDonor.index : null,
  };
}

/**
 * Inverse-distance weights, so the nearest neighbour dominates without the
 * others dropping out entirely. `power` 2 is the usual choice; higher makes the
 * blend snap harder to whatever is closest.
 *
 * Kept for the algorithm vote, where the nearest voices genuinely should
 * dominate. Not used for the blend itself - see blendWeights.
 */
export function inverseDistanceWeights(distances: number[], power = 2, epsilon = 1e-6): number[] {
  return distances.map((d) => 1 / (Math.pow(Math.max(d, 0), power) + epsilon));
}

/**
 * Weights for the blend, normalised by the spread of the candidates rather than
 * by absolute distance.
 *
 * Inverse-square distance is scale-dependent, and that is fatal here. Once the
 * algorithm has been fixed, the surviving neighbours are often scattered a long
 * way off - the nearest might be 20 pixels away and the rest 200 - and squared
 * distance then hands the nearest one 70% of the blend every single time. The
 * result is barely a blend at all, just the closest patch with a faint halo.
 *
 * Dividing by the furthest candidate first makes the weighting depend only on
 * how the candidates are spread relative to each other, so a tight cluster and
 * a scattered one produce the same shape of mix. `bias` then sets that shape:
 * 0 weights every contributor equally, 1 falls away sharply towards the
 * nearest.
 */
export function blendWeights(distances: number[], bias = 0.3): number[] {
  if (distances.length === 0) return [];
  const max = Math.max(...distances, 1e-9);
  const k = Math.max(0, Math.min(1, bias)) * 6;
  return distances.map((d) => Math.exp(-k * (Math.max(d, 0) / max)));
}

/** A stable cache key for a blended voice, so identical blends are not re-rendered. */
export function voiceHash(v: Uint8Array): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < NAME_OFFSET; i++) {
    h1 = Math.imul(h1 ^ v[i], 0x01000193) >>> 0;
    h2 = Math.imul(h2 + v[i] + i, 0x85ebca6b) >>> 0;
  }
  return `${h1.toString(36)}${h2.toString(36)}`;
}
