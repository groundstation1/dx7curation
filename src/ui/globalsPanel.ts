/*
 * Everything in a voice that is not an operator.
 *
 * The sidebar drew six operators in detail and said nothing about the
 * nineteen settings that apply to the whole patch - the pitch envelope, the
 * LFO, transpose - apart from the algorithm and feedback in its header. Some
 * of those are the patch: a pitch envelope is why a sound swoops, the LFO is
 * why it wobbles.
 *
 * Compact because most patches leave most of them alone, and dimmed wherever
 * a value is doing nothing - so what is left bright is what this patch
 * actually uses. "Doing nothing" is not always zero: a pitch-envelope level of
 * 50 is no bend at all and 0 is a dive of several octaves, and transpose 24 is
 * no shift. Each value is dimmed at its own resting point, and the two with a
 * centre are shown relative to it.
 */
import { el } from './dom.ts';
import { P } from '../sysex/voice.ts';

const WAVES = ['triangle', 'saw down', 'saw up', 'square', 'sine', 'sample & hold'];
const PITCH_EG_CENTRE = 50;
const TRANSPOSE_CENTRE = 24;

function val(text: string, resting: boolean, title: string): HTMLElement {
  return el('span', { class: resting ? 'g-val rest' : 'g-val', title }, text);
}

function row(label: string, resting: boolean, ...values: Array<Node | null>): HTMLElement {
  return el('div', { class: resting ? 'g-row rest' : 'g-row' },
    el('span', { class: 'g-key' }, label),
    el('span', { class: 'g-vals' }, ...values));
}

export function globalsPanel(u: Uint8Array): HTMLElement {
  const levels = [0, 1, 2, 3].map((i) => u[P.pitchEgLevel(i)]);
  const rates = [0, 1, 2, 3].map((i) => u[P.pitchEgRate(i)]);
  // With every level at the centre the envelope moves pitch nowhere, however
  // fast it gets there, so the rates are only worth reading if it bends.
  const flat = levels.every((l) => l === PITCH_EG_CENTRE);

  const pmd = u[P.lfoPmDepth];
  const amd = u[P.lfoAmDepth];
  const pms = u[P.pitchModSens];
  /*
   * Whether the LFO can reach the sound at all, by any route.
   *
   * Not "both depths are zero": the mod wheel supplies depth of its own, so a
   * patch with no LFO depth set can still wobble the moment the wheel moves.
   * What actually cuts it off is sensitivity - pitch needs this patch's pitch
   * mod sensitivity, amplitude needs at least one operator's AMS - and with
   * neither, nothing the LFO does is ever heard.
   */
  let anyAms = false;
  for (let op = 0; op < 6; op++) if (u[P.opAmpModSens(op)] > 0) anyAms = true;
  const lfoInert = pms === 0 && !anyAms;
  const transpose = u[P.transpose] - TRANSPOSE_CENTRE;
  const signed = (n: number) => (n > 0 ? `+${n}` : n < 0 ? `−${-n}` : '0');

  return el('div', { class: 'g-panel' },
    // Four rates and four levels as two values rather than eight: one line
    // in a sidebar, and the levels read as bends from the note as played.
    row('pitch EG', flat,
      val(`R ${rates.join(' ')}`, flat, 'rates 1-4: how fast the pitch moves to each level'),
      val(`L ${levels.map((l) => signed(l - PITCH_EG_CENTRE)).join(' ')}`, flat,
        `levels 1-4, relative to 50 - the note as played (stored as ${levels.join(' ')})`)),
    row('LFO', lfoInert,
      val(WAVES[u[P.lfoWaveform]] ?? `wave ${u[P.lfoWaveform]}`, lfoInert, 'waveform'),
      val(`speed ${u[P.lfoSpeed]}`, lfoInert || u[P.lfoSpeed] === 0, 'LFO speed'),
      val(`delay ${u[P.lfoDelay]}`, lfoInert || u[P.lfoDelay] === 0, 'how long after the key before the LFO fades in'),
      val(`pitch ${pmd}`, pmd === 0, 'pitch modulation depth - vibrato'),
      val(`amp ${amd}`, amd === 0, 'amplitude modulation depth - tremolo, on operators whose AMS is up'),
      val(u[P.lfoKeySync] ? 'key sync' : 'free', u[P.lfoKeySync] === 0,
        'key sync restarts the LFO on every note; free lets it run')),
    row('pitch mod', pms === 0,
      val(`sens ${pms}`, pms === 0, 'how strongly the LFO and the mod wheel move the pitch')),
    row('transpose', transpose === 0,
      val(`${signed(transpose)} st`, transpose === 0, `semitones from C3 (stored as ${u[P.transpose]})`)),
    row('osc sync', u[P.oscKeySync] === 0,
      val(u[P.oscKeySync] ? 'on' : 'off', u[P.oscKeySync] === 0,
        'on restarts every oscillator at the same phase on each note, so the attack is identical every time')),
  );
}
