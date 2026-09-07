/*
 * End-to-end headless run of the whole pipeline, on four factory cartridges.
 * Run with: node test/pipeline.ts
 *
 * Ratings are synthesised here, since the real ones come from a human sitting
 * in front of the rating tool. Everything either side of the rating step is the
 * production code path.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { parseSysexFile } from '../src/sysex/parse.ts';
import { clampVoice, unpackVoice, packVoice, voiceName, isInitVoice, isSilentByParams } from '../src/sysex/voice.ts';
import { buildBanks, verifyBank, BANK_NAMES } from '../src/sysex/write.ts';
import { isCarrier } from '../src/engine/fmcore.ts';
import { renderProbe } from '../src/render/probe.ts';
import { extractAcoustic } from '../src/features/acoustic.ts';
import { extractStructural } from '../src/features/structural.ts';
import { buildVector, fitStandardizer, standardize, FEATURE_COUNT } from '../src/features/vector.ts';
import { categorize, CATEGORIES, type Category } from '../src/cluster/category.ts';
import { exactDedupe } from '../src/cluster/dedupe.ts';
import { buildNearDupeGraph, clusterAtThreshold, chooseRepresentatives, thresholdSweep, SIZE_BUCKETS } from '../src/cluster/nearDupe.ts';
import { allocate, type Candidate } from '../src/alloc/allocate.ts';
import { seriate, withCategoryAxis, chooseEndpoints, splitIntoBanks, CATEGORY_ORDER } from '../src/order/seriate.ts';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, 'out');
mkdirSync(outDir, { recursive: true });

const step = (n: number, title: string) => console.log(`\n${n}. ${title}\n${'-'.repeat(60)}`);

// ---------------------------------------------------------- 1. ingest

step(1, 'ingest');
interface Voice {
  unpacked: Uint8Array;
  packed: Uint8Array;
  name: string;
  source: string;
  bank: string;
  slot: number;
}
const voices: Voice[] = [];
let clampedTotal = 0;
let checksumFailures = 0;
for (const f of ['ROM1A.syx', 'ROM1B.syx', 'ROM3A.syx', 'ROM3B.syx']) {
  const bytes = new Uint8Array(readFileSync(join(here, 'fixtures', f)));
  const report = parseSysexFile(bytes, f);
  for (const raw of report.voices) {
    if (raw.checksumOk === false) checksumFailures++;
    const unpacked = unpackVoice(raw.packed);
    const { changed } = clampVoice(unpacked);
    clampedTotal += changed;
    voices.push({
      unpacked,
      packed: packVoice(unpacked),
      name: voiceName(unpacked),
      source: raw.sourceFile,
      bank: raw.bank,
      slot: raw.slot,
    });
  }
  console.log(`  ${f}: ${report.voices.length} voices, ${report.banks} bank(s)`);
}
console.log(`  ${voices.length} voices in, ${clampedTotal} out-of-range bytes clamped, ${checksumFailures} checksum failures`);

// ------------------------------------------------------- 2. clean + dedupe

step(2, 'clean and dedupe');
const rejected = voices.filter((v) => isInitVoice(v.unpacked) || isSilentByParams(v.unpacked, isCarrier));
console.log(`  ${rejected.length} init or silent voices dropped by parameter signature`);
const kept = voices.filter((v) => !isInitVoice(v.unpacked) && !isSilentByParams(v.unpacked, isCarrier));
const exact = exactDedupe(kept.map((v) => v.packed));
const unique = exact.representatives.map((i) => kept[i]);
const aliasCount = exact.members.map((m) => m.length);
console.log(`  ${kept.length} voices -> ${unique.length} unique (name field excluded from the hash)`);
console.log(`  largest alias group: ${Math.max(...aliasCount)}`);
for (let g = 0; g < exact.members.length; g++) {
  if (exact.members[g].length < 2) continue;
  const names = exact.members[g].map((i) => `${kept[i].name.trim()} (${kept[i].source})`);
  console.log(`    same patch: ${names.join('  =  ')}`);
}

// ------------------------------------------------------------ 3. render

step(3, 'render probes and extract features');
const t0 = performance.now();
const analysed = unique.map((v) => {
  const probe = renderProbe(v.unpacked);
  const acoustic = extractAcoustic(probe);
  const structural = extractStructural(v.unpacked);
  return { v, acoustic, structural, vector: buildVector(acoustic, structural) };
});
const renderMs = performance.now() - t0;
console.log(`  ${analysed.length} voices in ${renderMs.toFixed(0)} ms (${(renderMs / analysed.length).toFixed(1)} ms each)`);
const silent = analysed.filter((a) => a.acoustic.silent).length;
console.log(`  ${silent} rendered silent and would be dropped`);

const st = fitStandardizer(analysed.map((a) => a.vector));
const flat = new Float32Array(analysed.length * FEATURE_COUNT);
const std: Float32Array[] = [];
for (let i = 0; i < analysed.length; i++) {
  const z = standardize(analysed[i].vector, st);
  std.push(z);
  flat.set(z, i * FEATURE_COUNT);
}

// -------------------------------------------------------- 4. categorise

step(4, 'categorise');
const cats: Category[] = analysed.map((a) => categorize(a.acoustic, a.structural, a.v.name).best);
const catCounts = new Map<Category, number>();
for (const c of cats) catCounts.set(c, (catCounts.get(c) ?? 0) + 1);
for (const c of CATEGORIES) console.log(`  ${c.padEnd(9)} ${String(catCounts.get(c) ?? 0).padStart(3)}`);

// ------------------------------------------------------- 5. near-dupes

step(5, 'near-duplicate clustering');
const graph = buildNearDupeGraph(flat, analysed.length, FEATURE_COUNT, unique.map((v) => v.unpacked), {
  blockSize: 60, blocksPerVoice: 2, maxDistance: 0.4,
});
console.log(`  ${graph.a.length} candidate pairs, ${graph.blocks} blocks`);
console.log('  thresh  clusters  singletons  collapsed  largest  ' + SIZE_BUCKETS.map((b) => b[2].padStart(6)).join(''));
for (const row of thresholdSweep(graph, [0.02, 0.05, 0.08, 0.12, 0.18, 0.25, 0.32])) {
  console.log(
    `  ${row.threshold.toFixed(2).padStart(6)}  ${String(row.clusters).padStart(8)}  ` +
    `${String(row.singletons).padStart(10)}  ${String(row.collapsed).padStart(9)}  ${String(row.largest).padStart(7)}  ` +
    row.sizeBuckets.map((n) => String(n).padStart(6)).join(''),
  );
}
const THRESHOLD = 0.12;
const clustered = clusterAtThreshold(graph, THRESHOLD);
const reps = chooseRepresentatives(clustered.clusters, flat, FEATURE_COUNT);
console.log(`  chose ${THRESHOLD}: ${clustered.clusterCount} clusters, ${reps.length} representatives to rate`);

// --------------------------------------------------------- 6. ratings

step(6, 'ratings (synthetic stand-in for the human)');
// Deterministic pseudo-ratings, skewed the way a real session would be: most
// things are a 2 or 3, a few are 5.
let seed = 12345;
const rnd = () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
};
const ratingOf = new Map<number, number>();
for (const r of reps) {
  const x = rnd();
  ratingOf.set(r, x < 0.25 ? 5 : x < 0.55 ? 4 : x < 0.8 ? 3 : x < 0.93 ? 2 : 1);
}
const hist = [0, 0, 0, 0, 0, 0];
for (const v of ratingOf.values()) hist[v]++;
console.log(`  ratings 1-5: ${hist.slice(1).join(' / ')}`);
const pinned = new Set<number>([reps[0], reps[1]]);
console.log(`  ${pinned.size} pinned voices that bypass rating`);

// ------------------------------------------------------- 7. allocation

step(7, 'allocation');
const TOTAL = 64;
const candidates: Candidate[] = reps.map((i, k) => ({
  id: i,
  category: cats[i],
  rating: ratingOf.get(i) ?? 0,
  pinned: pinned.has(i),
  tieBreak: clustered.clusters[k].length, // bigger near-dupe families break ties
}));
const alloc = allocate(candidates, {
  total: TOTAL,
  minRating: 4,
  floors: { keys: 6, bells: 4, plucked: 4, bass: 4, brass: 4, strings: 6, abstract: 3 },
  ceilings: { keys: 17, bells: 12, plucked: 12, bass: 10, brass: 12, strings: 17, abstract: 10 },
});
console.log('  category   avail  pin  floor  ceil  weight  alloc  filled');
for (const o of alloc.byCategory) {
  console.log(
    `  ${o.category.padEnd(9)} ${String(o.available).padStart(6)} ${String(o.pinned).padStart(4)} ` +
    `${String(o.floor).padStart(6)} ${String(o.ceiling).padStart(5)} ${o.weight.toFixed(2).padStart(7)} ` +
    `${String(o.allocated).padStart(6)} ${String(o.filled).padStart(7)}`,
  );
}
console.log(`  selected ${alloc.selected.length} of ${TOTAL}`);
for (const w of alloc.warnings) console.log(`  warning: ${w}`);

// --------------------------------------------------------- 8. ordering

step(8, 'ordering');
const selectedIds = alloc.selected.map((c) => c.id);
const selVectors = selectedIds.map((i) => std[i]);
const selCats = selectedIds.map((i) => cats[i]);
const CATEGORY_AXIS_WEIGHT = 6;
const augmented = withCategoryAxis(selVectors, selCats, CATEGORY_AXIS_WEIGHT);
const ends = chooseEndpoints(augmented, selCats);
const ser = seriate(augmented, ends);
console.log(`  path length ${ser.initialLength.toFixed(1)} -> ${ser.length.toFixed(1)} after ${ser.improvements} improvements`);
const ordered = ser.order.map((k) => selectedIds[k]);
console.log('  category run lengths along the path:');
{
  const runs: Array<[Category, number]> = [];
  for (const i of ordered) {
    const c = cats[i];
    if (runs.length && runs[runs.length - 1][0] === c) runs[runs.length - 1][1]++;
    else runs.push([c, 1]);
  }
  console.log('   ', runs.map(([c, n]) => `${c}x${n}`).join(' -> '));
  const inOrder = runs.map(([c]) => CATEGORY_ORDER.indexOf(c));
  let inversions = 0;
  for (let i = 1; i < inOrder.length; i++) if (inOrder[i] < inOrder[i - 1]) inversions++;
  console.log(`    ${runs.length} runs, ${inversions} steps backwards through the intended macro order`);
}

// ---------------------------------------------- 9. write and verify banks

step(9, 'write and verify');
// Order all 128 unique voices so there is a full four-bank set to write.
const allAug = withCategoryAxis(std, cats, CATEGORY_AXIS_WEIGHT);
const allEnds = chooseEndpoints(allAug, cats);
const allOrder = seriate(allAug, allEnds).order;
// These four cartridges only yield 123 unique voices, so the demo cycles the
// ordered list to fill 128. A real corpus supplies far more than 128.
const padded = allOrder.slice();
for (let i = 0; padded.length < 128; i++) padded.push(allOrder[i % allOrder.length]);
const final128 = padded.slice(0, 128).map((i) => unique[i].unpacked);
console.log(`  ordering ${allOrder.length} unique voices, cycled to ${final128.length} to fill four banks`);

const banks = buildBanks(final128);
let allOk = true;
for (let b = 0; b < 4; b++) {
  const expected = final128.slice(b * 32, b * 32 + 32);
  const v = verifyBank(banks[b], expected);
  allOk &&= v.ok;
  const file = join(outDir, `curated-${BANK_NAMES[b]}.syx`);
  writeFileSync(file, banks[b]);
  console.log(`  bank ${BANK_NAMES[b]}: ${banks[b].length} bytes, checksum 0x${banks[b][4102].toString(16).padStart(2, '0')}, round trip ${v.ok ? 'exact' : 'FAILED'}`);
  if (!v.ok) console.log('    ' + v.problems.slice(0, 3).join('\n    '));
}
console.log(`\n  wrote four .syx files to ${outDir}`);
console.log('\n  bank A slot names:');
for (let i = 0; i < 32; i += 8) {
  console.log('    ' + padded.slice(i, i + 8).map((k) => unique[k].name.trim().padEnd(11)).join(''));
}

console.log(allOk ? '\npipeline completed, all banks verified\n' : '\nPIPELINE FAILED VERIFICATION\n');
process.exit(allOk ? 0 : 1);
