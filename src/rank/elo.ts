/*
 * Pairwise ranking, for when the star scale has run out of room.
 *
 * Elo rather than a sort, because the input is not a total ordering - it is a
 * stream of individual judgements, some of which contradict each other. Asked
 * whether A beats B, then B beats C, then C beats A, a sort either crashes or
 * silently picks one. Elo just puts all three close together, which is the
 * honest answer: you cannot separate them.
 *
 * It also converges without needing every pair. Three hundred patches is
 * forty-five thousand pairs; around eight comparisons each is enough to sort
 * out who belongs at the top, which is the only part of the order that decides
 * anything.
 */

/** Where a patch starts, as Elo conventionally uses. */
export const START_SCORE = 1500;

/**
 * The spread at which one patch is a near-certain winner.
 *
 * Elo's own constant: 400 points of difference is a nine-in-ten expectation.
 * Beyond that the ordering is already decided and more comparisons cannot say
 * anything new.
 */
export const DECISIVE = 400;

export interface Standing {
  score: number;
  games: number;
}

export function newStanding(): Standing {
  return { score: START_SCORE, games: 0 };
}

/** The chance `a` beats `b`, by their current scores. */
export function expected(a: number, b: number): number {
  return 1 / (1 + Math.pow(10, (b - a) / DECISIVE));
}

/**
 * How far one result is allowed to move a patch.
 *
 * Large at first and shrinking as evidence accumulates: the first comparison
 * should carry a patch most of the way to where it belongs, and the fiftieth
 * should barely move it, or the order never settles and the last few answers
 * of a long session outweigh all the ones before them.
 */
export function kFactor(games: number): number {
  return 48 / (1 + games / 8);
}

/** Both standings after `winner` beats `loser`. Neither input is modified. */
export function applyResult(winner: Standing, loser: Standing): [Standing, Standing] {
  const e = expected(winner.score, loser.score);
  // The same surprise moves both, in opposite directions: an upset is a big
  // move for each, an expected result is a small one.
  const surprise = 1 - e;
  return [
    { score: winner.score + kFactor(winner.games) * surprise, games: winner.games + 1 },
    { score: loser.score - kFactor(loser.games) * surprise, games: loser.games + 1 },
  ];
}

/**
 * A standing, as a fraction of a star.
 *
 * Capped below half a star in both directions, which is the whole contract:
 * the ranking orders a band and can never move a patch out of it, so the star
 * the user gave always wins over the order the comparisons found. `Math.round`
 * on the result therefore always recovers the original star.
 */
export function ratingOffset(standing: Standing, cap = 0.45): number {
  if (standing.games === 0) return 0;
  const raw = ((standing.score - START_SCORE) / DECISIVE) * cap;
  return Math.max(-cap, Math.min(cap, raw));
}
