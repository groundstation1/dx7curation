/*
 * Everything in a voice that is not an operator, drawn.
 *
 * The sidebar drew six operators in detail and said nothing about the
 * settings that apply to the whole patch - the pitch envelope, the LFO,
 * transpose - apart from the algorithm and feedback in its header. Some of
 * those are the patch: a pitch envelope is why a sound swoops, the LFO is why
 * it wobbles.
 *
 * Drawn rather than listed, in the operators' own vocabulary - a curve, a
 * dashed key-up line, meters - and the two curves are not illustrations. The
 * pitch envelope and the LFO are the engine's own classes, run here at the
 * engine's own block rate, so the shape, the timing, the LFO's speed and its
 * fade-in are what the patch will actually do, not a sketch of eight numbers.
 *
 * Anything at rest is dimmed, so what stays bright is what the patch uses.
 * "At rest" is not always zero: a pitch-envelope level of 50 is no bend and
 * transpose 24 is no shift. And the LFO is dimmed only when nothing can reach
 * it, because the mod wheel supplies depth of its own.
 */
import { el } from './dom.ts';
import { P } from '../sysex/voice.ts';
import { PitchEnv } from '../engine/pitchenv.ts';
import { Lfo, lfoSource } from '../engine/lfo.ts';
import { initEngine, N, rateState } from '../engine/tables.ts';

const WAVES = ['triangle', 'saw down', 'saw up', 'square', 'sine', 'S&H'];
const PITCH_EG_CENTRE = 50;
const TRANSPOSE_CENTRE = 24;
const Q24 = 1 << 24;

const SVG_NS = 'http://www.w3.org/2000/svg';
function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
}

/*
 * Blocks per second at the rate the engine was set up for.
 *
 * The rate state is shared with the live keyboard engine, so this never
 * changes a rate that has been set - it only sets one if nothing has yet, and
 * then reads back whatever is in force. Seconds come out right either way,
 * because they are computed from the same rate the units were.
 */
function blocksPerSecond(): number {
  if (!rateState.sampleRate) initEngine(44100);
  return rateState.sampleRate / N;
}

/** The pitch envelope as the engine runs it: semitones over time, and key-up. */
function tracePitchEnv(u: Uint8Array): { t: number[]; st: number[]; keyUp: number } {
  const env = new PitchEnv();
  env.set([0, 1, 2, 3].map((i) => u[P.pitchEgRate(i)]), [0, 1, 2, 3].map((i) => u[P.pitchEgLevel(i)]));
  const bps = blocksPerSecond();
  const t: number[] = [];
  const st: number[] = [];
  let block = 0;
  // Run each phase until it has stopped moving, with a floor so a slow start
  // is not mistaken for a finished one, and a ceiling for rate-0 stages that
  // would otherwise take minutes.
  const phase = (minSec: number, maxSec: number) => {
    let last = NaN;
    let still = 0;
    for (let b = 0; b < maxSec * bps; b++, block++) {
      const s = (env.getsample() / Q24) * 12;
      if (block % 8 === 0) {
        t.push(block / bps);
        st.push(s);
      }
      still = s === last ? still + 1 : 0;
      last = s;
      if (b > minSec * bps && still > 0.25 * bps) break;
    }
  };
  phase(0.4, 4);
  const keyUp = block / bps;
  env.keydown(false);
  phase(0.3, 3);
  return { t, st, keyUp };
}

function pitchEnvPlot(u: Uint8Array, flat: boolean): SVGSVGElement {
  const w = 300;
  const h = 58;
  const pad = { l: 4, r: 4, t: 12, b: 4 };
  const plotW = w - pad.l - pad.r;
  const plotH = h - pad.t - pad.b;
  const mid = pad.t + plotH / 2;
  const root = svg('svg', { viewBox: `0 0 ${w} ${h}`, class: 'g-plot' });
  root.appendChild(svg('rect', { x: pad.l, y: pad.t, width: plotW, height: plotH, rx: 3, fill: 'var(--bg)', stroke: 'var(--raise-2)' }));
  // The note as played.
  root.appendChild(svg('line', { x1: pad.l, y1: mid, x2: pad.l + plotW, y2: mid, stroke: 'var(--muted)', 'stroke-dasharray': '2 3', opacity: 0.5 }));

  const { t, st, keyUp } = tracePitchEnv(u);
  const end = t[t.length - 1] || 1;
  const peak = Math.max(...st.map(Math.abs), 0);
  // A nice full-scale value, so the label is a number worth reading.
  const scale = [1, 2, 3, 5, 7, 12, 24, 36, 48].find((s) => s >= peak) ?? Math.ceil(peak);
  const x = (s: number) => pad.l + (s / end) * plotW;
  const y = (v: number) => mid - (v / scale) * (plotH / 2 - 2);

  const d = t.map((s, i) => `${i ? 'L' : 'M'}${x(s).toFixed(1)} ${y(st[i]).toFixed(1)}`).join(' ');
  root.appendChild(svg('path', { d: `${d} L${x(end).toFixed(1)} ${mid} L${pad.l} ${mid} Z`, fill: 'var(--accent)', opacity: 0.18 }));
  root.appendChild(svg('path', { d, fill: 'none', stroke: 'var(--accent)', 'stroke-width': 1.8, 'stroke-linejoin': 'round' }));
  const label = svg('text', { x: pad.l, y: 9, class: 'g-t' });
  label.textContent = flat ? 'flat' : `±${scale} st  ·  ${end.toFixed(1)} s`;
  root.appendChild(label);
  // A flat envelope has nothing for key-up to change.
  if (flat) return root;
  root.appendChild(svg('line', { x1: x(keyUp), y1: pad.t, x2: x(keyUp), y2: pad.t + plotH, stroke: 'var(--accent-2)', 'stroke-dasharray': '3 3', opacity: 0.6 }));
  const ku = svg('text', { x: Math.min(Math.max(x(keyUp) + 3, 96), w - 32), y: 9, class: 'g-t ku' });
  ku.textContent = 'key up';
  root.appendChild(ku);
  return root;
}

/*
 * How long the LFO window has to be to show what this LFO does.
 *
 * Shape, speed and delay all fit in one picture, but not in a fixed window.
 * Measured on the engine: speed runs from 0.06 Hz to 49 Hz, and at the top of
 * its range the delay does not even start fading in until 2.7 s and is not
 * fully in until 3.3 s - so a fixed 2.5 s window drew a long-delayed LFO as a
 * flat line, indistinguishable from none at all. The window stretches to take
 * in the whole fade-in with room after it, and to show a slow LFO at least
 * starting to turn, between 2.5 and 6 s, and says how long it is.
 */
function lfoWindow(u: Uint8Array, bps: number): number {
  const probe = new Lfo();
  probe.reset([137, 138, 139, 140, 141, 142].map((i) => u[i]));
  probe.keydown();
  let full = 0;
  for (let b = 0; b < 4 * bps; b++) {
    if (probe.getdelay() >= Q24 * 0.999) {
      full = b / bps;
      break;
    }
  }
  const hz = lfoSource[u[P.lfoSpeed]] ?? 1;
  return Math.min(6, Math.max(2.5, full * 1.5, 1.5 / hz));
}

/** The LFO as the engine runs it from a key press: waveform times fade-in. */
function lfoPlot(u: Uint8Array): SVGSVGElement {
  const w = 300;
  const h = 44;
  const pad = { l: 4, r: 4, t: 12, b: 4 };
  const plotW = w - pad.l - pad.r;
  const plotH = h - pad.t - pad.b;
  const mid = pad.t + plotH / 2;
  const root = svg('svg', { viewBox: `0 0 ${w} ${h}`, class: 'g-plot' });
  root.appendChild(svg('rect', { x: pad.l, y: pad.t, width: plotW, height: plotH, rx: 3, fill: 'var(--bg)', stroke: 'var(--raise-2)' }));

  const bps = blocksPerSecond();
  const seconds = lfoWindow(u, bps);
  const lfo = new Lfo();
  lfo.reset([137, 138, 139, 140, 141, 142].map((i) => u[i]));
  lfo.keydown();
  const total = Math.round(seconds * bps);
  /*
   * Drawn as a band, the lowest and highest value in each column, rather than
   * as a line through samples: at the fast end the LFO does dozens of cycles
   * in the window, and a line would alias into a pattern that is not there. A
   * band reads correctly as fast, and at slow speeds it closes up into the
   * waveform itself.
   */
  const cols = 150;
  const lo = new Array(cols).fill(Infinity);
  const hi = new Array(cols).fill(-Infinity);
  for (let b = 0; b < total; b++) {
    const v = (lfo.getsample() / Q24 - 0.5) * (lfo.getdelay() / Q24);
    const c = Math.min(cols - 1, Math.floor((b / total) * cols));
    if (v < lo[c]) lo[c] = v;
    if (v > hi[c]) hi[c] = v;
  }
  const x = (c: number) => pad.l + ((c + 0.5) / cols) * plotW;
  const y = (v: number) => mid - v * 2 * (plotH / 2 - 1);
  const top = hi.map((v, c) => `${c ? 'L' : 'M'}${x(c).toFixed(1)} ${y(v).toFixed(1)}`).join(' ');
  const bottom = lo.map((v, c) => `L${x(cols - 1 - c).toFixed(1)} ${y(lo[cols - 1 - c]).toFixed(1)}`).join(' ');
  root.appendChild(svg('path', { d: `${top} ${bottom} Z`, fill: 'var(--accent)', opacity: 0.35 }));
  root.appendChild(svg('path', { d: top, fill: 'none', stroke: 'var(--accent)', 'stroke-width': 1.4, 'stroke-linejoin': 'round' }));

  const hz = lfoSource[u[P.lfoSpeed]] ?? 0;
  const label = svg('text', { x: pad.l, y: 9, class: 'g-t' });
  label.textContent = `${WAVES[u[P.lfoWaveform]] ?? 'wave'}  ·  ${hz < 10 ? hz.toFixed(2) : hz.toFixed(1)} Hz`
    + (u[P.lfoDelay] ? `  ·  fades in` : '')
    + `  ·  ${u[P.lfoKeySync] ? 'restarts per note' : 'free'}`;
  root.appendChild(label);
  // The window varies, so it says how long it is.
  const span = svg('text', { x: w - pad.r, y: 9, class: 'g-t', 'text-anchor': 'end' });
  span.textContent = `${seconds.toFixed(1)} s`;
  root.appendChild(span);
  return root;
}

/** A horizontal meter, `value` out of `max`, dimmed at zero. */
function meter(label: string, value: number, max: number, title: string, unreachable = false): HTMLElement {
  return el('span', { class: value === 0 || unreachable ? 'g-meter rest' : 'g-meter', title },
    el('span', { class: 'g-meter-k' }, label),
    el('span', { class: 'g-meter-bar' }, el('i', { style: { width: `${(value / max) * 100}%` } })),
    el('span', { class: 'g-meter-v' }, String(value)));
}

/*
 * Which operators the tremolo reaches.
 *
 * Taken from the operators, because it is theirs: the LFO's amp depth is one
 * number for the patch, but only operators with amp mod sensitivity hear it,
 * and how much each hears is that operator's setting. Six small cells, filled
 * to each one's sensitivity, say where the wobble lands.
 */
function amsCells(u: Uint8Array): HTMLElement {
  const cells = [0, 1, 2, 3, 4, 5].map((op) => {
    const ams = u[P.opAmpModSens(op)] & 3;
    return el('span', {
      class: ams === 0 ? 'g-ams rest' : 'g-ams',
      title: `operator ${op + 1}: amp mod sensitivity ${ams} of 3`,
    }, el('i', { style: { height: `${(ams / 3) * 100}%` } }), el('b', {}, String(op + 1)));
  });
  return el('span', { class: 'g-ams-row', title: 'Which operators the tremolo reaches, and how strongly' },
    el('span', { class: 'g-meter-k' }, 'reach'), ...cells);
}

/** Transpose as a position on a ruler of octaves, centred on the note played. */
function transposeRuler(semitones: number): HTMLElement {
  const pct = ((semitones + 24) / 48) * 100;
  return el('span', { class: semitones === 0 ? 'g-ruler rest' : 'g-ruler', title: `${semitones} semitones from C3` },
    el('span', { class: 'g-ruler-track' },
      ...[-24, -12, 0, 12, 24].map((s) => el('i', { class: s === 0 ? 'mid' : '', style: { left: `${((s + 24) / 48) * 100}%` } })),
      el('b', { style: { left: `${pct}%` } })),
    el('span', { class: 'g-meter-v' }, semitones === 0 ? '0' : `${semitones > 0 ? '+' : '−'}${Math.abs(semitones)} st`));
}

function row(label: string, resting: boolean, ...content: Array<Node | null>): HTMLElement {
  return el('div', { class: resting ? 'g-row rest' : 'g-row' },
    el('span', { class: 'g-key' }, label),
    el('div', { class: 'g-body' }, ...content));
}

export function globalsPanel(u: Uint8Array): HTMLElement {
  const levels = [0, 1, 2, 3].map((i) => u[P.pitchEgLevel(i)]);
  const flat = levels.every((l) => l === PITCH_EG_CENTRE);
  const pmd = u[P.lfoPmDepth];
  const amd = u[P.lfoAmDepth];
  const pms = u[P.pitchModSens];
  let anyAms = false;
  for (let op = 0; op < 6; op++) if ((u[P.opAmpModSens(op)] & 3) > 0) anyAms = true;
  // Nothing reaches the sound from the LFO without pitch mod sensitivity or
  // some operator's amp mod sensitivity, however deep it is set.
  const lfoInert = pms === 0 && !anyAms;
  const transpose = u[P.transpose] - TRANSPOSE_CENTRE;
  const oscSync = u[P.oscKeySync] !== 0;

  return el('div', { class: 'g-panel' },
    row('pitch EG', flat, pitchEnvPlot(u, flat)),
    row('LFO', lfoInert,
      lfoPlot(u),
      el('div', { class: 'g-meters' },
        // Each depth is dimmed when nothing can hear it: vibrato needs pitch
        // sensitivity, tremolo needs an operator that it reaches.
        meter('pitch', pmd, 99, 'LFO pitch depth - vibrato', pms === 0),
        meter('sens', pms, 7, 'pitch mod sensitivity: how much the LFO and the mod wheel move the pitch'),
        meter('amp', amd, 99, 'LFO amp depth - tremolo', !anyAms),
        amsCells(u))),
    row('transpose', transpose === 0, transposeRuler(transpose)),
    row('osc sync', !oscSync,
      el('span', {
        class: oscSync ? 'g-check on' : 'g-check',
        title: 'Restarts every oscillator at the same phase on each note, so the attack is identical every time',
      })),
  );
}
