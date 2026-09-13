/*
 * The neighbourhood map. Run: node test/embed.ts
 *
 * Two things have to hold, and the second is the whole point of the file
 * existing. The neighbour search has to find roughly the right neighbours
 * without looking at every pair, and the layout built on them has to put
 * things that belong together in the same place - measurably better than the
 * principal components it is offered as an alternative to, on data where the
 * right answer is known.
 */
import { buildKnn, knnRecall } from '../src/cluster/neighbours.ts';
import { embed, neighbourhoodPreserved } from '../src/cluster/embed.ts';
import { pca } from '../src/cluster/pca.ts';

let fail = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (!ok) fail++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? '  ' + detail : ''}`);
};

let seed = 3;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const gauss = () => {
  let s = 0;
  for (let i = 0; i < 6; i++) s += rnd();
  return (s - 3) / 1.2;
};

// A corpus with known structure: distinct groups in a high-dimensional space,
// which is the shape the real one has and the only way to have an answer key.
const N = 2400;
const DIM = 48;
const GROUPS = 16;
const data = new Float32Array(N * DIM);
const label = new Int32Array(N);
const centres = Array.from({ length: GROUPS }, () => Array.from({ length: DIM }, () => gauss() * 3));
for (let i = 0; i < N; i++) {
  const g = i % GROUPS;
  label[i] = g;
  for (let d = 0; d < DIM; d++) data[i * DIM + d] = centres[g][d] + gauss();
}

console.log('finding neighbours without looking at every pair:');
const knn = buildKnn(data, N, DIM, { k: 12 });
check('every voice gets a full list',
  knn.indices.length === N * 12 && !knn.indices.includes(-1));
check('nobody is their own neighbour', (() => {
  for (let i = 0; i < N; i++) {
    for (let s = 0; s < knn.k; s++) if (knn.indices[i * knn.k + s] === i) return false;
  }
  return true;
})());
check('the lists are sorted, nearest first', (() => {
  for (let i = 0; i < N; i++) {
    for (let s = 1; s < knn.k; s++) {
      if (knn.distances[i * knn.k + s] < knn.distances[i * knn.k + s - 1]) return false;
    }
  }
  return true;
})());
const recall = knnRecall(data, N, DIM, knn, 100);
check('and they are mostly the right ones', recall > 0.85, `${(recall * 100).toFixed(1)}% agree with the exact answer`);

// Determinism: the same corpus has to give the same picture, or every reload
// rearranges a map somebody was in the middle of reading.
const again = buildKnn(data, N, DIM, { k: 12 });
check('the search is deterministic', again.indices.every((v, i) => v === knn.indices[i]));

console.log('\nlaying it out:');
const p = pca(data, N, DIM, 2);
const coords = embed(knn, { init: p.projection, epochs: 200 });
check('every voice gets a position', coords.length === N * 2);
check('and all of them are real numbers', coords.every((v) => Number.isFinite(v)));
check('the layout is deterministic too',
  embed(knn, { init: p.projection, epochs: 200 }).every((v, i) => v === coords[i]));

const purity = (xy: Float32Array) => {
  let same = 0;
  let total = 0;
  const near: Array<[number, number]> = [];
  for (let i = 0; i < N; i += 6) {
    near.length = 0;
    for (let j = 0; j < N; j++) {
      if (j === i) continue;
      const dx = xy[i * 2] - xy[j * 2];
      const dy = xy[i * 2 + 1] - xy[j * 2 + 1];
      near.push([j, dx * dx + dy * dy]);
    }
    near.sort((a, b) => a[1] - b[1]);
    for (let r = 0; r < 10; r++) {
      if (label[near[r][0]] === label[i]) same++;
      total++;
    }
  }
  return same / total;
};

const pcaPurity = purity(p.projection);
const embedPurity = purity(coords);
check('the ten nearest on screen are nearly all from the right group',
  embedPurity > 0.9, `${(embedPurity * 100).toFixed(1)}%`);
check('which is what the principal components fail at',
  embedPurity > pcaPurity + 0.1,
  `pca ${(pcaPurity * 100).toFixed(1)}% against ${(embedPurity * 100).toFixed(1)}%`);

const pcaKept = neighbourhoodPreserved(knn, p.projection, 200);
const embedKept = neighbourhoodPreserved(knn, coords, 200);
check('and it keeps more of each neighbourhood than they do',
  embedKept > pcaKept,
  `pca ${(pcaKept * 100).toFixed(1)}% against ${(embedKept * 100).toFixed(1)}%`);

// A corpus too small to have neighbourhoods must not throw.
const tiny = buildKnn(data.subarray(0, 9 * DIM), 9, DIM, { k: 12 });
check('a tiny corpus still produces something', embed(tiny, { epochs: 10 }).length === 18);

console.log(fail === 0 ? '\nall embedding checks passed' : `\n${fail} check(s) failed`);
process.exit(fail === 0 ? 0 : 1);
