/* Does polyphony clip at unity? Run: node test/headroom.ts */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseSysexFile } from '../src/sysex/parse.ts';
import { unpackVoice, voiceName } from '../src/sysex/voice.ts';
import { DEMO_PHRASE, renderPhrase, singleNotePhrase } from '../src/engine/phrase.ts';

const here = dirname(fileURLToPath(import.meta.url));
const voices: Array<{ name: string; u: Uint8Array }> = [];
for (const f of ['ROM1A.syx', 'ROM1B.syx', 'ROM3A.syx', 'ROM3B.syx']) {
  const b = new Uint8Array(readFileSync(join(here, 'fixtures', f)));
  for (const v of parseSysexFile(b, f).voices) {
    const u = unpackVoice(v.packed);
    voices.push({ name: voiceName(u), u });
  }
}

const sr = 44100;
const MAKEUP = 2;
const peakIn = (s: Float32Array, a: number, b: number) => {
  let p = 0;
  for (let i = Math.floor(a); i < Math.min(s.length, Math.floor(b)); i++) {
    const v = Math.abs(s[i]);
    if (v > p) p = v;
  }
  return p;
};

let worstSingle = { name: '', p: 0 };
let worstChord = { name: '', p: 0 };
let clippedAtUnity = 0;
for (const v of voices) {
  const r = renderPhrase(v.u, DEMO_PHRASE, { sampleRate: sr });
  const single = peakIn(r.samples, 0, 0.35 * sr);
  const chord = peakIn(r.samples, 2.22 * sr, 3.6 * sr);
  if (single > worstSingle.p) worstSingle = { name: v.name.trim(), p: single };
  if (chord > worstChord.p) worstChord = { name: v.name.trim(), p: chord };
  if (r.peak >= 0.999) clippedAtUnity++;
}

console.log(`at unity (what is now written into the buffer):`);
console.log(`  loudest single note : ${worstSingle.p.toFixed(3)}  (${worstSingle.name})`);
console.log(`  loudest 4-note chord: ${worstChord.p.toFixed(3)}  (${worstChord.name})`);
console.log(`  voices hitting full scale before makeup: ${clippedAtUnity} of ${voices.length}`);
console.log(`\nafter the graph makeup of x${MAKEUP}, before the limiter:`);
console.log(`  loudest single note : ${(worstSingle.p * MAKEUP).toFixed(2)}`);
console.log(`  loudest chord       : ${(worstChord.p * MAKEUP).toFixed(2)}`);
console.log(`  the limiter (threshold -3 dB, ratio 12) catches anything above ${(0.708).toFixed(2)}`);

// What the old code did, for comparison.
const old = renderPhrase(voices.find((v) => v.name.trim() === 'E.PIANO 1')!.u, DEMO_PHRASE, { sampleRate: sr, gain: 4 });
let hard = 0;
for (let i = 0; i < old.samples.length; i++) if (Math.abs(old.samples[i]) >= 0.999) hard++;
console.log(`\nold path (gain 4 baked in, E.PIANO 1): ${hard} samples hard-clipped in the buffer`);
const now = renderPhrase(voices.find((v) => v.name.trim() === 'E.PIANO 1')!.u, DEMO_PHRASE, { sampleRate: sr });
let hard2 = 0;
for (let i = 0; i < now.samples.length; i++) if (Math.abs(now.samples[i]) >= 0.999) hard2++;
console.log(`new path (unity):                      ${hard2} samples hard-clipped in the buffer`);
void singleNotePhrase;
