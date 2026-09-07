/* Does the mod wheel axis actually separate anything? Run: node test/modwheel.ts */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseSysexFile } from '../src/sysex/parse.ts';
import { unpackVoice, voiceName } from '../src/sysex/voice.ts';
import { renderProbe } from '../src/render/probe.ts';
import { extractAcoustic } from '../src/features/acoustic.ts';
import { extractStructural } from '../src/features/structural.ts';

const here = dirname(fileURLToPath(import.meta.url));
const rows: Array<{ name: string; u: Uint8Array }> = [];
for (const f of ['ROM1A.syx', 'ROM1B.syx', 'ROM3A.syx', 'ROM3B.syx']) {
  const b = new Uint8Array(readFileSync(join(here, 'fixtures', f)));
  for (const v of parseSysexFile(b, f).voices) {
    const u = unpackVoice(v.packed);
    rows.push({ name: voiceName(u), u });
  }
}

const t0 = performance.now();
const analysed = rows.map((r) => {
  const a = extractAcoustic(renderProbe(r.u));
  const s = extractStructural(r.u);
  return { ...r, a, s };
});
console.log(`${analysed.length} voices in ${(performance.now() - t0).toFixed(0)} ms (${((performance.now() - t0) / analysed.length).toFixed(1)} ms each)\n`);

const sorted = [...analysed].sort((x, y) => y.a.modResponse - x.a.modResponse);
console.log('most responsive to the mod wheel:');
console.log('  name        overall  pred  pms  ampC ampM   vib(c)   trem  timbre');
for (const r of sorted.slice(0, 12)) {
  console.log(`  ${r.name.padEnd(11)} ${r.a.modResponse.toFixed(3).padStart(7)} ${r.s.modWheelDepth.toFixed(2).padStart(5)}` +
    ` ${String(r.s.pitchModSens).padStart(4)} ${String(r.s.ampModOnCarriers).padStart(5)} ${String(r.s.ampModOnModulators).padStart(4)}` +
    ` ${r.a.modVibratoCents.toFixed(0).padStart(8)} ${r.a.modTremoloDepth.toFixed(3).padStart(6)} ${r.a.modTimbreOct.toFixed(3).padStart(7)}`);
}
console.log('\nleast responsive:');
for (const r of sorted.slice(-4)) {
  console.log(`  ${r.name.padEnd(11)} ${r.a.modResponse.toFixed(3).padStart(7)} ${String(r.s.pitchModSens).padStart(4)} ${String(r.s.ampModMax).padStart(5)}`);
}

console.log(`
what the wheel actually does, by dominant mode:`);
const modes = analysed.map((v) => {
  const vib = Math.min(1, v.a.modVibratoCents / 1200);
  const trem = Math.min(1, v.a.modTremoloDepth / 0.5);
  const timb = Math.min(1, v.a.modTimbreOct / 0.33);
  const best = Math.max(vib, trem, timb);
  const mode = best < 0.02 ? 'nothing' : best === vib ? 'vibrato' : best === trem ? 'tremolo' : 'growl';
  return { ...v, mode, vib, trem, timb };
});
const byMode = new Map<string, number>();
for (const m of modes) byMode.set(m.mode, (byMode.get(m.mode) ?? 0) + 1);
for (const [k, n] of [...byMode].sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(8)} ${n}`);
for (const want of ['tremolo', 'growl']) {
  const ex = modes.filter((m) => m.mode === want).sort((a, b) => b[want === 'tremolo' ? 'trem' : 'timb'] - a[want === 'tremolo' ? 'trem' : 'timb']).slice(0, 5);
  if (ex.length) console.log(`  strongest ${want}: ${ex.map((e) => `${e.name.trim()} (vib ${e.a.modVibratoCents.toFixed(0)}c, trem ${e.a.modTremoloDepth.toFixed(2)}, timbre ${e.a.modTimbreOct.toFixed(2)})`).join('; ')}`);
}

// Correlation between predicted and measured.
const xs = analysed.map((r) => r.s.modWheelDepth);
const ys = analysed.map((r) => r.a.modResponse);
const mean = (a: number[]) => a.reduce((p, c) => p + c, 0) / a.length;
const mx = mean(xs), my = mean(ys);
let num = 0, dx = 0, dy = 0;
for (let i = 0; i < xs.length; i++) {
  num += (xs[i] - mx) * (ys[i] - my);
  dx += (xs[i] - mx) ** 2;
  dy += (ys[i] - my) ** 2;
}
const r = num / Math.sqrt(dx * dy);
console.log(`\npredicted vs measured correlation: r = ${r.toFixed(3)}`);

const dead = analysed.filter((v) => v.s.pitchModSens === 0 && v.s.ampModMax === 0);
const deadMax = Math.max(0, ...dead.map((v) => v.a.modResponse));
console.log(`${dead.length} voices cannot respond at all (pms 0, ampMax 0); their highest measured response is ${deadMax.toFixed(4)}`);
const live = analysed.filter((v) => v.s.modWheelDepth > 0.3);
console.log(`${live.length} voices with predicted depth > 0.3; median measured ${live.length ? live.map((v) => v.a.modResponse).sort((a, b) => a - b)[live.length >> 1].toFixed(3) : 'n/a'}`);
