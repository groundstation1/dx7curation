/*
 * Does the taste model learn a taste no straight line can express?
 * Run: node test/taste.ts
 *
 * The corpus is the four factory cartridges. The "user" is synthetic and their
 * preference is deliberately non-linear: they love two unrelated corners of the
 * space and are indifferent to everything between, which is the case a single
 * ridge regression collapses to nothing on.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseSysexFile } from '../src/sysex/parse.ts';
import { unpackVoice } from '../src/sysex/voice.ts';
import { renderProbe } from '../src/render/probe.ts';
import { extractAcoustic } from '../src/features/acoustic.ts';
import { extractStructural } from '../src/features/structural.ts';
import { buildVector, fitStandardizer, standardize, FEATURE_COUNT } from '../src/features/vector.ts';
import { fitTaste } from '../src/cluster/taste.ts';
import { initEngine } from '../src/engine/tables.ts';

const here = dirname(fileURLToPath(import.meta.url));
initEngine(44100);

let fail = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (!ok) fail++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? '  ' + detail : ''}`);
};

const voices: Uint8Array[] = [];
for (const file of ['ROM1A.syx', 'ROM1B.syx', 'ROM3A.syx', 'ROM3B.syx']) {
  const bytes = new Uint8Array(readFileSync(join(here, 'fixtures', file)));
  for (const v of parseSysexFile(bytes, file).voices) voices.push(unpackVoice(v.packed));
}

const vectors = voices.map((v) => buildVector(extractAcoustic(renderProbe(v)), extractStructural(v)));
const st = fitStandardizer(vectors);
const n = voices.length;
const flat = new Float32Array(n * FEATURE_COUNT);
for (let i = 0; i < n; i++) flat.set(standardize(vectors[i], st), i * FEATURE_COUNT);

/** Two peaks in feature space, and nothing in between: unlearnable by a line. */
const centreA = 3;
const centreB = 97;
const dist = (i: number, j: number) => {
  let sum = 0;
  for (let d = 0; d < FEATURE_COUNT; d++) {
    const x = flat[i * FEATURE_COUNT + d] - flat[j * FEATURE_COUNT + d];
    sum += x * x;
  }
  return Math.sqrt(sum);
};
const truth = (i: number) => {
  const near = Math.min(dist(i, centreA), dist(i, centreB));
  return 1 + 4 * Math.exp(-(near * near) / 40);
};

const rows: number[] = [];
const ratings: number[] = [];
for (let i = 0; i < n; i++) {
  rows.push(i);
  ratings.push(Math.max(1, Math.min(5, Math.round(truth(i)))));
}

const model = fitTaste(flat, FEATURE_COUNT, { rows, ratings });
if (!model) {
  console.log('  FAIL model did not fit');
  process.exit(1);
}

console.log(`  line ${model.linearR2.toFixed(2)}  +categories ${model.categoryR2.toFixed(2)}`
  + `  neighbours ${model.neighbourR2.toFixed(2)}  as used ${model.r2.toFixed(2)}`
  + `  (${Math.round(model.neighbourWeight * 100)}% neighbours)`);

check('the neighbours beat the line on a two-peak taste',
  model.neighbourR2 > model.linearR2, `${model.neighbourR2.toFixed(2)} vs ${model.linearR2.toFixed(2)}`);
check('the model as used is at least as good as the line alone',
  model.r2 >= model.linearR2 - 1e-9, `${model.r2.toFixed(2)} vs ${model.linearR2.toFixed(2)}`);
check('cross-validation reached for the neighbours', model.neighbourWeight > 0,
  `${model.neighbourWeight}`);

// A linear taste must not be made worse by the extra machinery.
const linearTruth = (i: number) => 3 + 2 * flat[i * FEATURE_COUNT + 0];
const linRatings = rows.map((i) => Math.max(1, Math.min(5, Math.round(linearTruth(i)))));
const linModel = fitTaste(flat, FEATURE_COUNT, { rows, ratings: linRatings });
if (!linModel) {
  console.log('  FAIL linear model did not fit');
  process.exit(1);
}
console.log(`  linear taste: line ${linModel.linearR2.toFixed(2)}, as used ${linModel.r2.toFixed(2)}`);
check('a linear taste is still learned', linModel.r2 > 0.5, linModel.r2.toFixed(2));
check('and the blend does not damage it', linModel.r2 >= linModel.linearR2 - 1e-9);

// Category offsets: invent a category the ratings love, unrelated to features.
const catOf = (row: number) => (row % 7 === 0 ? 'organ' : 'keys');
const catRatings = rows.map((i) => (catOf(i) === 'organ' ? 5 : 2));
const catModel = fitTaste(flat, FEATURE_COUNT, { rows, ratings: catRatings, categoryOf: catOf });
if (!catModel) {
  console.log('  FAIL category model did not fit');
  process.exit(1);
}
const organ = catModel.categories.find((c) => c.category === 'organ');
console.log(`  category taste: line ${catModel.linearR2.toFixed(2)}, +categories ${catModel.categoryR2.toFixed(2)}`
  + `, organ offset ${organ?.offset.toFixed(2)}`);
check('the offsets find a category the features cannot explain',
  catModel.categoryR2 > catModel.linearR2, `${catModel.categoryR2.toFixed(2)} vs ${catModel.linearR2.toFixed(2)}`);
check('and the liked category gets the positive offset', (organ?.offset ?? 0) > 0.3, organ?.offset.toFixed(2));

console.log(fail === 0 ? '\nall taste checks passed' : `\n${fail} check(s) failed`);
process.exit(fail === 0 ? 0 : 1);
