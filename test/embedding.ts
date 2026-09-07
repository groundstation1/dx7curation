/* What whitening actually changes. Run: node test/embedding.ts */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseSysexFile } from '../src/sysex/parse.ts';
import { unpackVoice, voiceName } from '../src/sysex/voice.ts';
import { renderProbe } from '../src/render/probe.ts';
import { extractAcoustic } from '../src/features/acoustic.ts';
import { extractStructural } from '../src/features/structural.ts';
import { buildVector, fitStandardizer, standardize, FEATURE_COUNT, FEATURE_DEFS } from '../src/features/vector.ts';
import { fitWhitener, whitenAll, redundancyRatio } from '../src/cluster/whiten.ts';

const here = dirname(fileURLToPath(import.meta.url));
const voices: Array<{ name: string; u: Uint8Array }> = [];
for (const f of ['ROM1A.syx', 'ROM1B.syx', 'ROM3A.syx', 'ROM3B.syx']) {
  const b = new Uint8Array(readFileSync(join(here, 'fixtures', f)));
  for (const v of parseSysexFile(b, f).voices) {
    const u = unpackVoice(v.packed);
    voices.push({ name: voiceName(u).trim(), u });
  }
}

const vectors = voices.map((v) => buildVector(extractAcoustic(renderProbe(v.u)), extractStructural(v.u)));
const st = fitStandardizer(vectors);
const n = vectors.length;
const flat = new Float32Array(n * FEATURE_COUNT);
for (let i = 0; i < n; i++) flat.set(standardize(vectors[i], st), i * FEATURE_COUNT);

console.log(`${n} voices, ${FEATURE_COUNT} features\n`);

// How correlated is the raw space?
const corr = (a: number, b: number) => {
  let ma = 0, mb = 0;
  for (let i = 0; i < n; i++) { ma += flat[i * FEATURE_COUNT + a]; mb += flat[i * FEATURE_COUNT + b]; }
  ma /= n; mb /= n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    const x = flat[i * FEATURE_COUNT + a] - ma;
    const y = flat[i * FEATURE_COUNT + b] - mb;
    num += x * y; da += x * x; db += y * y;
  }
  return da > 0 && db > 0 ? num / Math.sqrt(da * db) : 0;
};
const pairs: Array<[number, number, number]> = [];
for (let a = 0; a < FEATURE_COUNT; a++) {
  for (let b = a + 1; b < FEATURE_COUNT; b++) pairs.push([a, b, Math.abs(corr(a, b))]);
}
pairs.sort((x, y) => y[2] - x[2]);
console.log('most redundant feature pairs in the raw space:');
for (const [a, b, r] of pairs.slice(0, 8)) {
  console.log(`  ${r.toFixed(2)}  ${FEATURE_DEFS[a].label}  <->  ${FEATURE_DEFS[b].label}`);
}
const strong = pairs.filter((p) => p[2] > 0.7).length;
console.log(`  ${strong} of ${pairs.length} pairs correlate above 0.7`);

const w = fitWhitener(flat, n, FEATURE_COUNT);
console.log(`\nwhitening:`);
console.log(`  dominant direction carried ${redundancyRatio(w).toFixed(1)}x the average variance`);
console.log(`  ${w.cappedDirections} of ${FEATURE_COUNT} near-flat directions capped instead of amplified`);

const wh = whitenAll(flat, n, FEATURE_COUNT, w);
const dist = (m: Float32Array, i: number, j: number) => {
  let s = 0;
  for (let d = 0; d < FEATURE_COUNT; d++) {
    const x = m[i * FEATURE_COUNT + d] - m[j * FEATURE_COUNT + d];
    s += x * x;
  }
  return Math.sqrt(s);
};

// Which pairs each space thinks are closest.
const near = (m: Float32Array) => {
  const out: Array<[number, number, number]> = [];
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) out.push([i, j, dist(m, i, j)]);
  out.sort((a, b) => a[2] - b[2]);
  return out.slice(0, 6);
};
console.log('\nclosest pairs, raw:');
for (const [i, j] of near(flat)) console.log(`  ${voices[i].name}  ~  ${voices[j].name}`);
console.log('closest pairs, whitened:');
for (const [i, j] of near(wh)) console.log(`  ${voices[i].name}  ~  ${voices[j].name}`);
