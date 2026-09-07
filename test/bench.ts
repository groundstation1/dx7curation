/*
 * Render throughput benchmark. Run with: node test/bench.ts [voiceCount]
 *
 * The brief calls for this before the rest of the pipeline is built: render a
 * pile of voices, measure wall time, extrapolate to the whole corpus.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { availableParallelism } from 'node:os';

import { parseSysexFile } from '../src/sysex/parse.ts';
import { unpackVoice } from '../src/sysex/voice.ts';
import { renderVoice } from '../src/engine/render.ts';
import { DEFAULT_PROBE, renderProbe, type ProbeSpec } from '../src/render/probe.ts';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, 'fixtures');

const voices: Uint8Array[] = [];
for (const f of ['ROM1A.syx', 'ROM1B.syx']) {
  const bytes = new Uint8Array(readFileSync(join(fixtures, f)));
  for (const v of parseSysexFile(bytes, f).voices) voices.push(unpackVoice(v.packed));
}

const target = Number(process.argv[2] ?? 1000);
const cores = availableParallelism();

function timed<T>(fn: () => T): [T, number] {
  const t0 = performance.now();
  const r = fn();
  return [r, performance.now() - t0];
}

console.log(`corpus sample: ${voices.length} real factory voices, cycled to ${target}`);
console.log(`cores available: ${cores}\n`);

// Warm the tables and let the JIT settle.
for (let i = 0; i < 64; i++) renderVoice(voices[i % voices.length], { note: 60, velocity: 100, holdSec: 0.25, releaseSec: 0.25 });

// ------------------------------------------------- single-segment throughput

{
  const n = 200;
  const [, ms] = timed(() => {
    for (let i = 0; i < n; i++) {
      renderVoice(voices[i % voices.length], { note: 60, velocity: 100, holdSec: 1, releaseSec: 1, earlyExit: false });
    }
  });
  const audioSec = n * 2;
  console.log(`single 2.0 s segment, no early exit:`);
  console.log(`  ${(ms / n).toFixed(2)} ms per segment, ${(audioSec / (ms / 1000)).toFixed(0)}x realtime\n`);
}

// ------------------------------------------------------- full probe per voice

function benchProbe(label: string, spec: ProbeSpec, n: number): number {
  const [, ms] = timed(() => {
    for (let i = 0; i < n; i++) renderProbe(voices[i % voices.length], spec);
  });
  const perVoice = ms / n;
  const single = (target * perVoice) / 1000;
  const parallel = single / cores;
  console.log(`${label}`);
  console.log(`  ${spec.pitches.length * spec.velocities.length} segments x ${(spec.holdSec + spec.releaseSec).toFixed(1)} s`);
  console.log(`  ${perVoice.toFixed(2)} ms per voice, ${(1000 / perVoice).toFixed(0)} voices/s single-threaded`);
  console.log(`  ${target} voices: ${single.toFixed(1)} s single-threaded, ~${parallel.toFixed(1)} s across ${cores} workers`);
  for (const corpus of [10000, 30000, 45000]) {
    const s = (corpus * perVoice) / 1000 / cores;
    console.log(`  ${corpus} voices across ${cores} workers: ${s < 90 ? `${s.toFixed(0)} s` : `${(s / 60).toFixed(1)} min`}`);
  }
  console.log();
  return perVoice;
}

benchProbe('default probe (3 pitches x 2 velocities, 1.0 s + 1.0 s, early exit)', DEFAULT_PROBE, 120);
benchProbe('same, without early exit', { ...DEFAULT_PROBE, earlyExit: false }, 120);
benchProbe('lean probe (3 pitches x 2 velocities, 0.6 s + 0.6 s)', { ...DEFAULT_PROBE, holdSec: 0.6, releaseSec: 0.6 }, 200);
benchProbe('leaner still (2 pitches x 2 velocities, 0.6 s + 0.6 s)', { ...DEFAULT_PROBE, pitches: [48, 72], holdSec: 0.6, releaseSec: 0.6 }, 200);
