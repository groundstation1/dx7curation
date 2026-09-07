/*
 * Colour in OkLCH, converted to sRGB here rather than handed to the browser.
 *
 * HSL is not perceptually uniform: at a fixed lightness, yellow is far brighter
 * to the eye than blue, so a palette built by rotating hue at constant L comes
 * out with some entries shouting and others disappearing. On a scatter of
 * twenty thousand translucent dots that is not a cosmetic problem - it makes
 * whichever category happened to land on yellow look denser than it is.
 *
 * OkLCH fixes that: its L really is perceived lightness, so rotating hue leaves
 * every colour equally prominent. The conversion is done in JS instead of using
 * the CSS oklch() function because these colours are also used as canvas
 * fillStyles, and a canvas silently ignores a colour string it cannot parse -
 * which would fail invisibly on any browser a step behind.
 */

function gamma(x: number): number {
  return x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
}

const clamp255 = (x: number) => Math.max(0, Math.min(255, Math.round(x * 255)));

/**
 * OkLCH to an sRGB string.
 *
 * @param l perceived lightness, 0 to 1
 * @param c chroma; roughly 0 to 0.37 before it leaves the sRGB gamut
 * @param h hue in degrees
 */
export function oklch(l: number, c: number, h: number, alpha = 1): string {
  const rad = (h * Math.PI) / 180;
  const a = c * Math.cos(rad);
  const b = c * Math.sin(rad);

  const lp = l + 0.3963377774 * a + 0.2158037573 * b;
  const mp = l - 0.1055613458 * a - 0.0638541728 * b;
  const sp = l - 0.0894841775 * a - 1.291485548 * b;

  const L = lp * lp * lp;
  const M = mp * mp * mp;
  const S = sp * sp * sp;

  const r = gamma(4.0767416621 * L - 3.3077115913 * M + 0.2309699292 * S);
  const g = gamma(-1.2684380046 * L + 2.6097574011 * M - 0.3413193965 * S);
  const bl = gamma(-0.0041960863 * L - 0.7034186147 * M + 1.707614701 * S);

  return alpha >= 1
    ? `rgb(${clamp255(r)} ${clamp255(g)} ${clamp255(bl)})`
    : `rgba(${clamp255(r)} ${clamp255(g)} ${clamp255(bl)} / ${alpha.toFixed(3)})`;
}

/**
 * Hues for the nine sound categories, spread evenly around the wheel.
 *
 * Spacing them evenly and giving them all the same lightness and chroma means
 * no category is visually louder than another, which matters because the map is
 * the main place the categoriser gets checked and a bias in the palette would
 * read as a bias in the data.
 */
export const CATEGORY_HUES: Record<string, number> = {
  keys: 258,
  bells: 310,
  plucked: 145,
  bass: 55,
  brass: 25,
  lead: 340,
  organ: 225,
  strings: 185,
  abstract: 95,
};

/** Lightness and chroma every category colour shares. */
export const CATEGORY_L = 0.72;
export const CATEGORY_C = 0.14;

export function categoryColour(category: string): string {
  const h = CATEGORY_HUES[category];
  if (h === undefined) return oklch(0.62, 0.01, 0);
  return oklch(CATEGORY_L, CATEGORY_C, h);
}

/**
 * A subcategory colour: same lightness, rotated away from its parent's hue.
 *
 * `spread` is how far around the wheel the family is allowed to wander. Wide
 * enough that three or four of them separate by eye, narrow enough that the
 * family still hangs together.
 */
export function subcategoryColour(category: string, index: number, count: number, spread = 110): string {
  const base = CATEGORY_HUES[category] ?? 0;
  const n = Math.max(1, count);
  const hue = base + (index - (n - 1) / 2) * (spread / n);
  return oklch(CATEGORY_L, CATEGORY_C + (index % 2 === 0 ? 0.02 : -0.02), hue);
}

/** Distinct hues for when one category is focused and only its parts are shown. */
export function focusedSubcategoryColour(index: number): string {
  const hues = [258, 55, 145, 340, 190, 25];
  return oklch(0.74, 0.15, hues[index % hues.length]);
}

/** Ratings, from bad to good, at constant lightness. */
export function ratingColour(rating: number): string {
  if (rating <= 0) return oklch(0.42, 0.01, 0);
  const hues = [28, 55, 90, 130, 150];
  return oklch(0.72, 0.14, hues[Math.max(1, Math.min(5, rating)) - 1]);
}
