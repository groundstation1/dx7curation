/* Pairwise ranking. Run: node test/elo.ts */
import { applyResult, expected, newStanding, ratingOffset, START_SCORE, type Standing } from '../src/rank/elo.ts';

let fail = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (!ok) fail++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? '  ' + detail : ''}`);
};

console.log('pairwise ranking:');

check('equal scores are a coin toss', Math.abs(expected(1500, 1500) - 0.5) < 1e-9);
check('400 ahead is about nine in ten', Math.abs(expected(1900, 1500) - 0.909) < 0.002,
  expected(1900, 1500).toFixed(3));

// A true ordering, recovered from noisy comparisons.
const N = 24;
const truth = Array.from({ length: N }, (_, i) => i); // 0 is best
const standings: Standing[] = truth.map(() => newStanding());

// A deterministic pseudo-random source, so the test cannot flake.
let seed = 12345;
const rnd = () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
};

// Every comparison is right 85% of the time, which is generous to a human and
// harsh to the algorithm: one judgement in seven is simply wrong.
const ROUNDS = N * 12;
for (let r = 0; r < ROUNDS; r++) {
  const a = Math.floor(rnd() * N);
  let b = Math.floor(rnd() * N);
  if (a === b) b = (b + 1) % N;
  const betterWins = rnd() < 0.85;
  const aIsBetter = truth[a] < truth[b];
  const winner = (aIsBetter === betterWins) ? a : b;
  const loser = winner === a ? b : a;
  const [w, l] = applyResult(standings[winner], standings[loser]);
  standings[winner] = w;
  standings[loser] = l;
}

const order = truth.slice().sort((x, y) => standings[y].score - standings[x].score);
// Spearman-ish: how far, on average, each patch sits from where it belongs.
let drift = 0;
for (let place = 0; place < N; place++) drift += Math.abs(place - order[place]);
drift /= N;
check('the true order is broadly recovered from noisy answers', drift < 3.5,
  `mean displacement ${drift.toFixed(2)} places of ${N}`);

const best = order[0];
check('the best few end up at the top', best < 4, `true rank of the winner: ${best}`);

// The contract that makes this a sub-rating rather than a rating.
const extreme: Standing = { score: START_SCORE + 5000, games: 99 };
const awful: Standing = { score: START_SCORE - 5000, games: 99 };
check('a runaway winner still cannot reach the next star up', ratingOffset(extreme) <= 0.45,
  ratingOffset(extreme).toFixed(3));
check('a runaway loser still cannot fall out of its star', ratingOffset(awful) >= -0.45,
  ratingOffset(awful).toFixed(3));
check('rounding always recovers the star that was given',
  Math.round(5 + ratingOffset(extreme)) === 5 && Math.round(5 + ratingOffset(awful)) === 5);
check('an uncompared patch is left exactly where it was', ratingOffset(newStanding()) === 0);

// A five that lost everything must still outrank a four that won everything.
check('a losing five still beats a winning four',
  5 + ratingOffset(awful) > 4 + ratingOffset(extreme),
  `${(5 + ratingOffset(awful)).toFixed(2)} > ${(4 + ratingOffset(extreme)).toFixed(2)}`);

console.log(fail === 0 ? '\nall ranking checks passed\n' : `\n${fail} check(s) failed\n`);
process.exit(fail === 0 ? 0 : 1);
