/*
 * Voices that never stop, and the test that catches them. Run: node test/drone.ts
 *
 * A DX7 envelope's fourth level is where it settles after key-up, and it is not
 * required to be zero. Thirteen of the 128 factory voices have a carrier whose
 * L4 is above zero, so their release ends on an audible level and the note
 * sounds until the hardware steals the voice for something else. The live
 * engine has no such reaper, so it needs Dx7Note.settled to know when a note
 * has stopped doing anything except sounding.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { initEngine, N } from '../src/engine/tables.ts';
import { Dx7Note } from '../src/engine/dx7note.ts';
import { parseSysexFile } from '../src/sysex/parse.ts';
import { unpackVoice, voiceName } from '../src/sysex/voice.ts';

const here = dirname(fileURLToPath(import.meta.url));
const RATE = 44100;
initEngine(RATE);

let fail = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (!ok) fail++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? '  ' + detail : ''}`);
};

/** Hold for 60 ms, release, then run until it stops or settles. */
function afterKeyup(voice: Uint8Array, limitSec = 10) {
  const note = new Dx7Note();
  note.init(voice, 60, 100);
  const buf = new Int32Array(N);
  for (let i = 0; i < 40; i++) {
    buf.fill(0);
    note.compute(buf, 0, 0);
  }
  note.keyup();
  let blocks = 0;
  const limit = (limitSec * RATE) / N;
  while (note.isPlaying() && !note.settled && blocks < limit) {
    buf.fill(0);
    note.compute(buf, 0, 0);
    blocks++;
  }
  let peak = 0;
  for (let i = 0; i < 200; i++) {
    buf.fill(0);
    note.compute(buf, 0, 0);
    for (const s of buf) peak = Math.max(peak, Math.abs(s));
  }
  return { seconds: (blocks * N) / RATE, playing: note.isPlaying(), settled: note.settled, peak: peak / (1 << 23) };
}

const voices: Uint8Array[] = [];
for (const file of ['ROM1A.syx', 'ROM1B.syx', 'ROM3A.syx', 'ROM3B.syx']) {
  const bytes = new Uint8Array(readFileSync(join(here, 'fixtures', file)));
  for (const v of parseSysexFile(bytes, file).voices) voices.push(unpackVoice(v.packed));
}

let droning = 0;
const slow: string[] = [];
for (const v of voices) {
  const r = afterKeyup(v);
  if (r.playing) droning++;
  // Not settled inside ten seconds means the release is genuinely still
  // falling - a long bell tail, not a drone. Those are ended by the live
  // engine's MAX_RELEASE_SEC ceiling rather than by settling.
  if (!r.settled) slow.push(voiceName(v).trim());
}

console.log(`${droning} of ${voices.length} factory voices are still sounding when their envelope settles`);
console.log(`${slow.length} have a release longer than ten seconds: ${slow.join(', ')}`);
check('some factory voices do drone', droning > 0, `${droning} of them`);
check('drones are the minority, not the rule', droning < voices.length / 4, `${droning} of ${voices.length}`);
check('very long releases are rare', slow.length < 10, `${slow.length} of ${voices.length}`);

const byName = (n: string) => voices.find((v) => voiceName(v).trim() === n)!;

const train = afterKeyup(byName('TRAIN'));
check('TRAIN settles and is still audible', train.settled && train.playing, `${train.seconds.toFixed(2)} s, peak ${train.peak.toFixed(2)}`);

const epiano = afterKeyup(byName('E.PIANO 1'));
check('E.PIANO 1 stops on its own', !epiano.playing, `${epiano.seconds.toFixed(2)} s`);

console.log(fail === 0 ? '\nall drone checks passed' : `\n${fail} check(s) failed`);
process.exit(fail === 0 ? 0 : 1);
