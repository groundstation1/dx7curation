/* Pitch bend moves the rendered pitch by the right amount. Run: node test/bend.ts */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { initEngine, N } from '../src/engine/tables.ts';
import { Dx7Note } from '../src/engine/dx7note.ts';
import { parseSysexFile } from '../src/sysex/parse.ts';
import { unpackVoice } from '../src/sysex/voice.ts';

const here = dirname(fileURLToPath(import.meta.url));
const RATE = 44100;
initEngine(RATE);

let fail = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (!ok) fail++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? '  ' + detail : ''}`);
};

const bytes = new Uint8Array(readFileSync(join(here, 'fixtures', 'ROM1A.syx')));
const voices = parseSysexFile(bytes, 'ROM1A.syx').voices.map((v) => unpackVoice(v.packed));

/** Dominant frequency of a rendered second, by parabolic-interpolated FFT-free autocorrelation. */
function pitchHz(voice: Uint8Array, pitchBase: number): number {
  const note = new Dx7Note();
  note.init(voice, 60, 100);
  const len = RATE;
  const sig = new Float32Array(len);
  const buf = new Int32Array(N);
  for (let at = 0; at + N <= len; at += N) {
    buf.fill(0);
    note.compute(buf, 0, 0, pitchBase);
    for (let i = 0; i < N; i++) sig[at + i] = buf[i] / (1 << 20);
  }
  // Autocorrelation over a plausible lag range, on the steady middle.
  const from = Math.floor(len * 0.35);
  const win = 8192;
  let bestLag = 0;
  let bestVal = -Infinity;
  for (let lag = 40; lag < 900; lag++) {
    let sum = 0;
    for (let i = 0; i < win; i++) sum += sig[from + i] * sig[from + i + lag];
    if (sum > bestVal) { bestVal = sum; bestLag = lag; }
  }
  return RATE / bestLag;
}

const semitone = (1 << 24) / 12;
// A simple, strongly periodic patch: the pitch has to be measurable at all.
const v = voices.find((x) => x[145] === 0) ?? voices[0];

const base = pitchHz(v, 0);
for (const [label, semis] of [['up two', 2], ['down two', -2], ['up seven', 7]] as const) {
  const bent = pitchHz(v, Math.round(semis * semitone));
  const measured = 12 * Math.log2(bent / base);
  check(`bend ${label} semitones`, Math.abs(measured - semis) < 0.06,
    `${measured.toFixed(3)} semitones (${base.toFixed(1)} Hz -> ${bent.toFixed(1)} Hz)`);
}

const unbent = pitchHz(v, 0);
check('no bend leaves the pitch alone', Math.abs(12 * Math.log2(unbent / base)) < 1e-6);

console.log(fail === 0 ? '\nall bend checks passed' : `\n${fail} check(s) failed`);
process.exit(fail === 0 ? 0 : 1);
