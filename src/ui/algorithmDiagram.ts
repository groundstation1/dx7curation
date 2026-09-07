/*
 * Drawing a DX7 algorithm the way the front panel does - carriers along the
 * bottom, modulators stacked above, feedback marked with a loop - except that
 * each operator box is a small picture of what that operator is actually doing.
 *
 * Inside every box:
 *   - the envelope, drawn as the DX7's own four-stage shape, with segment
 *     widths from the engine's real rate timings
 *   - the whole curve squashed vertically by the operator's output level, so a
 *     quiet operator is visibly a quiet one
 *   - fill colour from the frequency ratio, so a patch's harmonic layout reads
 *     at a glance
 *   - a dot in the top right when the operator is in fixed-frequency mode
 *
 * Keyboard scaling, velocity sensitivity and amplitude modulation sensitivity
 * are deliberately left out: they depend on how the note is played rather than
 * on the patch alone, and drawing them would make every box busier without
 * making any of them clearer.
 */
import { algorithmGraph } from '../engine/algorithmGraph.ts';
import { scaleOutLevel } from '../engine/env.ts';
import { P } from '../sysex/voice.ts';
import { oklch } from './colour.ts';

const SVG_NS = 'http://www.w3.org/2000/svg';

function svg<K extends keyof SVGElementTagNameMap>(
  tag: K, attrs: Record<string, string | number> = {},
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
}

/**
 * How long each envelope stage takes, using the engine's own rate arithmetic.
 *
 * The level axis is the DX7's scaled level, which is close to linear in
 * decibels, and the increment per block is the same expression Env.advance
 * uses. Rising stages actually follow a different curve in the engine, but
 * their duration is the same order, and this is a 40-pixel glyph.
 */
function stageTimes(rates: number[], levels: number[], start: number): number[] {
  const a = (l: number) => (scaleOutLevel(Math.max(0, Math.min(99, l))) >> 1) << 6;
  const times: number[] = [];
  let from = a(start);
  for (let i = 0; i < 4; i++) {
    const to = a(levels[i]);
    const qrate = Math.min(63, (Math.max(0, Math.min(99, rates[i])) * 41) >> 6);
    const inc = (4 + (qrate & 3)) * Math.pow(2, 2 + 6 + (qrate >> 2));
    times.push(Math.abs(to - from) * 65536 / Math.max(1, inc));
    from = to;
  }
  return times;
}

/** Ratio of an operator, or its fixed frequency in Hz. */
function operatorPitch(v: Uint8Array, op: number): { ratio: number; fixed: boolean } {
  const coarse = v[P.opCoarse(op)];
  const fine = v[P.opFine(op)];
  if (v[P.opMode(op)] === 1) {
    return { ratio: Math.pow(10, (coarse & 3) + fine / 100) / 261.63, fixed: true };
  }
  return { ratio: (coarse === 0 ? 0.5 : coarse) * (1 + fine / 100), fixed: false };
}

/**
 * Hue from the frequency ratio: low ratios cool, high ratios warm, across the
 * DX7's 0.5 to 32 range. Note that this already includes the fine control,
 * since fine is part of the ratio - coarse 1 with fine 50 is a ratio of 1.5,
 * a fifth up, not a small detuning.
 */
function ratioHue(ratio: number): number {
  const t = Math.max(0, Math.min(1, (Math.log2(Math.max(ratio, 0.05)) + 1) / 6));
  return 265 - t * 225;
}

/** Fill colour: hue is the ratio, lightness only separates carrier from modulator. */
function fillColour(ratio: number, carrier: boolean): string {
  return oklch(carrier ? 0.74 : 0.63, 0.13, ratioHue(ratio));
}

/**
 * Outline colour: the same hue, rotated by the operator's detune.
 *
 * Detune here is the DX7's own detune parameter, 0 to 14 around a centre of 7,
 * which shifts the operator by about eight cents at the extremes. That is far
 * too small to change the interval - it is the chorusing control - so it gets a
 * rim rather than a fill: an operator at centre detune is rimmed in its own
 * colour, and a detuned one is visibly rimmed in a neighbouring one, with the
 * direction showing which way it is pulled. Two operators rimmed in opposite
 * directions is the recipe for that beating, thickened DX7 sound.
 */
function outlineColour(ratio: number, carrier: boolean, detune: number): string {
  const hue = ratioHue(ratio) + detune * 7;
  return oklch(carrier ? 0.8 : 0.72, detune === 0 ? 0.13 : 0.17, hue);
}

export interface DiagramOptions {
  /** Size of one operator box, in pixels of the viewBox. */
  box?: number;
  /** The voice to draw inside the boxes. Without it, plain numbered boxes. */
  voice?: Uint8Array;
}

export function algorithmDiagram(algorithm: number, opts: DiagramOptions = {}): SVGSVGElement {
  const g = algorithmGraph(algorithm);
  const v = opts.voice;
  const box = opts.box ?? (v ? 42 : 26);
  const gapX = v ? 13 : 12;
  const gapY = v ? 14 : 16;
  const pad = 10;

  const stepX = box + gapX;
  const stepY = box + gapY;
  const width = pad * 2 + Math.max(stepX, g.width * stepX - gapX);
  const height = pad * 2 + g.height * stepY - gapY;

  // No fixed width or height: the CSS scales it to whatever space it is given,
  // which matters because algorithm 32 is six boxes wide and the panel is not.
  const root = svg('svg', {
    viewBox: `0 0 ${width} ${height}`,
    preserveAspectRatio: 'xMidYMid meet',
    role: 'img',
    'aria-label': `DX7 algorithm ${g.algorithm + 1}`,
  });

  const xOf = (column: number) => pad + column * stepX + box / 2;
  const yOf = (depth: number) => pad + (g.height - 1 - depth) * stepY + box / 2;
  const byOp = new Map(g.nodes.map((n) => [n.op, n]));

  // ---- connections ----
  for (const e of g.edges) {
    const from = byOp.get(e.from);
    const to = byOp.get(e.to);
    if (!from || !to) continue;
    const x1 = xOf(from.column);
    const y1 = yOf(from.depth) + box / 2;
    const x2 = xOf(to.column);
    const y2 = yOf(to.depth) - box / 2;
    const mid = (y1 + y2) / 2;
    root.appendChild(svg('path', {
      d: `M ${x1} ${y1} L ${x1} ${mid} L ${x2} ${mid} L ${x2} ${y2}`,
      fill: 'none',
      stroke: 'var(--muted)',
      'stroke-width': 1.8,
      'stroke-linejoin': 'round',
      'stroke-linecap': 'round',
    }));
  }

  // ---- feedback loop ----
  //
  // Most algorithms feed a single operator back into itself, and routing that
  // as a bracket through the gap between boxes looked cramped and, worse,
  // ambiguous: squeezed into a nine-pixel gap it read as if it belonged to the
  // operator on the right. A single-operator loop is now a compact arrow curled
  // over the top-right corner of its own box, which cannot collide with
  // anything. Only the two algorithms whose loop genuinely spans two operators
  // need a routed path, and that one is pushed clear of the column.
  if (g.feedback.length) {
    const top = byOp.get(g.feedback[0]);
    const bottom = byOp.get(g.feedback[g.feedback.length - 1]);
    if (top && bottom && top.op === bottom.op) {
      const cx = xOf(top.column) + box / 2 - 2;
      const cy = yOf(top.depth) - box / 2 + 2;
      const r = 8;
      root.appendChild(svg('path', {
        d: `M ${cx - r} ${cy} A ${r} ${r} 0 1 1 ${cx} ${cy + r}`,
        fill: 'none',
        stroke: 'var(--accent-2)',
        'stroke-width': 1.9,
        'stroke-linecap': 'round',
      }));
      root.appendChild(svg('path', {
        d: `M ${cx - 4.2} ${cy + r - 3.4} L ${cx} ${cy + r} L ${cx - 4.2} ${cy + r + 3.4}`,
        fill: 'none',
        stroke: 'var(--accent-2)',
        'stroke-width': 1.9,
        'stroke-linecap': 'round',
        'stroke-linejoin': 'round',
      }));
    } else if (top && bottom) {
      // Two-operator loop: route it down the side with room, well clear of the
      // boxes rather than through the gap between columns.
      const rightmost = Math.max(...g.nodes.map((n) => n.column));
      const goRight = top.column >= rightmost - 0.01;
      const edge = goRight ? xOf(top.column) + box / 2 : xOf(top.column) - box / 2;
      const out = goRight ? edge + gapX * 0.75 : edge - gapX * 0.75;
      const yTop = yOf(top.depth) - box / 2;
      const yBottom = yOf(bottom.depth) + box / 2;
      const tip = goRight ? 5 : -5;
      root.appendChild(svg('path', {
        d: `M ${edge} ${yBottom - 5} L ${out} ${yBottom - 5} L ${out} ${yTop + 5} L ${edge} ${yTop + 5}`,
        fill: 'none',
        stroke: 'var(--accent-2)',
        'stroke-width': 1.5,
        'stroke-linejoin': 'round',
      }));
      root.appendChild(svg('path', {
        d: `M ${edge + tip} ${yTop + 2} L ${edge} ${yTop + 5} L ${edge + tip} ${yTop + 8}`,
        fill: 'none',
        stroke: 'var(--accent-2)',
        'stroke-width': 1.5,
        'stroke-linecap': 'round',
        'stroke-linejoin': 'round',
      }));
    }
  }

  // ---- operator boxes ----
  for (const n of g.nodes) {
    const x = xOf(n.column) - box / 2;
    const y = yOf(n.depth) - box / 2;
    // One group per operator. The tooltip used to be a <title> appended to the
    // root, which SVG treats as the title of the whole picture - hence a single
    // shared tooltip for all six.
    const cell = svg('g', { class: 'op-cell', 'data-op': String(n.op) });
    root.appendChild(cell);

    cell.appendChild(svg('rect', {
      x, y, width: box, height: box, rx: 4, fill: 'transparent',
      'pointer-events': 'all',
    }));

    if (!v) {
      cell.appendChild(svg('rect', {
        x, y, width: box, height: box, rx: 4,
        fill: n.carrier ? 'var(--accent)' : 'var(--panel-2)',
        stroke: n.carrier ? 'var(--accent)' : 'var(--line)',
        'stroke-width': 1.4,
      }));
      const label = svg('text', {
        x: x + box / 2, y: y + box / 2,
        'text-anchor': 'middle', 'dominant-baseline': 'central',
        'font-size': Math.round(box * 0.5), 'font-weight': '600',
        fill: n.carrier ? '#10131a' : 'var(--text)',
      });
      label.textContent = String(n.label);
      cell.appendChild(label);
      continue;
    }

    const level = v[P.opOutputLevel(n.op)];
    const silent = level === 0;
    const { ratio, fixed } = operatorPitch(v, n.op);
    const detune = v[P.opDetune(n.op)] - 7;
    const colour = fillColour(ratio, n.carrier);
    const rim = outlineColour(ratio, n.carrier, detune);

    // An operator at output level 0 makes no sound at all, whatever its
    // envelope says, so its outline is dimmed and dashed rather than coloured.
    cell.appendChild(svg('rect', {
      x, y, width: box, height: box, rx: 4,
      fill: 'var(--bg)',
      stroke: silent ? 'var(--line)' : rim,
      'stroke-width': silent ? 1 : n.carrier ? 2.4 : 1.8,
      'stroke-dasharray': silent ? '3 3' : 'none',
      opacity: silent ? 0.45 : 1,
    }));

    // ---- the envelope ----
    const rates = [0, 1, 2, 3].map((i) => v[P.opRate(n.op, i)]);
    const levels = [0, 1, 2, 3].map((i) => v[P.opLevel(n.op, i)]);
    const times = stageTimes(rates, levels, levels[3]);
    // Square-rooted, so an instant stage is still visible next to a slow one.
    const widths = times.map((t) => Math.sqrt(Math.max(t, 1)));
    // A held sustain between the third and fourth stages, as on the panel.
    const sustainWidth = Math.max(...widths, 1) * 0.6;
    const totalW = widths[0] + widths[1] + widths[2] + sustainWidth + widths[3];

    const inset = 4;
    const plotX = x + inset;
    const plotY = y + inset;
    const plotW = box - inset * 2;
    const plotH = box - inset * 2;
    // Output level squashes the whole shape, in the DX7's own level scale.
    const squash = scaleOutLevel(level) / 127;
    const lv = (l: number) => plotY + plotH * (1 - (scaleOutLevel(l) / 127) * squash);

    // A faint line where level 99 would reach. Without it the vertical squash
    // has nothing to be read against, and "this operator is quiet" is only
    // visible by comparing boxes.
    if (!silent && squash < 0.97) {
      cell.appendChild(svg('line', {
        x1: plotX, y1: plotY, x2: plotX + plotW, y2: plotY,
        stroke: 'var(--muted)',
        'stroke-width': 0.8,
        'stroke-dasharray': '2 2',
        opacity: 0.4,
      }));
    }

    let cx = plotX;
    let d = `M ${cx.toFixed(2)} ${lv(levels[3]).toFixed(2)}`;
    for (let i = 0; i < 3; i++) {
      cx += (widths[i] / totalW) * plotW;
      d += ` L ${cx.toFixed(2)} ${lv(levels[i]).toFixed(2)}`;
    }
    cx += (sustainWidth / totalW) * plotW;
    d += ` L ${cx.toFixed(2)} ${lv(levels[2]).toFixed(2)}`;
    cx += (widths[3] / totalW) * plotW;
    d += ` L ${cx.toFixed(2)} ${lv(levels[3]).toFixed(2)}`;

    cell.appendChild(svg('path', {
      d: `${d} L ${cx.toFixed(2)} ${(plotY + plotH).toFixed(2)} L ${plotX.toFixed(2)} ${(plotY + plotH).toFixed(2)} Z`,
      fill: colour,
      opacity: silent ? 0.12 : 0.34,
    }));
    cell.appendChild(svg('path', {
      d,
      fill: 'none',
      stroke: colour,
      'stroke-width': 1.5,
      'stroke-linejoin': 'round',
      opacity: silent ? 0.35 : 1,
    }));

    // ---- fixed-frequency marker ----
    if (fixed) {
      cell.appendChild(svg('circle', {
        cx: x + box - 8, cy: y + 5.5, r: 2.4,
        fill: 'var(--accent-2)',
      }));
    }

    const label = svg('text', {
      x: x + 4, y: y + 4,
      'text-anchor': 'start', 'dominant-baseline': 'hanging',
      'font-size': Math.round(box * 0.26), 'font-weight': '700',
      fill: 'var(--text)',
      opacity: silent ? 0.45 : 0.85,
    });
    label.textContent = String(n.label);
    cell.appendChild(label);

  }

  return root;
}

// -------------------------------------------------------------- hover card

/**
 * Cents of pitch shift per step of the detune control, at middle C.
 *
 * Derived from the engine: detune scales logfreq by a factor that works out at
 * roughly a thousandth of an octave per step, so the full range of -7 to +7
 * spans about seventeen cents. Small enough to be a chorusing control rather
 * than a tuning one.
 */
const CENTS_PER_DETUNE = 1.2;

function bar(value: number, max: number, colour: string): HTMLElement {
  const track = document.createElement('div');
  track.className = 'op-bar';
  const fill = document.createElement('i');
  fill.style.width = `${Math.max(0, Math.min(1, value / max)) * 100}%`;
  fill.style.background = colour;
  track.appendChild(fill);
  return track;
}

function row(label: string, ...content: Array<Node | string>): HTMLElement {
  const r = document.createElement('div');
  r.className = 'op-row';
  const k = document.createElement('span');
  k.className = 'op-k';
  k.textContent = label;
  r.appendChild(k);
  const val = document.createElement('span');
  val.className = 'op-v';
  for (const c of content) val.append(c);
  r.appendChild(val);
  return r;
}

function operatorCard(v: Uint8Array, op: number, carrier: boolean, feedback: boolean): HTMLElement {
  const card = document.createElement('div');
  card.className = 'op-card';

  const { ratio, fixed } = operatorPitch(v, op);
  const detune = v[P.opDetune(op)] - 7;
  const level = v[P.opOutputLevel(op)];
  const colour = fillColour(ratio, carrier);
  const rim = outlineColour(ratio, carrier, detune);

  const head = document.createElement('div');
  head.className = 'op-head';
  const dot = document.createElement('i');
  dot.style.background = colour;
  dot.style.borderColor = rim;
  head.appendChild(dot);
  const name = document.createElement('b');
  name.textContent = `OP${6 - op}`;
  head.appendChild(name);
  const role = document.createElement('span');
  role.className = 'muted';
  role.textContent = level === 0 ? 'silent' : carrier ? 'carrier' : 'modulator';
  head.appendChild(role);
  if (feedback) {
    const fb = document.createElement('span');
    fb.className = 'op-fb';
    fb.textContent = 'feedback';
    head.appendChild(fb);
  }
  card.appendChild(head);

  card.appendChild(row('frequency', fixed
    ? `fixed ${(ratio * 261.63).toFixed(1)} Hz`
    : `ratio ${ratio.toFixed(2)}`));
  if (!fixed) {
    card.appendChild(row('coarse / fine', `${v[P.opCoarse(op)]} / ${v[P.opFine(op)]}`));
  }
  card.appendChild(row('detune',
    `${detune >= 0 ? '+' : ''}${detune}`,
    detune === 0 ? ' (centre)' : ` (about ${detune > 0 ? '+' : ''}${(detune * CENTS_PER_DETUNE).toFixed(1)} cents)`));
  card.appendChild(row('output level', bar(level, 99, colour), String(level)));

  const eg = document.createElement('div');
  eg.className = 'op-eg';
  const head2 = document.createElement('div');
  head2.className = 'op-eg-head';
  for (const t of ['', '1', '2', '3', '4']) {
    const c = document.createElement('span');
    c.textContent = t;
    head2.appendChild(c);
  }
  eg.appendChild(head2);
  for (const [label, get] of [
    ['rate', (i: number) => v[P.opRate(op, i)]],
    ['level', (i: number) => v[P.opLevel(op, i)]],
  ] as const) {
    const line = document.createElement('div');
    line.className = 'op-eg-line';
    const k = document.createElement('span');
    k.className = 'op-k';
    k.textContent = label;
    line.appendChild(k);
    for (let i = 0; i < 4; i++) {
      const cellEl = document.createElement('span');
      cellEl.className = 'op-eg-cell';
      const b = bar(get(i), 99, label === 'rate' ? 'var(--muted)' : colour);
      cellEl.appendChild(b);
      const num = document.createElement('em');
      num.textContent = String(get(i));
      cellEl.appendChild(num);
      line.appendChild(cellEl);
    }
    eg.appendChild(line);
  }
  card.appendChild(eg);

  return card;
}

/**
 * The diagram plus a hover card per operator.
 *
 * The card appears immediately rather than after the browser's title-tooltip
 * delay, which matters when the point is to sweep across six operators and
 * compare them.
 */
export function algorithmPanel(algorithm: number, voice?: Uint8Array): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'algo-diagram';
  const diagram = algorithmDiagram(algorithm, { voice });
  wrap.appendChild(diagram);

  if (!voice) return wrap;

  const tip = document.createElement('div');
  tip.className = 'op-tip';
  tip.hidden = true;
  wrap.appendChild(tip);

  const g = algorithmGraph(algorithm);
  const byOp = new Map(g.nodes.map((n) => [n.op, n]));
  const feedbackOps = new Set(g.feedback);

  for (const cell of Array.from(diagram.querySelectorAll('.op-cell'))) {
    const op = Number(cell.getAttribute('data-op'));
    const node = byOp.get(op);
    if (!node) continue;
    cell.addEventListener('pointerenter', () => {
      tip.replaceChildren(operatorCard(voice, op, node.carrier, feedbackOps.has(op)));
      tip.hidden = false;
      const box = (cell as SVGGElement).getBoundingClientRect();
      const host = wrap.getBoundingClientRect();
      // Prefer the right of the operator, flipping when there is no room.
      const left = box.right - host.left + 10;
      tip.style.left = `${left + tip.offsetWidth > host.width ? Math.max(4, box.left - host.left - tip.offsetWidth - 10) : left}px`;
      tip.style.top = `${Math.max(4, Math.min(host.height - tip.offsetHeight - 4, box.top - host.top))}px`;
    });
    cell.addEventListener('pointerleave', () => {
      tip.hidden = true;
    });
  }

  return wrap;
}
