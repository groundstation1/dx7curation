/* What does velocity 127 do to the timbre? Run: node test/vel_timbre.ts */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseSysexFile } from '../src/sysex/parse.ts';
import { unpackVoice, voiceName } from '../src/sysex/voice.ts';
import { renderVoice } from '../src/engine/render.ts';
import { magnitudeSpectrum, spectralCentroid } from '../src/features/dsp.ts';
import { voiceFundamentalHz } from '../src/render/probe.ts';

const here = dirname(fileURLToPath(import.meta.url));
const voices: Array<{ name: string; u: Uint8Array }> = [];
for (const f of ['ROM1A.syx', 'ROM1B.syx', 'ROM3A.syx', 'ROM3B.syx']) {
  const b = new Uint8Array(readFileSync(join(here, 'fixtures', f)));
  for (const v of parseSysexFile(b, f).voices) {
    const u = unpackVoice(v.packed);
    voices.push({ name: voiceName(u).trim(), u });
  }
}

const brightness = (u: Uint8Array, vel: number) => {
  const r = renderVoice(u, { note: 60, velocity: vel, holdSec: 0.5, releaseSec: 0.05, sampleRate: 44100 });
  const mag = magnitudeSpectrum(r.samples, 4410, 8192);
  const c = spectralCentroid(mag, 44100, 8192);
  const f0 = voiceFundamentalHz(u, 60);
  return c > 0 && f0 > 0 ? Math.log2(c / f0) : 0;
};

const rows = voices.map((v) => {
  const b64 = brightness(v.u, 64);
  const b100 = brightness(v.u, 100);
  const b127 = brightness(v.u, 127);
  return { name: v.name, d100: b100 - b64, d127: b127 - b64, step: b127 - b100 };
});
const median = (a: number[]) => a.slice().sort((x, y) => x - y)[a.length >> 1];
console.log(`brightness above the fundamental, relative to velocity 64, across ${rows.length} voices:`);
console.log(`  at velocity 100: median +${median(rows.map((r) => r.d100)).toFixed(2)} octaves`);
console.log(`  at velocity 127: median +${median(rows.map((r) => r.d127)).toFixed(2)} octaves`);
console.log(`  the last stretch 100 -> 127 alone adds a median +${median(rows.map((r) => r.step)).toFixed(2)} octaves`);
const harsh = rows.filter((r) => r.d127 > 1).length;
console.log(`  ${harsh} of ${rows.length} voices gain over a full octave of brightness going from 64 to 127`);
const worst = [...rows].sort((a, b) => b.d127 - a.d127).slice(0, 5);
console.log('  brightest jumps:', worst.map((r) => `${r.name} +${r.d127.toFixed(1)}`).join(', '));
