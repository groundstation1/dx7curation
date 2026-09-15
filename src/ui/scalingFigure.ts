/*
 * The four keyboard scaling curves, plotted from the function that runs them.
 *
 * Drawn by hand, this figure was wrong in a way that is easy to miss and hard
 * to unsee. Each curve was a single line passing through the break point and
 * out the other side - which is a picture of one *pairing* of left and right
 * curves, not of a curve type. `scaleCurve` takes a distance from the break
 * point and never a signed offset, so the two sides of `scaleLevel` hand it
 * the same magnitude and the sign comes from the curve alone:
 *
 *     right:  scaleCurve( (offset + 1) / 3, rightDepth, rightCurve)
 *     left:   scaleCurve(-(offset - 1) / 3, leftDepth,  leftCurve)
 *
 * So a + curve adds level as you move away from the break point in whichever
 * direction it was set, and a - curve takes it away. Set the same curve both
 * sides and the result is symmetric: a valley for the + curves, a hill for the
 * - ones. That is what this now draws, and it draws it by asking the engine
 * rather than by me deciding what it probably looks like.
 *
 * Returned as markup rather than as DOM, because both callers want a string:
 * the page builds it in a browser and the print tool bakes it in from Node.
 */
import { scaleCurve } from '../engine/dx7note.ts';

/** The table runs to 32 groups of three semitones: eight octaves either way. */
const GROUPS = 32;
const SEMITONES = GROUPS * 3;
/** Full deflection at depth 99, which both LIN and EXP reach by the last group. */
const FULL = 255;
const DEPTH = 99;

const BOX = { left: 16, right: 96, top: 6, bottom: 38 };
const MID_X = (BOX.left + BOX.right) / 2;
const MID_Y = (BOX.top + BOX.bottom) / 2;

const n2 = (v: number) => Math.round(v * 100) / 100;

/**
 * One curve, mirrored about the break point.
 *
 * Walked from the far left in to the centre and out to the far right, so it is
 * a single path and the symmetry is in the geometry rather than in two
 * elements that have to be kept in step.
 */
function curvePath(curve: number): string {
  const x = (semitones: number) =>
    MID_X + (semitones / SEMITONES) * ((BOX.right - BOX.left) / 2);
  const y = (value: number) =>
    MID_Y - (value / FULL) * ((BOX.bottom - BOX.top) / 2);

  const points: string[] = [];
  for (let g = GROUPS; g >= 0; g--) points.push(`${n2(x(-g * 3))} ${n2(y(scaleCurve(g, DEPTH, curve)))}`);
  for (let g = 1; g <= GROUPS; g++) points.push(`${n2(x(g * 3))} ${n2(y(scaleCurve(g, DEPTH, curve)))}`);
  return `M${points.join('L')}`;
}

const CURVES = [
  { curve: 3, label: '+LIN', cls: 'lin-plus' },
  { curve: 2, label: '+EXP', cls: 'exp-plus' },
  { curve: 1, label: '−EXP', cls: 'exp-minus' },
  { curve: 0, label: '−LIN', cls: 'lin-minus' },
];

export function scalingFigureSvg(): string {
  const parts: string[] = [];

  parts.push(`<path class="ln thin" d="M${BOX.left} ${BOX.top}H${BOX.right}V${BOX.bottom}H${BOX.left}Z"/>`);
  parts.push(`<path class="ln thin" d="M${BOX.left} ${MID_Y}H${BOX.right}"/>`);

  /*
   * An octave scale, because the distances here are fixed and worth knowing.
   *
   * A group is three semitones and the table runs to 32 of them, so the x axis
   * is exactly eight octaves either side of the break point - and most of that
   * is past the end of any DX7 keyboard. Without the scale the EXP curves look
   * like they bend somewhere in the middle; with it you can see that the bend
   * is four or five octaves out and that the part you can actually play is the
   * nearly-straight bit next to the break.
   *
   * Ticks on the axis rather than lines through the plot: the curves are the
   * content and eight verticals behind them read as a cage. It also says which
   * way the keyboard runs, which is what the words low and high were doing
   * before the numbers made them redundant.
   */
  const xOct = (oct: number) => MID_X + (oct / 8) * ((BOX.right - BOX.left) / 2);
  for (const oct of [-8, -6, -4, -2, 2, 4, 6, 8]) {
    parts.push(`<path class="grid" d="M${n2(xOct(oct))} ${BOX.bottom}v1.4"/>`);
    // Signed, because the two halves are not the same thing mirrored: left of
    // the break is the left depth and the left curve, right of it is the right
    // pair, and a bare 4 on both sides invites reading the axis as a distance
    // when it is a direction.
    const sign = oct < 0 ? '−' : '+';
    parts.push(`<text class="sm mid" x="${n2(xOct(oct))}" y="${BOX.bottom + 4.2}">${sign}${Math.abs(oct)}</text>`);
  }

  parts.push(`<path class="ln dash" d="M${MID_X} ${BOX.top}V${BOX.bottom}"/>`);

  for (const c of CURVES) parts.push(`<path class="ln ${c.cls}" d="${curvePath(c.curve)}"/>`);

  // Just the unit. What it is measured from is the dashed line it is written
  // under, and saying so again in six words made the caption the widest thing
  // on the tile.
  parts.push(`<text class="sm mid" x="${MID_X}" y="${BOX.bottom + 8.4}">octaves</text>`);
  parts.push(`<text class="sm end" x="${BOX.left - 2}" y="${BOX.top + 2.5}">louder</text>`);
  parts.push(`<text class="sm end" x="${BOX.left - 2}" y="${MID_Y + 1}">as set</text>`);
  parts.push(`<text class="sm end" x="${BOX.left - 2}" y="${BOX.bottom}">softer</text>`);

  // The four share a shape on each side, so only the line style tells them
  // apart and the key is the only place that can say which is which.
  const step = (BOX.right - BOX.left + 12) / CURVES.length;
  CURVES.forEach((c, i) => {
    const x = BOX.left - 10 + i * step;
    parts.push(`<path class="ln ${c.cls}" d="M${n2(x)} 50h7"/>`);
    parts.push(`<text class="sm" x="${n2(x + 9)}" y="51.3">${c.label}</text>`);
  });

  return `<svg class="fig" viewBox="0 0 100 53">${parts.join('')}</svg>`;
}
