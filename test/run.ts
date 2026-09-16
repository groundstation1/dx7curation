/*
 * Round-trip and rendering checks. Run with: node test/run.ts
 * (Node 23+ strips the types itself, so there is no build step.)
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';

import { parseSysexFile } from '../src/sysex/parse.ts';
import { unpackVoice, packVoice, clampVoice, voiceName, isInitVoice, isSilentByParams, P } from '../src/sysex/voice.ts';
import { buildBank, verifyBank, buildSingleVoice } from '../src/sysex/write.ts';
import { isCarrier, carrierCount, feedbackOp } from '../src/engine/fmcore.ts';
import { renderVoice, encodeWav } from '../src/engine/render.ts';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, 'fixtures');
const outDir = join(here, 'out');
mkdirSync(outDir, { recursive: true });

let failures = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures++;
    console.log(`  FAIL ${name}\n       ${(err as Error).message}`);
  }
}

// ---------------------------------------------------------------- parsing

const rom1a = new Uint8Array(readFileSync(join(fixtures, 'ROM1A.syx')));
const report = parseSysexFile(rom1a, 'ROM1A.syx');

console.log('\nparse ROM1A.syx');
check('yields 32 voices', () => assert.equal(report.voices.length, 32));
check('recognised as one bank', () => assert.equal(report.banks, 1));
check('checksum verifies', () => assert.equal(report.voices[0].checksumOk, true));

const unpacked = report.voices.map((v) => unpackVoice(v.packed));
console.log('  names:', unpacked.map(voiceName).join(' | '));

check('names look like the ROM1A cartridge', () => {
  assert.equal(voiceName(unpacked[0]), 'BRASS   1');
  assert.equal(voiceName(unpacked[31]), 'TAKE OFF');
});

check('pack(unpack(x)) is byte-identical', () => {
  for (let i = 0; i < 32; i++) {
    const repacked = packVoice(unpacked[i]);
    assert.deepEqual([...repacked], [...report.voices[i].packed], `voice ${i} (${voiceName(unpacked[i])})`);
  }
});

check('every parameter is already in range', () => {
  for (let i = 0; i < 32; i++) {
    const copy = Uint8Array.from(unpacked[i]);
    const { changed } = clampVoice(copy);
    assert.equal(changed, 0, `voice ${i} had ${changed} out-of-range bytes`);
  }
});

check('no factory voice is an init or silent voice', () => {
  for (let i = 0; i < 32; i++) {
    assert.equal(isInitVoice(unpacked[i]), false, `voice ${i}`);
    assert.equal(isSilentByParams(unpacked[i], isCarrier), false, `voice ${i}`);
  }
});

// ---------------------------------------------------------------- writing

console.log('\nwrite + verify');
const rebuilt = buildBank(unpacked);
check('rebuilt bank is byte-identical to the source file', () => {
  assert.deepEqual([...rebuilt], [...rom1a]);
});
check('verifyBank passes against the source voices', () => {
  const v = verifyBank(rebuilt, unpacked);
  assert.equal(v.ok, true, v.problems.join('; '));
});
check('a corrupted checksum is caught', () => {
  const bad = Uint8Array.from(rebuilt);
  bad[4102] = (bad[4102] + 1) & 0x7f;
  assert.equal(verifyBank(bad).ok, false);
});
check('single-voice dump round-trips', () => {
  const single = buildSingleVoice(unpacked[0]);
  assert.equal(single.length, 163);
  const back = parseSysexFile(single, 'single.syx');
  assert.equal(back.voices.length, 1);
  assert.deepEqual([...unpackVoice(back.voices[0].packed)], [...unpacked[0]]);
});
check('single-voice dump is byte-exact to the DX7 format', () => {
  // What goes to the hardware, checked against the spec rather than against
  // our own parser: F0, Yamaha, sub-status 0, format 0, a byte count of 155,
  // the 155 parameters, a checksum that makes them sum to zero mod 128, F7.
  const single = buildSingleVoice(unpacked[0]);
  assert.deepEqual([...single.slice(0, 6)], [0xf0, 0x43, 0x00, 0x00, 0x01, 0x1b]);
  assert.equal((single[4] << 7) | single[5], 155);
  assert.deepEqual([...single.slice(6, 161)], [...unpacked[0]]);
  const sum = single.slice(6, 162).reduce((a, b) => a + b, 0);
  assert.equal(sum & 0x7f, 0, 'checksum does not balance');
  assert.equal(single[162], 0xf7);
  for (const b of single.slice(1, 162)) assert.ok(b < 0x80, 'a data byte has its high bit set');
});

// -------------------------------------------------- headerless / raw shapes

console.log('\nheaderless ingest');
check('a raw 4096-byte block is recovered', () => {
  const raw = rom1a.slice(6, 6 + 4096);
  const r = parseSysexFile(raw, 'raw.bin');
  assert.equal(r.voices.length, 32);
  assert.deepEqual([...unpackVoice(r.voices[0].packed)], [...unpacked[0]]);
});
check('two concatenated banks are both found', () => {
  const rom1b = new Uint8Array(readFileSync(join(fixtures, 'ROM1B.syx')));
  const both = new Uint8Array(rom1a.length + rom1b.length);
  both.set(rom1a, 0);
  both.set(rom1b, rom1a.length);
  const r = parseSysexFile(both, 'both.syx');
  assert.equal(r.voices.length, 64);
  assert.equal(r.banks, 2);
  assert.equal(voiceName(unpackVoice(r.voices[32].packed)), 'PIANO   4');
});
check('junk before the header does not break the scan', () => {
  const padded = new Uint8Array(17 + rom1a.length);
  padded.set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17], 0);
  padded.set(rom1a, 17);
  assert.equal(parseSysexFile(padded, 'padded.syx').voices.length, 32);
});

// -------------------------------------------------------------- structure

console.log('\nstructure');
check('algorithm 32 has six carriers, algorithm 1 has two', () => {
  assert.equal(carrierCount(31), 6);
  assert.equal(carrierCount(0), 2);
});
check('feedback operator is OP6 in algorithm 1 and 32', () => {
  assert.equal(feedbackOp(0), 0);
  assert.equal(feedbackOp(31), 0);
});

// ---------------------------------------------------------------- render

console.log('\nrender');
const probe = { note: 60, velocity: 100, holdSec: 1.0, releaseSec: 1.0, sampleRate: 44100, gain: 1 };
const rendered = unpacked.map((v) => renderVoice(v, probe));

check('every factory voice makes sound', () => {
  for (let i = 0; i < 32; i++) {
    assert.ok(rendered[i].peak > 1e-3, `${voiceName(unpacked[i])} peaked at ${rendered[i].peak}`);
  }
});
check('no NaN or infinite samples', () => {
  for (let i = 0; i < 32; i++) {
    const s = rendered[i].samples;
    for (let j = 0; j < s.length; j++) {
      if (!Number.isFinite(s[j])) throw new Error(`voice ${i} sample ${j} is ${s[j]}`);
    }
  }
});
check('a voice with all output levels at zero is silent', () => {
  const v = Uint8Array.from(unpacked[0]);
  for (let op = 0; op < 6; op++) v[P.opOutputLevel(op)] = 0;
  assert.ok(renderVoice(v, probe).peak < 1e-6);
});
check('velocity 40 is quieter than velocity 120 on BRASS 1', () => {
  const soft = renderVoice(unpacked[0], { ...probe, velocity: 40 });
  const hard = renderVoice(unpacked[0], { ...probe, velocity: 120 });
  assert.ok(soft.peak < hard.peak, `soft ${soft.peak} vs hard ${hard.peak}`);
});
check('the release tail decays after key-up', () => {
  const r = rendered[0];
  const tailStart = r.releaseAt + Math.floor(0.6 * r.sampleRate);
  let held = 0;
  let tail = 0;
  for (let i = r.releaseAt - 4410; i < r.releaseAt; i++) held = Math.max(held, Math.abs(r.samples[i]));
  for (let i = tailStart; i < r.samples.length; i++) tail = Math.max(tail, Math.abs(r.samples[i]));
  assert.ok(tail < held, `tail ${tail} vs held ${held}`);
});

// ------------------------------------------------------- tuning accuracy

/** A single unmodulated carrier: algorithm 32, OP1 only, ratio 1.00, no EG movement. */
function pureSineVoice(): Uint8Array {
  const v = new Uint8Array(155);
  for (let op = 0; op < 6; op++) {
    const d = op * 21;
    v[d + 0] = 99; v[d + 1] = 99; v[d + 2] = 99; v[d + 3] = 99; // rates
    v[d + 4] = 99; v[d + 5] = 99; v[d + 6] = 99; v[d + 7] = 0; // levels
    v[d + 8] = 39; // break point
    v[d + 16] = op === 5 ? 99 : 0; // OP1 only
    v[d + 18] = 1; // coarse 1.00
    v[d + 20] = 7; // detune centre
  }
  for (let i = 0; i < 4; i++) v[126 + i] = 99;
  for (let i = 0; i < 4; i++) v[130 + i] = 50;
  v[P.algorithm] = 31; // algorithm 32
  v[P.transpose] = 24;
  return v;
}

/** Frequency from zero crossings across a steady-state window. */
function estimateHz(s: Float32Array, sampleRate: number, from: number, to: number): number {
  let first = -1;
  let last = -1;
  let crossings = 0;
  for (let i = from + 1; i < to; i++) {
    if (s[i - 1] <= 0 && s[i] > 0) {
      // Linear interpolation of the crossing instant.
      const t = i - 1 + s[i - 1] / (s[i - 1] - s[i]);
      if (first < 0) first = t;
      else {
        last = t;
        crossings++;
      }
    }
  }
  if (crossings < 2) return 0;
  return (crossings * sampleRate) / (last - first);
}

console.log('\ntuning');
const sine = pureSineVoice();
for (const [note, expected] of [[36, 65.4064], [60, 261.6256], [69, 440.0], [84, 1046.502]] as const) {
  const r = renderVoice(sine, { note, velocity: 99, holdSec: 1.0, releaseSec: 0.1, sampleRate: 48000 });
  const hz = estimateHz(r.samples, r.sampleRate, 4800, 43200);
  const cents = 1200 * Math.log2(hz / expected);
  check(`note ${note} renders ${expected.toFixed(2)} Hz (got ${hz.toFixed(3)}, ${cents >= 0 ? '+' : ''}${cents.toFixed(2)} cents)`,
    () => assert.ok(Math.abs(cents) < 2, `off by ${cents.toFixed(2)} cents`));
}

check('coarse 2.00 renders one octave up', () => {
  const oct = Uint8Array.from(sine);
  oct[P.opCoarse(5)] = 2;
  const r = renderVoice(oct, { note: 60, velocity: 99, holdSec: 0.5, releaseSec: 0.1 });
  const hz = estimateHz(r.samples, r.sampleRate, 4410, 20000);
  assert.ok(Math.abs(1200 * Math.log2(hz / 523.2511)) < 2, `got ${hz.toFixed(2)} Hz`);
});

check('fixed-frequency mode ignores the note', () => {
  const fixed = Uint8Array.from(sine);
  fixed[P.opMode(5)] = 1;
  fixed[P.opCoarse(5)] = 2; // 10^2
  fixed[P.opFine(5)] = 0;
  const a = renderVoice(fixed, { note: 36, velocity: 99, holdSec: 0.5, releaseSec: 0.1 });
  const b = renderVoice(fixed, { note: 84, velocity: 99, holdSec: 0.5, releaseSec: 0.1 });
  const ha = estimateHz(a.samples, a.sampleRate, 4410, 20000);
  const hb = estimateHz(b.samples, b.sampleRate, 4410, 20000);
  assert.ok(Math.abs(ha - hb) < 0.5, `${ha} vs ${hb}`);
  assert.ok(Math.abs(ha - 100) < 1, `expected about 100 Hz, got ${ha}`);
});

check('transpose shifts the rendered pitch', () => {
  const up = Uint8Array.from(sine);
  up[P.transpose] = 36; // +12 semitones
  const r = renderVoice(up, { note: 60, velocity: 99, holdSec: 0.5, releaseSec: 0.1 });
  const hz = estimateHz(r.samples, r.sampleRate, 4410, 20000);
  assert.ok(Math.abs(1200 * Math.log2(hz / 523.2511)) < 2, `got ${hz.toFixed(2)} Hz`);
});

console.log('\n  peak / rms per voice:');
for (let i = 0; i < 32; i++) {
  const s = rendered[i].samples;
  let sum = 0;
  for (let j = 0; j < s.length; j++) sum += s[j] * s[j];
  const rms = Math.sqrt(sum / s.length);
  console.log(
    `    ${String(i).padStart(2)} ${voiceName(unpacked[i]).padEnd(10)}` +
    ` alg ${String(unpacked[i][P.algorithm] + 1).padStart(2)}` +
    ` fb ${unpacked[i][P.feedback]}` +
    ` peak ${rendered[i].peak.toFixed(4)}` +
    ` rms ${rms.toFixed(4)}`,
  );
}

for (const i of [0, 3, 7, 12, 16]) {
  const name = voiceName(unpacked[i]).replace(/[^A-Za-z0-9]+/g, '_');
  const file = join(outDir, `${String(i).padStart(2, '0')}_${name}.wav`);
  writeFileSync(file, encodeWav(rendered[i].samples, rendered[i].sampleRate));
}
console.log(`\n  wrote sample renders to ${outDir}`);

console.log(failures === 0 ? '\nall checks passed\n' : `\n${failures} check(s) failed\n`);
process.exit(failures === 0 ? 0 : 1);
