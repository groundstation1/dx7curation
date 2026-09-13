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
  // Room at the edges for the feedback badge, which sits outside the top-right
  // corner of whichever operator carries the loop.
  const pad = v ? 15 : 10;
  // A loop spanning two operators is routed outside the column and carries its
  // number further out still, so that side needs more room than the badge does.
  // Without it the number simply fell off the edge of the viewBox.
  const routed = g.feedback.length > 1 && g.feedback[0] !== g.feedback[g.feedback.length - 1];
  const padX = pad + (routed ? gapX + 12 : 0);

  const stepX = box + gapX;
  const stepY = box + gapY;
  const width = padX * 2 + Math.max(stepX, g.width * stepX - gapX);
  const height = pad * 2 + g.height * stepY - gapY;

  // No fixed width or height: the CSS scales it to whatever space it is given,
  // which matters because algorithm 32 is six boxes wide and the panel is not.
  const root = svg('svg', {
    viewBox: `0 0 ${width} ${height}`,
    preserveAspectRatio: 'xMidYMid meet',
    role: 'img',
    'aria-label': `DX7 algorithm ${g.algorithm + 1}`,
  });

  const xOf = (column: number) => padX + column * stepX + box / 2;
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
    // How hard, not just whether. Feedback is 0 to 7 and the difference between
    // 0 and 7 is the difference between a sine and a sawtooth-ish scream, so
    // drawing every algorithm's loop identically hid the single parameter that
    // decides what the patch sounds like. At 0 the loop is a ghost - the
    // routing exists, nothing is going through it - and it thickens and
    // brightens from there.
    const amount = v ? v[P.feedback] & 7 : 7;
    const strength = amount / 7;
    const loopWidth = 1.2 + 2 * strength;
    const loopOpacity = v ? 0.2 + 0.8 * strength : 1;
    const dash = v && amount === 0 ? '2 2' : '';

    const top = byOp.get(g.feedback[0]);
    const bottom = byOp.get(g.feedback[g.feedback.length - 1]);
    if (top && bottom && top.op === bottom.op) {
      /*
       * The curl is a fraction of the box, not a fixed eight pixels.
       *
       * Every other measurement here scales with `box`, so a constant radius
       * meant the loop was proportionally whatever the caller's size happened
       * to make it - a third of a box on screen and a fifth of one on the
       * printed sheet, which draws it at forty. The fractions are chosen to
       * land on the old numbers at the default box of 26, so the app's own
       * diagrams are where they were.
       */
      const inset = box * 0.077;
      const cx = xOf(top.column) + box / 2 - inset;
      const cy = yOf(top.depth) - box / 2 + inset;
      const r = box * 0.31;
      root.appendChild(svg('path', {
        d: `M ${cx - r} ${cy} A ${r} ${r} 0 1 1 ${cx} ${cy + r}`,
        fill: 'none',
        stroke: 'var(--accent-2)',
        'stroke-width': loopWidth,
        'stroke-linecap': 'round',
        'stroke-dasharray': dash,
        opacity: loopOpacity,
      }));
      root.appendChild(svg('path', {
        d: `M ${cx - r * 0.53} ${cy + r - r * 0.43} L ${cx} ${cy + r} L ${cx - r * 0.53} ${cy + r + r * 0.43}`,
        fill: 'none',
        stroke: 'var(--accent-2)',
        'stroke-width': loopWidth,
        'stroke-linecap': 'round',
        'stroke-linejoin': 'round',
        opacity: loopOpacity,
      }));
      if (v) {
        // A badge rather than loose text: the curl passes through wherever the
        // number would naturally sit, and a digit lying across a stroke of the
        // same colour is unreadable. A filled disc occludes the arc instead,
        // which reads as a label attached to the loop.
        const br = Math.max(5, box * 0.14);
        const bx = cx + br + 2.5;
        const by = cy - br - 2.5;
        root.appendChild(svg('circle', {
          cx: bx, cy: by, r: br,
          fill: 'var(--surface)', stroke: 'var(--accent-2)',
          'stroke-width': 0.9, opacity: amount === 0 ? 0.45 : 0.95,
        }));
        const label = svg('text', {
          x: bx, y: by + br * 0.36, 'text-anchor': 'middle',
          'font-size': br * 1.35,
          fill: 'var(--accent-2)', opacity: amount === 0 ? 0.5 : 1,
        });
        label.textContent = String(amount);
        root.appendChild(label);
      }
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
        'stroke-width': loopWidth * 0.85,
        'stroke-linejoin': 'round',
        'stroke-dasharray': dash,
        opacity: loopOpacity,
      }));
      root.appendChild(svg('path', {
        d: `M ${edge + tip} ${yTop + 2} L ${edge} ${yTop + 5} L ${edge + tip} ${yTop + 8}`,
        fill: 'none',
        stroke: 'var(--accent-2)',
        'stroke-width': loopWidth * 0.85,
        'stroke-linecap': 'round',
        'stroke-linejoin': 'round',
        opacity: loopOpacity,
      }));
      if (v) {
        const label = svg('text', {
          x: out + (goRight ? 2 : -2), y: (yTop + yBottom) / 2,
          'text-anchor': goRight ? 'start' : 'end',
          'font-size': Math.max(7, box * 0.2),
          fill: 'var(--accent-2)', opacity: amount === 0 ? 0.4 : 0.9,
        });
        label.textContent = String(amount);
        root.appendChild(label);
      }
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
        fill: n.carrier ? 'var(--accent)' : 'var(--raise)',
        stroke: n.carrier ? 'var(--accent)' : 'var(--raise-2)',
        'stroke-width': 1.4,
      }));
      const label = svg('text', {
        x: x + box / 2, y: y + box / 2,
        'text-anchor': 'middle', 'dominant-baseline': 'central',
        'font-size': Math.round(box * 0.5), 'font-weight': '600',
        // A variable rather than the literal it was, so a stylesheet that
        // repaints this diagram - the printed cheat sheet turns it black on
        // white - can keep the carrier numbers legible against whatever the
        // carrier fill has become.
        fill: n.carrier ? 'var(--on-accent)' : 'var(--text)',
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
      stroke: silent ? 'var(--raise-2)' : rim,
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

/**
 * The operator's envelope, drawn large enough to read the shape off.
 *
 * Eight numbers in a grid is the front panel's way of describing an envelope,
 * and it is the wrong way round for recognising one: what tells you whether an
 * operator is a click, a swell or a drone is the shape, which the numbers only
 * imply. The plot uses the engine's own stage timings, compressed by a square
 * root so a slow release cannot squeeze the attack down to nothing, and the
 * whole curve is scaled by the output level - so a modulator at level 20 is
 * visibly a low ceiling rather than the same picture with a different caption.
 */
function envelopePlot(v: Uint8Array, op: number, colour: string, w = 252, h = 108): SVGSVGElement {
  const rates = [0, 1, 2, 3].map((i) => v[P.opRate(op, i)]);
  const levels = [0, 1, 2, 3].map((i) => v[P.opLevel(op, i)]);
  const level = v[P.opOutputLevel(op)];
  const times = stageTimes(rates, levels, levels[3]);
  const widths = times.map((t) => Math.sqrt(Math.max(t, 1)));
  const sustain = Math.max(...widths, 1) * 0.55;
  const total = widths[0] + widths[1] + widths[2] + sustain + widths[3];

  const padL = 6;
  const padR = 15;
  const padT = 15;
  const padB = 18;
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;
  const squash = scaleOutLevel(level) / 127;
  const lv = (l: number) => padT + plotH * (1 - (scaleOutLevel(l) / 127) * squash);
  const floor = padT + plotH;

  const root = svg('svg', { viewBox: `0 0 ${w} ${h}`, class: 'op-env' });
  root.appendChild(svg('rect', {
    x: padL, y: padT, width: plotW, height: plotH, rx: 3,
    fill: 'var(--bg)', stroke: 'var(--raise-2)',
  }));
  // The ceiling a level-99 operator would reach, so the squash reads as one.
  root.appendChild(svg('line', {
    x1: padL, y1: padT, x2: padL + plotW, y2: padT,
    stroke: 'var(--muted)', 'stroke-dasharray': '2 3', opacity: 0.35,
  }));

  const xs: number[] = [padL];
  const ys: number[] = [lv(levels[3])];
  let cx = padL;
  for (let i = 0; i < 3; i++) {
    cx += (widths[i] / total) * plotW;
    xs.push(cx);
    ys.push(lv(levels[i]));
  }
  cx += (sustain / total) * plotW;
  xs.push(cx);
  ys.push(lv(levels[2]));
  cx += (widths[3] / total) * plotW;
  xs.push(cx);
  ys.push(lv(levels[3]));

  // Stage boundaries as guides: where the corners are is the rate, read off the
  // horizontal, and dropping a line to the floor makes that spacing visible.
  for (const i of [1, 2, 3, 5]) {
    root.appendChild(svg('line', {
      x1: xs[i], y1: ys[i], x2: xs[i], y2: floor,
      stroke: 'var(--raise-2)', 'stroke-width': 1, opacity: 0.8,
    }));
  }

  const d = xs.map((x, i) => `${i ? 'L' : 'M'} ${x.toFixed(1)} ${ys[i].toFixed(1)}`).join(' ');
  root.appendChild(svg('path', {
    d: `${d} L ${xs[5].toFixed(1)} ${floor} L ${padL} ${floor} Z`,
    fill: colour, opacity: 0.22,
  }));
  root.appendChild(svg('path', {
    d, fill: 'none', stroke: colour, 'stroke-width': 2, 'stroke-linejoin': 'round',
  }));

  // Key up: everything to its left happens while the note is held.
  root.appendChild(svg('line', {
    x1: xs[4], y1: padT, x2: xs[4], y2: floor,
    stroke: 'var(--accent-2)', 'stroke-dasharray': '3 3', opacity: 0.65,
  }));
  const keyup = svg('text', {
    x: Math.min(Math.max(xs[4], padL + 16), padL + plotW - 16), y: h - 5,
    'text-anchor': 'middle', class: 'op-t', fill: 'var(--accent-2)',
  });
  keyup.textContent = 'key up';
  root.appendChild(keyup);

  for (const i of [1, 2, 3, 5]) {
    root.appendChild(svg('circle', {
      cx: xs[i], cy: ys[i], r: 3, fill: colour, stroke: 'var(--surface)', 'stroke-width': 1.4,
    }));
  }

  // Output level as a meter up the right edge, on the curve's own scale.
  const bx = w - 7;
  root.appendChild(svg('line', {
    x1: bx, y1: padT, x2: bx, y2: floor,
    stroke: 'var(--raise)', 'stroke-width': 5, 'stroke-linecap': 'round',
  }));
  if (level > 0) {
    root.appendChild(svg('line', {
      x1: bx, y1: padT + plotH * (1 - squash), x2: bx, y2: floor,
      stroke: colour, 'stroke-width': 5, 'stroke-linecap': 'round',
    }));
  }
  // Above the plot, not below it: at long sustains the key-up label sits hard
  // against the right edge and the two would collide.
  const out = svg('text', { x: w - 2, y: padT - 3, 'text-anchor': 'end', class: 'op-t' });
  out.textContent = `out ${level}`;
  root.appendChild(out);
  return root;
}

/**
 * Two pitch pictures: where the operator sits in the harmonic series, and how
 * far off it is detuned.
 *
 * "Ratio 3.00" is a number you have to interpret; a mark standing on the third
 * harmonic is the thing itself, and a mark between two of them is instantly the
 * inharmonic one. Detune is about a cent a step, invisible against a range that
 * spans six octaves, so it gets its own gauge underneath rather than nudging
 * the mark by a pixel nobody can see.
 */
function pitchRuler(ratio: number, fixed: boolean, detune: number, colour: string, w = 252, h = 80): SVGSVGElement {
  const root = svg('svg', { viewBox: `0 0 ${w} ${h}`, class: 'op-ruler' });
  const padL = 10;
  const plotW = w - padL * 2;
  const y = 32;
  const pos = (r: number) => padL + ((Math.log2(Math.max(r, 0.05)) + 1) / 6) * plotW;

  root.appendChild(svg('line', {
    x1: padL, y1: y, x2: padL + plotW, y2: y, stroke: 'var(--raise-2)', 'stroke-width': 2,
  }));
  for (const r of [3, 5, 6, 7, 10, 12, 14, 20, 24, 28]) {
    root.appendChild(svg('line', { x1: pos(r), y1: y - 3, x2: pos(r), y2: y + 3, stroke: 'var(--raise-2)', 'stroke-width': 1.5 }));
  }
  for (const [r, label] of [[0.5, '\u00bd'], [1, '1'], [2, '2'], [4, '4'], [8, '8'], [16, '16'], [32, '32']] as const) {
    const x = pos(r);
    root.appendChild(svg('line', { x1: x, y1: y - 5.5, x2: x, y2: y + 5.5, stroke: 'var(--muted)', 'stroke-width': 1.5, opacity: 0.7 }));
    const t = svg('text', { x, y: y + 17, 'text-anchor': 'middle', class: 'op-t' });
    t.textContent = label;
    root.appendChild(t);
  }

  const x = pos(ratio);
  root.appendChild(svg('path', {
    d: `M ${x - 6} ${y - 14} L ${x + 6} ${y - 14} L ${x} ${y - 4} Z`,
    fill: fixed ? 'var(--bg)' : colour, stroke: colour, 'stroke-width': 1.5, 'stroke-linejoin': 'round',
  }));
  const mark = svg('text', {
    x: Math.min(Math.max(x, 20), w - 20), y: y - 20, 'text-anchor': 'middle', class: 'op-mark',
  });
  mark.setAttribute('fill', colour);
  mark.textContent = fixed ? `${(ratio * 261.63).toFixed(1)} Hz fixed` : `\u00d7 ${ratio.toFixed(2)}`;
  root.appendChild(mark);

  // ---- detune ----
  const dy = h - 13;
  const half = 46;
  const cxx = w / 2;
  root.appendChild(svg('line', {
    x1: cxx - half, y1: dy, x2: cxx + half, y2: dy, stroke: 'var(--raise-2)', 'stroke-width': 2, 'stroke-linecap': 'round',
  }));
  root.appendChild(svg('line', { x1: cxx, y1: dy - 5, x2: cxx, y2: dy + 5, stroke: 'var(--muted)', 'stroke-width': 1.5 }));
  const needle = cxx + (detune / 7) * half;
  root.appendChild(svg('circle', {
    cx: needle, cy: dy, r: 4, fill: detune === 0 ? 'var(--muted)' : 'var(--accent-2)',
    stroke: 'var(--surface)', 'stroke-width': 1.4,
  }));
  if (detune !== 0) {
    root.appendChild(svg('line', {
      x1: cxx, y1: dy, x2: needle, y2: dy, stroke: 'var(--accent-2)', 'stroke-width': 2.5, 'stroke-linecap': 'round',
    }));
  }
  const dl = svg('text', { x: cxx - half - 6, y: dy + 4, 'text-anchor': 'end', class: 'op-t' });
  dl.textContent = 'detune';
  root.appendChild(dl);
  const dv = svg('text', { x: cxx + half + 6, y: dy + 4, class: 'op-t' });
  if (detune !== 0) dv.setAttribute('fill', 'var(--accent-2)');
  dv.textContent = detune === 0
    ? 'centred'
    : `${detune > 0 ? '+' : ''}${(detune * CENTS_PER_DETUNE).toFixed(1)}\u2009cents`;
  root.appendChild(dv);
  return root;
}

/** Exported so `preview-opcard.html` can render the cards without hovering. */
export function operatorCard(v: Uint8Array, op: number, carrier: boolean, feedback: boolean): HTMLElement {
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
    fb.textContent = `feedback ${v[P.feedback] & 7}`;
    head.appendChild(fb);
  }
  card.appendChild(head);

  card.appendChild(envelopePlot(v, op, colour));
  card.appendChild(pitchRuler(ratio, fixed, detune, colour));
  return card;
}

/**
 * One hover card for the whole application.
 *
 * It has to live outside the diagram - fixed to the viewport, so it never
 * covers the picture it describes and no scrolling sidebar can clip it - and
 * anything outside the diagram outlives the diagram. A card per panel meant a
 * panel could be re-rendered mid-hover, taking its operator cells with it, and
 * the pointerleave that would have hidden the card never arrived: a tooltip
 * stuck to the screen with nothing under it. One shared card can always be
 * found and hidden, whatever happened to the thing that opened it.
 */
let tipEl: HTMLElement | null = null;
let tipOwner: Element | null = null;

function tip(): HTMLElement {
  if (tipEl) return tipEl;
  tipEl = document.createElement('div');
  tipEl.className = 'op-tip';
  tipEl.hidden = true;
  document.body.appendChild(tipEl);

  // The backstops. pointerleave on the cell handles the ordinary case; these
  // catch every way of leaving it that does not produce one - the panel being
  // re-rendered, the pointer jumping, a scroll, the window losing focus.
  document.addEventListener('pointermove', (e) => {
    if (!tipOwner) return;
    const over = (e.target as Element | null)?.closest?.('.op-cell');
    if (over !== tipOwner) hideTip();
  }, true);
  window.addEventListener('scroll', hideTip, true);
  window.addEventListener('blur', hideTip);
  return tipEl;
}

function hideTip(): void {
  tipOwner = null;
  if (tipEl) tipEl.hidden = true;
}

/** Place the card outside `host`: left of it by preference, else right, else above. */
function placeTip(el: HTMLElement, cell: Element, host: DOMRect): void {
  const box = cell.getBoundingClientRect();
  const gap = 12;
  const w = el.offsetWidth;
  const h = el.offsetHeight;

  let left = host.left - gap - w;
  if (left < 6) {
    const right = host.right + gap;
    left = right + w <= window.innerWidth - 6 ? right : Math.max(6, host.left);
  }
  let top = box.top - h / 2 + box.height / 2;
  if (left >= host.left && left <= host.right) top = host.top - gap - h;
  el.style.left = `${Math.round(Math.max(6, Math.min(window.innerWidth - w - 6, left)))}px`;
  el.style.top = `${Math.round(Math.max(6, Math.min(window.innerHeight - h - 6, top)))}px`;
}

/**
 * The diagram, with a hover card per operator.
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

  const g = algorithmGraph(algorithm);
  const byOp = new Map(g.nodes.map((n) => [n.op, n]));
  const feedbackOps = new Set(g.feedback);

  for (const cell of Array.from(diagram.querySelectorAll('.op-cell'))) {
    const op = Number(cell.getAttribute('data-op'));
    const node = byOp.get(op);
    if (!node) continue;
    cell.addEventListener('pointerenter', () => {
      if (!wrap.isConnected) return;
      const el = tip();
      el.replaceChildren(operatorCard(voice, op, node.carrier, feedbackOps.has(op)));
      el.hidden = false;
      tipOwner = cell;
      placeTip(el, cell, wrap.getBoundingClientRect());
    });
    cell.addEventListener('pointerleave', hideTip);
  }
  diagram.addEventListener('pointerleave', hideTip);

  return wrap;
}
