/* How much velocity contrast is actually in the render? Run: node test/velocity.ts */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseSysexFile } from '../src/sysex/parse.ts';
import { unpackVoice, voiceName } from '../src/sysex/voice.ts';
import { renderVoice } from '../src/engine/render.ts';

const here = dirname(fileURLToPath(import.meta.url));
const voices: Array<{ name: string; u: Uint8Array }> = [];
for (const f of ['ROM1A.syx', 'ROM1B.syx', 'ROM3A.syx', 'ROM3B.syx']) {
  const b = new Uint8Array(readFileSync(join(here, 'fixtures', f)));
  for (const v of parseSysexFile(b, f).voices) {
    const u = unpackVoice(v.packed);
    voices.push({ name: voiceName(u).trim(), u });
  }
}

const rms = (s: Float32Array, n: number) => {
  let t = 0;
  for (let i = 0; i < n && i < s.length; i++) t += s[i] * s[i];
  return Math.sqrt(t / n);
};
const db = (x: number) => 20 * Math.log10(Math.max(x, 1e-9));

const results = voices.map((v) => {
  const soft = renderVoice(v.u, { note: 60, velocity: 30, holdSec: 0.25, releaseSec: 0.05 });
  const mid = renderVoice(v.u, { note: 60, velocity: 40, holdSec: 0.25, releaseSec: 0.05 });
  const hard = renderVoice(v.u, { note: 60, velocity: 120, holdSec: 0.25, releaseSec: 0.05 });
  const n = Math.floor(0.25 * 44100);
  return {
    name: v.name,
    d40: db(rms(hard.samples, n)) - db(rms(mid.samples, n)),
    d30: db(rms(hard.samples, n)) - db(rms(soft.samples, n)),
  };
});

const sorted = [...results].sort((a, b) => a.d40 - b.d40);
const median = (a: number[]) => a.slice().sort((x, y) => x - y)[a.length >> 1];
console.log(`velocity 120 vs 40, across ${results.length} factory voices:`);
console.log(`  median contrast ${median(results.map((r) => r.d40)).toFixed(1)} dB`);
console.log(`  quartiles ${sorted[Math.floor(sorted.length * 0.25)].d40.toFixed(1)} / ${sorted[Math.floor(sorted.length * 0.75)].d40.toFixed(1)} dB`);
console.log(`  ${results.filter((r) => r.d40 < 3).length} voices under 3 dB (velocity barely does anything)`);
console.log(`  ${results.filter((r) => r.d40 > 12).length} voices over 12 dB`);
console.log(`\nusing velocity 30 instead of 40 widens the median to ${median(results.map((r) => r.d30)).toFixed(1)} dB`);
console.log('\nleast responsive:', sorted.slice(0, 4).map((r) => `${r.name} ${r.d40.toFixed(1)}dB`).join(', '));
console.log('most responsive:', sorted.slice(-4).map((r) => `${r.name} ${r.d40.toFixed(1)}dB`).join(', '));
