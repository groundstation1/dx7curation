/* Sanity check on the polyphonic phrase renderer. Run: node test/phrase.ts */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseSysexFile } from '../src/sysex/parse.ts';
import { unpackVoice, voiceName } from '../src/sysex/voice.ts';
import { DEMO_PHRASE, renderPhrase, singleNotePhrase } from '../src/engine/phrase.ts';
import { encodeWav } from '../src/engine/render.ts';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, 'out');
mkdirSync(out, { recursive: true });

const bytes = new Uint8Array(readFileSync(join(here, 'fixtures', 'ROM1A.syx')));
const voices = parseSysexFile(bytes, 'ROM1A.syx').voices.map((v) => unpackVoice(v.packed));

const rms = (s: Float32Array, a: number, b: number) => {
  let sum = 0;
  const lo = Math.max(0, Math.floor(a));
  const hi = Math.min(s.length, Math.floor(b));
  for (let i = lo; i < hi; i++) sum += s[i] * s[i];
  return Math.sqrt(sum / Math.max(1, hi - lo));
};

let fail = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (!ok) fail++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? '  ' + detail : ''}`);
};

const sr = 44100;
console.log('demo phrase across the ROM1A cartridge:');
let slowest = 0;
for (const v of voices) {
  const t0 = performance.now();
  const r = renderPhrase(v, DEMO_PHRASE, { sampleRate: sr });
  slowest = Math.max(slowest, performance.now() - t0);
  let bad = 0;
  for (let i = 0; i < r.samples.length; i++) if (!Number.isFinite(r.samples[i])) bad++;
  if (bad) { console.log(`  FAIL ${voiceName(v)} has ${bad} non-finite samples`); fail++; }
  if (r.peak < 1e-4) { console.log(`  FAIL ${voiceName(v)} rendered silent (peak ${r.peak})`); fail++; }
}
check('every voice renders finite audio with signal', fail === 0);
console.log(`  slowest voice: ${slowest.toFixed(1)} ms for ${DEMO_PHRASE.totalSec}s`);

const ep = voices[10];
const r = renderPhrase(ep, DEMO_PHRASE, { sampleRate: sr });
check('length matches the phrase', Math.abs(r.samples.length / sr - DEMO_PHRASE.totalSec) < 0.05,
  `${(r.samples.length / sr).toFixed(2)}s`);

const firstNote = rms(r.samples, 0.01 * sr, 0.42 * sr);
const gapAfterFirst = rms(r.samples, 0.62 * sr, 0.78 * sr);
check('first note sounds', firstNote > 1e-3, `rms ${firstNote.toFixed(4)}`);
check('a gap follows the first note', gapAfterFirst < firstNote, `${gapAfterFirst.toFixed(4)} < ${firstNote.toFixed(4)}`);

const singleRms = rms(r.samples, 0.02 * sr, 0.42 * sr);
const chordRms = rms(r.samples, 4.38 * sr, 5.15 * sr);
check('the triad is louder than one note', chordRms > singleRms, `${chordRms.toFixed(4)} vs ${singleRms.toFixed(4)}`);

const softVel = rms(r.samples, 5.37 * sr, 5.48 * sr);
const hardVel = rms(r.samples, 6.17 * sr, 6.42 * sr);
check('the velocity ramp rises', hardVel > softVel, `${hardVel.toFixed(4)} vs ${softVel.toFixed(4)}`);

const tail = rms(r.samples, 8.86 * sr, 9.18 * sr);
const held = rms(r.samples, 6.55 * sr, 8.40 * sr);
check('the tail decays after the last key-up', tail < held, `${tail.toFixed(4)} < ${held.toFixed(4)}`);

// Mod wheel must actually change something on a patch with LFO depth.
const withLfo = Uint8Array.from(ep);
withLfo[139] = 60; // LFO pitch mod depth
withLfo[143] = 6;  // pitch mod sensitivity
withLfo[137] = 40; // LFO speed
withLfo[138] = 0;  // no delay
const flat = renderPhrase(withLfo, { ...DEMO_PHRASE, mod: [{ at: 0, value: 0 }] }, { sampleRate: sr });
const swept = renderPhrase(withLfo, { ...DEMO_PHRASE, mod: [{ at: 0, value: 1 }] }, { sampleRate: sr });
let diff = 0;
for (let i = Math.floor(6.9 * sr); i < Math.floor(8.6 * sr); i++) diff += Math.abs(flat.samples[i] - swept.samples[i]);
check('the mod wheel changes the sound', diff / (1.7 * sr) > 1e-3, `mean |delta| ${(diff / (1.7 * sr)).toFixed(5)}`);

const single = renderPhrase(ep, singleNotePhrase(60, 100), { sampleRate: sr });
check('single-note phrase still works', single.peak > 1e-3, `peak ${single.peak.toFixed(3)}`);

writeFileSync(join(out, 'demo-phrase-epiano1.wav'), encodeWav(r.samples, sr));
console.log(`\n  wrote ${join(out, 'demo-phrase-epiano1.wav')}`);
console.log(fail === 0 ? '\nall phrase checks passed\n' : `\n${fail} check(s) failed\n`);
process.exit(fail === 0 ? 0 : 1);
