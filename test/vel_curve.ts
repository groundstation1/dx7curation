/* Where is the real middle of the DX7 velocity response? Run: node test/vel_curve.ts */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseSysexFile } from '../src/sysex/parse.ts';
import { unpackVoice } from '../src/sysex/voice.ts';
import { renderVoice } from '../src/engine/render.ts';
import { magnitudeSpectrum, spectralCentroid, dbFromAmp } from '../src/features/dsp.ts';
import { voiceFundamentalHz } from '../src/render/probe.ts';

// msfa's velocity table: the DX7 maps velocity through this before it reaches
// the envelope, and it is very far from linear.
const VELOCITY_DATA = [
  0, 70, 86, 97, 106, 114, 121, 126, 132, 138, 142, 148, 152, 156, 160, 163,
  166, 170, 173, 174, 178, 181, 184, 186, 189, 190, 194, 196, 198, 200, 202,
  205, 206, 209, 211, 214, 216, 218, 220, 222, 224, 225, 227, 229, 230, 232,
  233, 235, 237, 238, 240, 241, 242, 243, 244, 246, 246, 248, 249, 250, 251,
  252, 253, 254,
];
const scaled = (v: number) => VELOCITY_DATA[Math.max(0, Math.min(127, v)) >> 1] - 239;

console.log('what the DX7 actually does with a velocity value:');
console.log('  vel   scaled   position in the vel 8-127 range');
for (const v of [8, 20, 30, 40, 50, 60, 64, 70, 80, 90, 100, 110, 127]) {
  const lo = scaled(8);
  const hi = scaled(127);
  const pos = ((scaled(v) - lo) / (hi - lo)) * 100;
  console.log(`  ${String(v).padStart(3)}  ${String(scaled(v)).padStart(6)}   ${pos.toFixed(0).padStart(3)}%${v === 70 ? '   <- current MID' : ''}`);
}
let bestV = 64;
let bestD = Infinity;
for (let v = 8; v <= 127; v++) {
  const pos = (scaled(v) - scaled(8)) / (scaled(127) - scaled(8));
  if (Math.abs(pos - 0.5) < bestD) { bestD = Math.abs(pos - 0.5); bestV = v; }
}
console.log(`\n  the true midpoint of that curve is velocity ${bestV}`);

const here = dirname(fileURLToPath(import.meta.url));
const voices: Uint8Array[] = [];
for (const f of ['ROM1A.syx', 'ROM1B.syx']) {
  const b = new Uint8Array(readFileSync(join(here, 'fixtures', f)));
  for (const v of parseSysexFile(b, f).voices) voices.push(unpackVoice(v.packed));
}
const measure = (u: Uint8Array, vel: number) => {
  const r = renderVoice(u, { note: 60, velocity: vel, holdSec: 0.5, releaseSec: 0.05, sampleRate: 44100 });
  const mag = magnitudeSpectrum(r.samples, 4410, 8192);
  const c = spectralCentroid(mag, 44100, 8192);
  const f0 = voiceFundamentalHz(u, 60);
  let sum = 0;
  for (let i = 0; i < r.samples.length; i++) sum += r.samples[i] * r.samples[i];
  return { bright: c > 0 && f0 > 0 ? Math.log2(c / f0) : 0, level: dbFromAmp(Math.sqrt(sum / r.samples.length)) };
};
const vels = [8, 30, 52, 64, 70, 90, 127];
console.log('\nmeasured across 64 voices, as a share of the vel 8 -> 127 span:');
console.log('  vel   level    brightness');
for (const v of vels) {
  let lp = 0, bp = 0;
  for (const u of voices) {
    const lo = measure(u, 8);
    const hi = measure(u, 127);
    const m = measure(u, v);
    if (hi.level - lo.level > 0.5) lp += (m.level - lo.level) / (hi.level - lo.level);
    if (Math.abs(hi.bright - lo.bright) > 0.05) bp += (m.bright - lo.bright) / (hi.bright - lo.bright);
  }
  console.log(`  ${String(v).padStart(3)}   ${(lp / voices.length * 100).toFixed(0).padStart(3)}%     ${(bp / voices.length * 100).toFixed(0).padStart(3)}%`);
}
