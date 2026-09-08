/*
 * Release time, and whether extrapolating it is honest. Run: node test/release.ts
 *
 * A probe that stops before the tail does used to report the probe's own length
 * as the release time, so every slow patch came out identical and the number
 * moved when the probe changed rather than when the patch did. The tail is now
 * longer and, where it still outlasts the probe, the decay rate is fitted and
 * extrapolated to 60 dB down.
 *
 * The test that matters is whether that estimate agrees with simply rendering
 * for longer: a one-second probe's extrapolation against an eight-second
 * probe's measurement, on the voices where the difference exists.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { initEngine } from '../src/engine/tables.ts';
import { parseSysexFile } from '../src/sysex/parse.ts';
import { unpackVoice, voiceName } from '../src/sysex/voice.ts';
import { renderProbe, DEFAULT_PROBE } from '../src/render/probe.ts';
import { extractAcoustic } from '../src/features/acoustic.ts';

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

const at = (tail: number) => voices.map((v) => extractAcoustic(renderProbe(v, { ...DEFAULT_PROBE, releaseSec: tail })));
const short = at(1);
const long = at(8);
const std = at(DEFAULT_PROBE.releaseSec);

// Voices whose tail outlasts a one-second probe: the ones being estimated.
const diffs: number[] = [];
for (let i = 0; i < voices.length; i++) {
  if (!short[i].releaseCensored) continue;
  diffs.push(Math.abs(short[i].logReleaseTime - long[i].logReleaseTime));
}
diffs.sort((a, b) => a - b);
const median = diffs[Math.floor(diffs.length / 2)];
const p90 = diffs[Math.floor(diffs.length * 0.9)];

console.log(`${diffs.length} of ${voices.length} voices outlast a one-second probe`);
console.log(`  extrapolated vs measured over 8 s: median ${Math.pow(10, median).toFixed(2)}x, p90 ${Math.pow(10, p90).toFixed(2)}x`);

check('extrapolation lands within 25% of a long probe, typically',
  median < 0.1, `${Math.pow(10, median).toFixed(2)}x`);
check('and within a factor of two for nine in ten',
  p90 < 0.31, `${Math.pow(10, p90).toFixed(2)}x`);

const censoredShort = short.filter((a) => a.releaseCensored).length;
const censoredStd = std.filter((a) => a.releaseCensored).length;
console.log(`  censored: ${censoredShort} at 1 s, ${censoredStd} at the default ${DEFAULT_PROBE.releaseSec} s`);
check('the default probe measures most tails outright', censoredStd < voices.length * 0.15,
  `${censoredStd} of ${voices.length}`);

// The point of all this: long tails must be distinguishable from each other.
const longest = voices
  .map((v, i) => ({ name: voiceName(v).trim(), t: Math.pow(10, std[i].logReleaseTime) }))
  .sort((a, b) => b.t - a.t)
  .slice(0, 5);
console.log(`  longest: ${longest.map((l) => `${l.name} ${l.t.toFixed(1)}s`).join(', ')}`);
check('the longest tails are not all the same number',
  new Set(longest.map((l) => l.t.toFixed(2))).size > 1);

console.log(fail === 0 ? '\nall release checks passed' : `\n${fail} check(s) failed`);
process.exit(fail === 0 ? 0 : 1);
