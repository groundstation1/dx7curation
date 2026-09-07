/*
 * Feature and category sanity check on the two factory ROM1 cartridges.
 * Run with: node test/features.ts
 *
 * These 64 voices are the only patches in the whole corpus whose intended
 * character is documented, so they are the one place the classifier can be
 * checked against something other than taste.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { parseSysexFile } from '../src/sysex/parse.ts';
import { unpackVoice, voiceName } from '../src/sysex/voice.ts';
import { renderProbe } from '../src/render/probe.ts';
import { extractAcoustic } from '../src/features/acoustic.ts';
import { extractStructural } from '../src/features/structural.ts';
import { buildVector, fitStandardizer, standardize, FEATURE_COUNT } from '../src/features/vector.ts';
import { categorize, CATEGORIES } from '../src/cluster/category.ts';
import { calibrateScales, buildNearDupeGraph, thresholdSweep, SIZE_BUCKETS } from '../src/cluster/nearDupe.ts';
import { exactDedupe } from '../src/cluster/dedupe.ts';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, 'fixtures');

interface Row {
  name: string;
  unpacked: Uint8Array;
  packed: Uint8Array;
}

const rows: Row[] = [];
for (const f of ['ROM1A.syx', 'ROM1B.syx']) {
  const bytes = new Uint8Array(readFileSync(join(fixtures, f)));
  for (const v of parseSysexFile(bytes, f).voices) {
    const unpacked = unpackVoice(v.packed);
    rows.push({ name: voiceName(unpacked), unpacked, packed: v.packed });
  }
}

const t0 = performance.now();
const analysed = rows.map((r) => {
  const probe = renderProbe(r.unpacked);
  const acoustic = extractAcoustic(probe);
  const structural = extractStructural(r.unpacked);
  return { ...r, acoustic, structural, vector: buildVector(acoustic, structural) };
});
const elapsed = performance.now() - t0;
console.log(`analysed ${analysed.length} voices in ${elapsed.toFixed(0)} ms (${(elapsed / analysed.length).toFixed(1)} ms each)\n`);

// ---------------------------------------------------------------- table

const cat = analysed.map((a) => categorize(a.acoustic, a.structural, a.name));

console.log('name        category    conf  atk(s)  sus   rel(s)  bright   reg  inharm  vel(dB)  alg fb');
console.log('-'.repeat(90));
for (let i = 0; i < analysed.length; i++) {
  const a = analysed[i].acoustic;
  const s = analysed[i].structural;
  console.log(
    `${analysed[i].name.padEnd(11)} ${cat[i].best.padEnd(9)} ${cat[i].confidence.toFixed(2).padStart(5)} ` +
    `${Math.pow(10, a.logAttackTime).toFixed(3).padStart(6)} ` +
    `${a.sustainRatio.toFixed(2).padStart(5)} ` +
    `${Math.pow(10, a.logReleaseTime).toFixed(3).padStart(6)} ` +
    `${a.centroidOct.toFixed(2).padStart(6)} ${a.registerOct.toFixed(1).padStart(5)} ` +
    `${a.inharmonicity.toFixed(3).padStart(6)} ` +
    `${a.velLevelDb.toFixed(1).padStart(7)} ` +
    `${String(s.algorithm + 1).padStart(4)} ${s.feedback}`,
  );
}

// -------------------------------------------------------- expectations

const expectations: Array<[string, string[]]> = [
  ['PIANO   1', ['keys']],
  ['E.PIANO 1', ['keys']],
  ['CLAV    1', ['keys', 'plucked']],
  ['HARPSICH 1', ['keys', 'plucked']],
  ['TUB BELLS', ['bells']],
  ['ORCH-CHIME', ['bells']],
  ['VIBE    1', ['bells']],
  ['MARIMBA', ['bells', 'plucked']],
  ['GUITAR  1', ['plucked']],
  ['KOTO', ['plucked']],
  ['BASS    1', ['bass']],
  ['BASS    2', ['bass']],
  ['BRASS   1', ['brass']],
  ['BRASS   2', ['brass']],
  ['FLUTE   1', ['brass', 'strings']],
  ['STRINGS 1', ['strings']],
  ['STRINGS 2', ['strings']],
  ['ORCHESTRA', ['strings']],
  ['E.ORGAN 1', ['organ']],
  ['PIPES   1', ['organ']],
  ['SYN-LEAD 1', ['lead']],
  ['TAKE OFF', ['abstract']],
  ['TRAIN', ['abstract']],
];

console.log('\ncategory expectations (a plausible set, not ground truth):');
let hits = 0;
let checked = 0;
for (const [name, allowed] of expectations) {
  const i = analysed.findIndex((a) => a.name === name);
  if (i < 0) continue;
  checked++;
  const got = cat[i].best;
  const ok = allowed.includes(got);
  if (ok) hits++;
  console.log(`  ${ok ? 'ok  ' : 'MISS'} ${name.padEnd(11)} got ${got.padEnd(9)} wanted ${allowed.join(' or ')}`);
}
console.log(`  ${hits}/${checked} landed in a plausible category`);

const counts = new Map<string, number>();
for (const c of cat) counts.set(c.best, (counts.get(c.best) ?? 0) + 1);
console.log('\ndistribution:', CATEGORIES.map((c) => `${c} ${counts.get(c) ?? 0}`).join(', '));

// ------------------------------------------------------------- dedupe

console.log('\nexact dedupe across the two cartridges:');
const exact = exactDedupe(analysed.map((a) => a.packed));
console.log(`  ${analysed.length} voices -> ${exact.representatives.length} unique`);

// Feed a synthetic near-duplicate in to prove the graph finds it.
const tweaked = analysed.map((a) => a.unpacked);
const nudged = Uint8Array.from(analysed[10].unpacked); // E.PIANO 1
nudged[10 * 21 + 19] = Math.min(99, nudged[10 * 21 + 19]); // no-op, keeps shape
nudged[0] = Math.max(0, nudged[0] - 1); // one step on OP6 rate 1

const withDupe = [...analysed.map((a) => a.vector)];
const probeDupe = renderProbe(nudged);
withDupe.push(buildVector(extractAcoustic(probeDupe), extractStructural(nudged)));
const unpackedAll = [...tweaked, nudged];

const st = fitStandardizer(withDupe);
const flat = new Float32Array(withDupe.length * FEATURE_COUNT);
for (let i = 0; i < withDupe.length; i++) {
  flat.set(standardize(withDupe[i], st), i * FEATURE_COUNT);
}

const scales = calibrateScales(flat, withDupe.length, FEATURE_COUNT, unpackedAll, 5000);
console.log(`  calibration: median feature distance ${scales.featureScale.toFixed(2)}, median parameter distance ${scales.paramScale.toFixed(4)}`);

const graph = buildNearDupeGraph(flat, withDupe.length, FEATURE_COUNT, unpackedAll, {
  blockSize: 40, blocksPerVoice: 2, maxDistance: 0.5,
});
console.log(`  ${graph.a.length} candidate pairs below 0.5, in ${graph.blocks} blocks`);
if (graph.a.length > 0) {
  const closest = [...Array(Math.min(5, graph.a.length)).keys()].map((e) => {
    const na = graph.a[e] < analysed.length ? analysed[graph.a[e]].name : 'E.PIANO 1 (nudged)';
    const nb = graph.b[e] < analysed.length ? analysed[graph.b[e]].name : 'E.PIANO 1 (nudged)';
    return `    ${graph.d[e].toFixed(4)}  ${na}  ~  ${nb}`;
  });
  console.log('  closest pairs:');
  console.log(closest.join('\n'));
}

console.log('\n  threshold sweep:');
console.log('    thresh  clusters  singletons  collapsed  largest  ' + SIZE_BUCKETS.map((b) => b[2].padStart(6)).join(''));
for (const row of thresholdSweep(graph, [0.02, 0.04, 0.06, 0.09, 0.12, 0.18, 0.25, 0.35])) {
  console.log(
    `    ${row.threshold.toFixed(2).padStart(6)}  ${String(row.clusters).padStart(8)}  ` +
    `${String(row.singletons).padStart(10)}  ${String(row.collapsed).padStart(9)}  ${String(row.largest).padStart(7)}  ` +
    row.sizeBuckets.map((n) => String(n).padStart(6)).join(''),
  );
}
