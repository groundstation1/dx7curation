/*
 * Build a shipped collection from a pile of .syx files.
 *
 * Everything the app would compute on first run - the de-duplication, the
 * measurements, the near-duplicate graph, the map - done once, here, and
 * written as the same session file `Save and load` produces. Dropping it into
 * public/bundles and listing it in the manifest makes it an option on the
 * splash screen, so a new library opens ready to listen to instead of
 * spending a quarter of an hour rendering.
 *
 * Run:
 *   node tools/makeBundle.ts --name "All the web" --out public/bundles/alltheweb ./patches
 *
 * Any number of files or directories may follow the options; .syx files are
 * read recursively. Zips are not - unpack them first, which keeps this tool
 * out of the business of guessing archive layouts.
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, resolve, relative, sep } from 'node:path';
import { gzipSync } from 'node:zlib';

// Which operators are carriers depends on the algorithm, and the sysex layer
// is kept free of the engine, so the test is passed in.
import { isCarrier } from '../src/engine/fmcore.ts';
import { parseSysexFile } from '../src/sysex/parse.ts';
import { clampVoice, packedKeyOf, unpackVoice, voiceName } from '../src/sysex/voice.ts';
import { renderProbe } from '../src/render/probe.ts';
import { extractAcoustic } from '../src/features/acoustic.ts';
import { extractStructural } from '../src/features/structural.ts';
import { buildVector, fitStandardizer, standardize, FEATURE_COUNT, ANALYSIS_VERSION } from '../src/features/vector.ts';
import { categorize } from '../src/cluster/category.ts';
import { buildNearDupeGraph } from '../src/cluster/nearDupe.ts';
import { buildKnn } from '../src/cluster/neighbours.ts';
import { embed } from '../src/cluster/embed.ts';
import { pca } from '../src/cluster/pca.ts';
import { isSilentByParams } from '../src/sysex/voice.ts';

const args = process.argv.slice(2);
const optionOf = (flag: string, fallback: string): string => {
  const at = args.indexOf(flag);
  return at >= 0 && args[at + 1] ? args[at + 1] : fallback;
};
const name = optionOf('--name', 'Bundled patches');
const out = optionOf('--out', 'public/bundles/bundle');
const note = optionOf('--note', '');
const inputs = args.filter((a, i) =>
  !a.startsWith('--') && !['--name', '--out', '--note'].includes(args[i - 1] ?? ''));
if (inputs.length === 0) {
  console.error('give it at least one .syx file or directory');
  process.exit(1);
}

const syxFiles: string[] = [];
const walk = (path: string) => {
  const s = statSync(path);
  if (s.isDirectory()) {
    for (const entry of readdirSync(path)) walk(join(path, entry));
  } else if (/\.syx$/i.test(path)) {
    syxFiles.push(path);
  }
};
for (const i of inputs) walk(i);
console.log(`${syxFiles.length} .syx files`);

// ------------------------------------------------------------------ ingest

interface Voice {
  packed: Uint8Array;
  unpacked: Uint8Array;
  name: string;
  sources: Array<{ file: string; bank: string; slot: number; name: string; container: string; checksumOk: boolean | null }>;
}

const byKey = new Map<string, Voice>();
for (const path of syxFiles) {
  const bytes = new Uint8Array(readFileSync(path));
  let report;
  try {
    report = parseSysexFile(bytes, relative(process.cwd(), path).split(sep).join('/'));
  } catch {
    continue;
  }
  for (const v of report.voices) {
    const packed = v.packed;
    const { voice: unpacked } = clampVoice(unpackVoice(packed));
    const key = packedKeyOf(packed);
    const src = {
      file: v.sourceFile, bank: v.bank, slot: v.slot, name: voiceName(unpacked),
      container: v.container, checksumOk: v.checksumOk,
    };
    const seen = byKey.get(key);
    if (seen) {
      const known = new Set(seen.sources.map((s) => `${s.file}|${s.bank}|${s.slot}`));
      if (!known.has(`${src.file}|${src.bank}|${src.slot}`)) seen.sources.push(src);
    } else {
      byKey.set(key, { packed, unpacked, name: voiceName(unpacked), sources: [src] });
    }
  }
}

const voices = [...byKey.values()];
const n = voices.length;
console.log(`${n} distinct voices after collapsing exact copies`);
if (n === 0) process.exit(1);

// ---------------------------------------------------------------- measure

const vectors: Float32Array[] = [];
const acoustic: unknown[] = [];
const structural: unknown[] = [];
const categories: string[] = [];
const subcategories: string[] = [];
const confidence: number[] = [];
const silent = new Uint8Array(n);
const started = Date.now();
for (let i = 0; i < n; i++) {
  const v = voices[i];
  const a = extractAcoustic(renderProbe(v.unpacked));
  const s = extractStructural(v.unpacked);
  const cat = categorize(a, s, v.name);
  vectors.push(buildVector(a, s));
  acoustic.push(a);
  structural.push(s);
  categories.push(cat.category);
  subcategories.push(cat.sub);
  confidence.push(cat.confidence);
  silent[i] = isSilentByParams(v.unpacked, isCarrier) ? 1 : 0;
  if ((i + 1) % 1000 === 0) {
    const rate = (i + 1) / ((Date.now() - started) / 1000);
    console.log(`  measured ${i + 1}/${n}  ${rate.toFixed(0)}/s  ${(((n - i - 1) / rate) / 60).toFixed(1)} min left`);
  }
}

const std = fitStandardizer(vectors);
const flat = new Float32Array(n * FEATURE_COUNT);
for (let i = 0; i < n; i++) flat.set(standardize(vectors[i], std), i * FEATURE_COUNT);

console.log('near-duplicate graph...');
const graph = buildNearDupeGraph(flat, n, FEATURE_COUNT, voices.map((v) => v.unpacked), { maxDistance: 0.4 });
console.log(`  ${graph.d.length} candidate pairs`);

console.log('map...');
const knn = buildKnn(flat, n, FEATURE_COUNT, { k: 12 });
const coords = embed(knn, { init: pca(flat, n, FEATURE_COUNT, 2).projection, epochs: 200 });

// ------------------------------------------------------------------ write

const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64');
const f32 = (a: Float32Array) => b64(new Uint8Array(a.buffer, a.byteOffset, a.byteLength));
const i32 = (a: Int32Array) => b64(new Uint8Array(a.buffer, a.byteOffset, a.byteLength));

const session = {
  format: 'dx7curation-session',
  version: 2,
  savedAt: new Date().toISOString(),
  threshold: 0.3,
  mergeThreshold: 0.16,
  bundle: name,
  voices: voices.map((v) => ({ p: b64(v.packed), n: v.name, s: v.sources })),
  judgements: {
    format: 'dx7curation-backup',
    version: 1,
    savedAt: new Date().toISOString(),
    voiceCount: n,
    threshold: 0.3,
    mergeThreshold: 0.16,
    ratings: [], overrides: [], pinned: [], faceoff: [], ranks: [],
  },
  features: {
    analysisVersion: ANALYSIS_VERSION,
    vectors: vectors.map(f32),
    acoustic,
    structural,
    categories,
    subcategories,
    confidence,
    silent: b64(silent),
  },
  graph: {
    n: graph.n,
    a: i32(graph.a), b: i32(graph.b), d: f32(graph.d),
    featureScale: graph.featureScale, paramScale: graph.paramScale,
    featureWeight: graph.featureWeight, paramWeight: graph.paramWeight,
    blocks: graph.blocks, truncated: graph.truncated,
  },
  embedding: { n, coords: f32(coords) },
};

const file = out.endsWith('.json.gz') ? out : `${out}.json.gz`;
mkdirSync(dirname(file), { recursive: true });
const packed = gzipSync(Buffer.from(JSON.stringify(session)), { level: 9 });
writeFileSync(file, packed);
console.log(`wrote ${file}  ${(packed.length / 1e6).toFixed(1)} MB`);

/*
 * The manifest is merged rather than replaced, so building a second collection
 * does not silently remove the first.
 */
const manifestPath = join(dirname(file), 'manifest.json');
const entry = {
  name,
  file: `bundles/${file.split(/[\\/]/).pop()}`,
  voices: n,
  bytes: packed.length,
  ...(note ? { note } : {}),
};
let list: Array<{ name: string }> = [];
if (existsSync(manifestPath)) {
  try {
    const prev: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (Array.isArray(prev)) list = prev as Array<{ name: string }>;
  } catch { /* a corrupt manifest is replaced */ }
}
writeFileSync(manifestPath, JSON.stringify([...list.filter((e) => e.name !== name), entry], null, 2));
console.log(`listed in ${resolve(manifestPath)}`);
