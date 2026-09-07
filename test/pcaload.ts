/* What do the variation axes actually measure now? Run: node test/pcaload.ts */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseSysexFile } from '../src/sysex/parse.ts';
import { unpackVoice } from '../src/sysex/voice.ts';
import { renderProbe } from '../src/render/probe.ts';
import { extractAcoustic } from '../src/features/acoustic.ts';
import { extractStructural } from '../src/features/structural.ts';
import { buildVector, fitStandardizer, standardize, FEATURE_COUNT, FEATURE_DEFS } from '../src/features/vector.ts';
import { pca } from '../src/cluster/pca.ts';
import { redundancyWeights } from '../src/cluster/whiten.ts';

const here = dirname(fileURLToPath(import.meta.url));
const voices: Uint8Array[] = [];
for (const f of ['ROM1A.syx', 'ROM1B.syx', 'ROM3A.syx', 'ROM3B.syx']) {
  const b = new Uint8Array(readFileSync(join(here, 'fixtures', f)));
  for (const v of parseSysexFile(b, f).voices) voices.push(unpackVoice(v.packed));
}
const vectors = voices.map((u) => buildVector(extractAcoustic(renderProbe(u)), extractStructural(u)));
const st = fitStandardizer(vectors);
const n = vectors.length;
const flat = new Float32Array(n * FEATURE_COUNT);
for (let i = 0; i < n; i++) flat.set(standardize(vectors[i], st), i * FEATURE_COUNT);

const w = redundancyWeights(flat, n, FEATURE_COUNT);
const weighted = new Float32Array(n * FEATURE_COUNT);
for (let i = 0; i < n; i++) {
  for (let d = 0; d < FEATURE_COUNT; d++) weighted[i * FEATURE_COUNT + d] = flat[i * FEATURE_COUNT + d] * w[d];
}
const before = pca(flat, n, FEATURE_COUNT, 2);
const p = pca(weighted, n, FEATURE_COUNT, 2);
const shareOf = (comp: Float32Array, c: number, prefix: string) => {
  let sum = 0, total = 0;
  for (let d = 0; d < FEATURE_COUNT; d++) {
    const x = comp[c * FEATURE_COUNT + d] ** 2;
    total += x;
    if (FEATURE_DEFS[d].name.startsWith(prefix)) sum += x;
  }
  return (sum / total) * 100;
};
console.log(`unweighted: axis 2 was ${shareOf(before.components, 1, 'bright').toFixed(0)}% brightness contour`);
console.log(`weighted:   axis 2 is  ${shareOf(p.components, 1, 'bright').toFixed(0)}%
`);
console.log(`${n} voices, ${FEATURE_COUNT} features`);
console.log(`variation axis 1: ${(p.explained[0] * 100).toFixed(1)}% of variance`);
console.log(`variation axis 2: ${(p.explained[1] * 100).toFixed(1)}%`);
console.log(`both together:    ${((p.explained[0] + p.explained[1]) * 100).toFixed(1)}%\n`);

for (let c = 0; c < 2; c++) {
  const loads = Array.from({ length: FEATURE_COUNT }, (_, d) => ({
    name: FEATURE_DEFS[d].label,
    w: p.components[c * FEATURE_COUNT + d],
  })).sort((a, b) => Math.abs(b.w) - Math.abs(a.w));
  console.log(`axis ${c + 1} is mostly:`);
  for (const l of loads.slice(0, 8)) {
    console.log(`  ${l.w >= 0 ? '+' : '-'}${Math.abs(l.w).toFixed(3)}  ${l.name}`);
  }
  // How much of the axis is carried by one redundant family?
  const share = (prefix: string) => {
    let sum = 0;
    let total = 0;
    for (let d = 0; d < FEATURE_COUNT; d++) {
      const w = p.components[c * FEATURE_COUNT + d] ** 2;
      total += w;
      if (FEATURE_DEFS[d].name.startsWith(prefix)) sum += w;
    }
    return (sum / total) * 100;
  };
  console.log(`  of which brightness contour ${share('bright').toFixed(0)}%, level track ${share('loud').toFixed(0)}%, mod wheel ${share('mod').toFixed(0)}%\n`);
}
