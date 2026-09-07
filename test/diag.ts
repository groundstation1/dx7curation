import { readFileSync } from 'node:fs';
import { parseSysexFile } from '../src/sysex/parse.ts';
import { unpackVoice, voiceName, P } from '../src/sysex/voice.ts';
import { isCarrier } from '../src/engine/fmcore.ts';
import { operatorRatio } from '../src/features/structural.ts';
import { renderVoice } from '../src/engine/render.ts';
import { rmsEnvelope } from '../src/features/dsp.ts';

const rows: Array<{ name: string; u: Uint8Array }> = [];
for (const f of ['ROM1A.syx', 'ROM1B.syx']) {
  const b = new Uint8Array(readFileSync(new URL(`./fixtures/${f}`, import.meta.url)));
  for (const v of parseSysexFile(b, f).voices) { const u = unpackVoice(v.packed); rows.push({ name: voiceName(u), u }); }
}
for (const name of ['BASS    1', 'BASS    3', 'MARIMBA', 'E.ORGAN 1', 'ORCH-CHIME', 'BRASS   1', 'PIANO   1', 'TIMPANI']) {
  const r = rows.find((x) => x.name === name); if (!r) continue;
  const u = r.u; const alg = u[P.algorithm] & 31;
  const parts: string[] = [];
  for (let op = 0; op < 6; op++) {
    const lvl = u[P.opOutputLevel(op)];
    if (lvl === 0) continue;
    const mode = u[P.opMode(op)];
    const hz = mode ? Math.pow(10, (u[P.opCoarse(op)] & 3) + u[P.opFine(op)] / 100) : 0;
    parts.push(`OP${6 - op}${isCarrier(alg, op) ? '*' : ' '} ${mode ? 'fix' + hz.toFixed(1) : 'r' + operatorRatio(u[P.opCoarse(op)], u[P.opFine(op)]).toFixed(2)} l${lvl}`);
  }
  console.log(`${name.padEnd(11)} alg${alg + 1} tr${u[P.transpose] - 24}  ${parts.join('  ')}`);
}
console.log('\nnormalised rms envelope, note 60 vel 120, 5.8 ms per frame, first 70 frames:');
for (const name of ['ORCH-CHIME', 'BRASS   1', 'BRASS   2', 'PIANO   1']) {
  const r = rows.find((x) => x.name === name)!;
  const out = renderVoice(r.u, { note: 60, velocity: 120, holdSec: 1, releaseSec: 1 });
  const env = rmsEnvelope(out.samples, 512, 256);
  let pk = 0, pkf = 0;
  for (let i = 0; i < env.length; i++) if (env[i] > pk) { pk = env[i]; pkf = i; }
  console.log(`  ${name}: peak at frame ${pkf} (${(pkf * 256 / 44100 * 1000).toFixed(0)} ms)`);
  console.log('   ', Array.from(env.slice(0, 70)).map((x) => (x / pk).toFixed(2)).join(' '));
}
