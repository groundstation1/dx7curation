/*
 * Map view.
 *
 * A scatter of the whole corpus where hovering is the primary interaction, not
 * clicking: sweeping the mouse across a region should let you hear the shape of
 * that region. Everything else - the axis pickers, the search, the colouring,
 * the lasso - exists to make that sweep land somewhere worth listening to.
 *
 * It doubles as the diagnostic for the clustering and the categoriser. If the
 * electric piano mass is not one blob, or a category is scattered everywhere,
 * that is visible here immediately rather than hidden inside a number.
 */
import { append, clear, el, fmtInt } from '../dom.ts';
import type { View, ViewContext } from '../app.ts';
import { FEATURE_DEFS, FEATURE_COUNT } from '../../features/vector.ts';
import { CATEGORIES, CATEGORY_LABELS, SUBCATEGORIES, subcategoryLabel, type Category } from '../../cluster/category.ts';
import { P } from '../../sysex/voice.ts';
import { algorithmPanel } from '../algorithmDiagram.ts';
import { voiceDetails } from '../voicePanel.ts';
import { sidebarSplitter } from '../splitter.ts';
import { createListView, sortIndices, type ListState, type ListView, type SortKey } from '../listView.ts';
import { categoryColour, focusedSubcategoryColour, oklch, ratingColour, subcategoryColour as subColour } from '../colour.ts';
import { DEMO_PHRASE, HOVER_PHRASE, singleNotePhrase } from '../../engine/phrase.ts';
import { keyboard } from '../../audio/keyboard.ts';
import { matchesQuery, parseQuery, type SearchQuery } from '../search.ts';
import { getSetting, setSetting } from '../settings.ts';
import { blendWeights, dominantAlgorithm, interpolateVoices, inverseDistanceWeights, voiceHash, type InterpolationResult } from '../../engine/interpolate.ts';

type AxisId = string;

interface Axis {
  id: AxisId;
  label: string;
  value: (i: number) => number;
}

/**
 * Every category at the same perceived lightness and chroma, evenly spaced
 * around the hue wheel. See colour.ts for why that is not the same thing as
 * picking nine hex values that look nice individually.
 */
const CATEGORY_COLOURS: Record<Category, string> = Object.fromEntries(
  CATEGORIES.map((c) => [c, categoryColour(c)]),
) as Record<Category, string>;

/**
 * Subcategory colour.
 *
 * The first attempt kept every subcategory as a lightness variation of its
 * parent, on the theory that the keys blob should still read as one blob. In
 * practice they all just looked like the same blue and the colouring told you
 * nothing. So: when a category is focused the subcategories get flatly
 * different hues, and when the whole corpus is shown they are rotated a long
 * way around the parent hue - at constant lightness, so none of them shouts
 * louder than the others.
 */
function subcategoryColour(category: Category, sub: string, focused = false): string {
  const defs = SUBCATEGORIES[category] ?? [];
  const found = defs.findIndex((d) => d.id === sub);
  const ix = found < 0 ? 0 : found;
  if (focused) return focusedSubcategoryColour(ix);
  return subColour(category, ix, Math.max(1, defs.length));
}

/**
 * Points overlap heavily at 26,000 voices, so everything is drawn translucent
 * and density reads as brightness. A solid dot would just paint a slab.
 */
const BASE_ALPHA = 0.28;
const DIMMED_ALPHA = 0.06;
const BASE_RADIUS = 3.4;
/** The range a size axis spans, in radius. */
const MIN_RADIUS = 1.8;
const MAX_RADIUS = 9;

/**
 * Dots are blitted from a pre-rendered sprite rather than drawn as arcs.
 *
 * Batching them into one path per colour and filling once was much faster, but
 * it destroyed the whole point of the translucency: a single fill of a path
 * containing overlapping circles paints the union at one alpha, so a hundred
 * stacked patches looked exactly like one. Blitting composites each dot
 * separately, so density reads as brightness again, and drawImage of a tiny
 * cached sprite is cheap enough to do 26,000 times a frame.
 */
const spriteCache = new Map<string, HTMLCanvasElement>();

function sprite(colour: string, radius: number, alpha: number, dpr: number): HTMLCanvasElement {
  const key = `${colour}|${radius}|${alpha}|${dpr}`;
  let c = spriteCache.get(key);
  if (!c) {
    const size = Math.ceil((radius + 1) * 2);
    c = document.createElement('canvas');
    c.width = Math.ceil(size * dpr);
    c.height = Math.ceil(size * dpr);
    const g = c.getContext('2d')!;
    g.scale(dpr, dpr);
    g.globalAlpha = alpha;
    g.fillStyle = colour;
    g.beginPath();
    g.arc(size / 2, size / 2, radius, 0, Math.PI * 2);
    g.fill();
    spriteCache.set(key, c);
  }
  return c;
}

let ctx: ViewContext;
let root: HTMLElement;
let canvas: HTMLCanvasElement;
let overlay: HTMLCanvasElement;
let sideEl: HTMLElement;
let controlsEl: HTMLElement;
let legendEl: HTMLElement;
let unsubscribe: (() => void) | null = null;

// viewport
let scale = 1;
let offsetX = 0;
let offsetY = 0;
let xs = new Float32Array(0);
let ys = new Float32Array(0);
let visible: number[] = [];
let hovered = -1;
let selected = -1;
/**
 * Scatter or table.
 *
 * The same voices, the same filters, the same sidebar - only the drawing
 * differs. The map answers "what lives over here"; the list answers "what have
 * I decided, and sorted by what".
 */
let mode: 'map' | 'list' = getSetting<'map' | 'list'>('map.mode', 'map');
let listEl: HTMLElement | null = null;
let list: ListView | null = null;
const listState: ListState = {
  sort: getSetting<SortKey>('map.listSort', 'rating'),
  descending: getSetting('map.listDescending', true),
};
let lassoPoints: Array<[number, number]> = [];
let lassoing = false;
let panning = false;
let panStart = [0, 0];
let lastAuditionAt = 0;
let lassoSelection: number[] = [];

// options
let xAxisId: AxisId = getSetting('map.xAxis', 'pca1');
let yAxisId: AxisId = getSetting('map.yAxis', 'pca2');
let colourBy: 'category' | 'subcategory' | 'rating' | 'predicted' | 'cluster' | 'source' | 'algorithm' =
  getSetting<'category' | 'subcategory' | 'rating' | 'predicted' | 'cluster' | 'source' | 'algorithm'>('map.colourBy', 'category');
/** Any axis can drive dot size as well; '' is a uniform dot. */
let sizeAxisId: AxisId | '' = getSetting<AxisId | ''>('map.sizeAxis', '');
let sizes = new Float32Array(0);
let collapseMerged = getSetting('map.collapseMerged', true);
/** Kept as a constant: the transport's play setting is the switch now. */
const hoverAudition = true;
let usePhrase = getSetting('audition.phrase', true);
let loopPhrase = getSetting('audition.loop', true);
let auditionNote = getSetting('audition.note', 60);
let auditionVel = getSetting('audition.velocity', 100);

// search
let query: SearchQuery = parseQuery('');
let searchText = '';
let searchScope: 'name' | 'all' = getSetting<'name' | 'all'>('map.searchScope', 'name');
let searchMode: 'highlight' | 'only' = getSetting<'highlight' | 'only'>('map.searchMode', 'highlight');
let snapToMatches = getSetting('map.snapToMatches', true);
/**
 * Category and subcategory focus. Folded into the same match set as the text
 * search, so the highlight/show-only and snap-to-results controls apply to it
 * without a second set of rules.
 */
let focusCategory: Category | '' = '';
let focusSub = '';
/**
 * The other thing worth narrowing to: what you have judged, and how well.
 * `'unrated'` is the untouched pile; a number is a floor, "this good or better".
 */
let focusRating: '' | 'unrated' | 1 | 2 | 3 | 4 | 5 = '';
let matched: Set<number> | null = null;

// interpolation
let interpolateMode = getSetting('map.interpolate', false);
/** Neighbours polled for the algorithm vote before the blend narrows down. */
let interpVotePool = 24;
/** Contributors to the blend once the algorithm is settled. */
let interpNeighbours = getSetting('map.interpNeighbours', 8);
let interpResult: InterpolationResult | null = null;
let interpAt: [number, number] | null = null;
let interpTimer: number | null = null;
let interpAlgorithmShare = 0;
/** Closer voices skipped for being on a different algorithm. */
let interpSkipped = 0;
/** Screen distance to the furthest contributor, and to the nearest voice at all. */
let interpReach = 0;
let interpNearest = 0;
/**
 * Clicking pins the blend where it is, so the mouse can leave the plot without
 * the sound changing under you - otherwise there is no way to reach the Keep
 * button, or to play the full phrase, without moving the cursor and blending
 * something else.
 */
let interpFrozen = false;
/**
 * How close the cursor has to be to a real patch for that patch to win over a
 * blend. Bigger than a dot, because you are aiming with a mouse at a cloud of
 * twenty thousand points and being made to hit one exactly is no fun.
 */
let interpSnapRadius = getSetting('map.snapRadius', 14);
/**
 * How sharply the blend favours the nearest contributor. 0 mixes them equally,
 * 1 is dominated by whatever is closest.
 */
let interpBias = 0.3;

/**
 * Hover retrigger floor. The phrase's opening note runs to 0.35 s with nothing
 * after it until 0.7 s, so at this spacing a sweep is a run of clean single
 * notes: long enough to judge, short enough to keep moving.
 */
const HOVER_INTERVAL_MS = 220;

// ------------------------------------------------------------------ axes

function axes(): Axis[] {
  const store = ctx.store;
  const list: Axis[] = [];
  if (store.projection) {
    const p = store.projection;
    const pct = (i: number) => ((store.pcaExplained[i] ?? 0) * 100).toFixed(0);
    list.push({ id: 'pca1', label: `variation axis 1 (${pct(0)}%)`, value: (i) => p[i * 2] });
    list.push({ id: 'pca2', label: `variation axis 2 (${pct(1)}%)`, value: (i) => p[i * 2 + 1] });
  }
  if (store.ldaProjection) {
    const p = store.ldaProjection;
    const pct = (i: number) => ((store.ldaExplained[i] ?? 0) * 100).toFixed(0);
    list.push({ id: 'lda1', label: `category axis 1 (${pct(0)}% of separation)`, value: (i) => p[i * 2] });
    list.push({ id: 'lda2', label: `category axis 2 (${pct(1)}% of separation)`, value: (i) => p[i * 2 + 1] });
  }
  for (let d = 0; d < FEATURE_COUNT; d++) {
    const def = FEATURE_DEFS[d];
    list.push({ id: def.name, label: def.label, value: (i) => store.analysis[i]?.vector[d] ?? 0 });
  }
  if (store.tasteModel) {
    list.push({
      id: 'predicted',
      label: `predicted rating (R\u00b2 ${store.tasteModel.r2.toFixed(2)})`,
      value: (i) => store.predictedRating(i) ?? 0,
    });
  }
  list.push({ id: 'algorithm', label: 'algorithm (1-32)', value: (i) => (store.voices[i].unpacked[P.algorithm] & 31) + 1 });
  list.push({ id: 'familySize', label: 'near-duplicate family size', value: (i) => ctx.store.clusterMembers(i).length });
  return list;
}

function axisById(id: AxisId): Axis {
  const all = axes();
  return all.find((a) => a.id === id) ?? all[0];
}

/**
 * How the axis pickers are organised.
 *
 * There are over sixty axes, and a flat alphabetical list of them is useless -
 * you cannot find "attack time" in it and you certainly cannot discover that
 * "mod wheel vibrato" exists. Groups are ordered by how often you would reach
 * for them when actually looking at a corpus, and so are the axes inside each
 * group: the learned axes first because they are the ones worth opening the map
 * on, then the things that decide what a patch sounds like, then the parameter
 * detail you only want when you are chasing something specific.
 *
 * Anything not named here still appears, under "Other" - so adding a feature
 * never silently hides it.
 */
const AXIS_GROUPS: Array<{ label: string; ids: string[] }> = [
  {
    label: 'Learned axes',
    ids: ['pca1', 'pca2', 'lda1', 'lda2', 'predicted'],
  },
  {
    label: 'Envelope',
    ids: ['attack', 'release', 'sustain', 'decay', 'loud1', 'loud2', 'loud3', 'loud4'],
  },
  {
    label: 'Brightness and timbre',
    ids: ['brightness', 'inharmonicity', 'brightnessSlope', 'absBrightness', 'spread',
      'attackBrightness', 'oddEven', 'flatness', 'bright1', 'bright2', 'bright3', 'bright4'],
  },
  {
    label: 'How it responds to playing',
    ids: ['velLevel', 'velBrightness', 'keyBrightness', 'keyLevel', 'velAttack', 'keyDecay',
      'register', 'loudness'],
  },
  {
    label: 'Mod wheel',
    ids: ['modResponse', 'modVibrato', 'modTremolo', 'modTimbre', 'modBrightness',
      'modWheelDepth', 'ampModCarriers', 'ampModModulators', 'ampModMax'],
  },
  {
    label: 'Patch structure',
    ids: ['algorithm', 'feedback', 'carriers', 'activeOps', 'maxRatio', 'nonInteger',
      'ratioSpread', 'fixedOps', 'detuneSpread', 'modDepth', 'carrierLevel'],
  },
  {
    label: 'Envelope and scaling parameters',
    ids: ['egAttackRate', 'egSustainLevel', 'egEndLevel', 'keyScaling', 'velSensParam',
      'rateScaling', 'pitchEg', 'pitchModSens', 'ampModSens'],
  },
  {
    label: 'LFO',
    ids: ['lfoSpeed', 'lfoDelay', 'lfoPm', 'lfoAm', 'lfoSampleHold'],
  },
  {
    label: 'Corpus',
    ids: ['familySize'],
  },
];

interface AxisGroup {
  label: string;
  axes: Axis[];
}

/** Bucket the available axes into the groups above, in the stated order. */
function groupedAxes(): AxisGroup[] {
  const all = axes();
  const byId = new Map(all.map((a) => [a.id, a]));
  const used = new Set<string>();
  const groups: AxisGroup[] = [];

  for (const spec of AXIS_GROUPS) {
    const picked: Axis[] = [];
    for (const id of spec.ids) {
      const a = byId.get(id);
      if (a && !used.has(id)) {
        picked.push(a);
        used.add(id);
      }
    }
    if (picked.length) groups.push({ label: spec.label, axes: picked });
  }

  const rest = all.filter((a) => !used.has(a.id));
  if (rest.length) groups.push({ label: 'Other', axes: rest });
  return groups;
}

/**
 * Mark the axes the rating model leans on hardest, so the ones worth looking at
 * for this particular corpus stand out without reordering the list under the
 * user every time they rate something.
 */
function importantAxisIds(): Set<string> {
  const model = ctx.store.tasteModel;
  const out = new Set<string>();
  if (!model || model.r2 < 0.08) return out;
  const ranked = Array.from(model.coefficients, (c, d) => ({ d, w: Math.abs(c) }))
    .sort((a, b) => b.w - a.w)
    .slice(0, 6);
  for (const r of ranked) out.add(`f${r.d}`);
  return out;
}


// -------------------------------------------------------------- geometry

function computeLayout(): void {
  // The list is a view of `visible`, so it is rebuilt wherever that is.
  queueMicrotask(refreshList);
  const store = ctx.store;
  const n = store.voices.length;
  const ax = axisById(xAxisId);
  const ay = axisById(yAxisId);
  const rawX = new Float32Array(n);
  const rawY = new Float32Array(n);
  visible = [];
  for (let i = 0; i < n; i++) {
    if (!store.analysis[i]) continue;
    if (collapseMerged && !store.isMergeRepresentative(i)) continue;
    if (searchMode === 'only' && matched && !matched.has(i)) continue;
    rawX[i] = ax.value(i);
    rawY[i] = ay.value(i);
    if (!Number.isFinite(rawX[i]) || !Number.isFinite(rawY[i])) continue;
    visible.push(i);
  }
  // Robust bounds: clip the extreme 0.5% so one sound-effect patch cannot
  // squash the entire corpus into a corner.
  const bounds = (arr: Float32Array) => {
    const vals = visible.map((i) => arr[i]).sort((a, b) => a - b);
    if (vals.length === 0) return [0, 1] as const;
    const lo = vals[Math.floor(vals.length * 0.005)];
    const hi = vals[Math.min(vals.length - 1, Math.ceil(vals.length * 0.995))];
    return hi > lo ? ([lo, hi] as const) : ([lo - 1, lo + 1] as const);
  };
  const [x0, x1] = bounds(rawX);
  const [y0, y1] = bounds(rawY);

  xs = new Float32Array(n);
  ys = new Float32Array(n);
  for (const i of visible) {
    xs[i] = (rawX[i] - x0) / (x1 - x0);
    ys[i] = 1 - (rawY[i] - y0) / (y1 - y0);
  }
  computeSizes();
}

function toScreen(i: number, w: number, h: number): [number, number] {
  const pad = 26;
  return [
    pad + xs[i] * (w - pad * 2) * scale + offsetX,
    pad + ys[i] * (h - pad * 2) * scale + offsetY,
  ];
}

function colourOf(i: number): string {
  const store = ctx.store;
  switch (colourBy) {
    case 'category': {
      const c = store.categoryOf(i);
      return c ? CATEGORY_COLOURS[c] : '#6b727e';
    }
    case 'subcategory': {
      const c = store.categoryOf(i);
      if (!c) return '#6b727e';
      return subcategoryColour(c, store.subcategoryOf(i), c === focusCategory);
    }
    case 'rating':
      return ratingColour(store.ratingOf(i) ?? 0);
    case 'predicted': {
      const p = store.predictedRating(i);
      if (p === null) return ratingColour(0);
      return ratingColour(Math.round(p));
    }
    case 'cluster': {
      const id = store.clusters?.labels[i] ?? i;
      return oklch(0.72, 0.14, (id * 137.508) % 360);
    }
    case 'source': {
      const file = store.voices[i].sources[0]?.file ?? '';
      let h = 0;
      for (let k = 0; k < file.length; k++) h = (h * 31 + file.charCodeAt(k)) >>> 0;
      return oklch(0.72, 0.13, h % 360);
    }
    case 'algorithm': {
      const alg = store.voices[i].unpacked[P.algorithm] & 31;
      return oklch(0.72, 0.14, (alg * 360) / 32);
    }
  }
}

function radiusOf(i: number): number {
  return sizes[i] || BASE_RADIUS;
}

/**
 * Dot radius from the size axis, if there is one.
 *
 * Area carries the value, not radius: a dot with twice the number in it looks
 * twice as big only if it covers twice the ink, and sizing by radius makes the
 * top of any range shout. The same robust bounds as the position axes, for the
 * same reason - one sound-effect patch at the far end must not flatten
 * everything else onto the minimum.
 */
function computeSizes(): void {
  const n = ctx.store.voices.length;
  sizes = new Float32Array(n).fill(BASE_RADIUS);
  if (!sizeAxisId) return;

  const axis = axisById(sizeAxisId);
  const raw = new Float32Array(n);
  const vals: number[] = [];
  for (const i of visible) {
    const v = axis.value(i);
    raw[i] = v;
    if (Number.isFinite(v)) vals.push(v);
  }
  if (vals.length === 0) return;
  vals.sort((a, b) => a - b);
  const lo = vals[Math.floor(vals.length * 0.005)];
  const hi = vals[Math.min(vals.length - 1, Math.ceil(vals.length * 0.995))];
  const span = hi - lo;

  const minArea = Math.PI * MIN_RADIUS * MIN_RADIUS;
  const maxArea = Math.PI * MAX_RADIUS * MAX_RADIUS;
  // Quantised, because every distinct radius is a separate cached sprite per
  // colour. A quarter of a pixel is finer than the eye can read off a dot and
  // keeps the cache to a few dozen entries instead of one per voice.
  for (const i of visible) {
    const t = span > 0 ? Math.max(0, Math.min(1, (raw[i] - lo) / span)) : 0.5;
    const r = Math.sqrt((minArea + t * (maxArea - minArea)) / Math.PI);
    sizes[i] = Math.round(r * 4) / 4;
  }
}

// ----------------------------------------------------------------- draw

function draw(): void {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const w = Math.max(1, Math.floor(rect.width));
  const h = Math.max(1, Math.floor(rect.height));
  for (const c of [canvas, overlay]) {
    if (c.width !== w * dpr || c.height !== h * dpr) {
      c.width = w * dpr;
      c.height = h * dpr;
    }
  }
  const g = canvas.getContext('2d')!;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.fillStyle = '#14161a';
  g.fillRect(0, 0, w, h);

  const store = ctx.store;
  const lassoSet = lassoSelection.length ? new Set(lassoSelection) : null;
  const highlight = searchMode === 'highlight' && matched ? matched : null;

  g.globalAlpha = 1;
  for (const i of visible) {
    const [px, py] = toScreen(i, w, h);
    if (px < -20 || py < -20 || px > w + 20 || py > h + 20) continue;
    const dimmed = (lassoSet && !lassoSet.has(i)) || (highlight && !highlight.has(i));
    const r = radiusOf(i);
    const spr = sprite(colourOf(i), r, dimmed ? DIMMED_ALPHA : BASE_ALPHA, dpr);
    const size = spr.width / dpr;
    g.drawImage(spr, px - size / 2, py - size / 2, size, size);
  }

  // Pinned voices get a ring so they are findable at a glance.
  g.globalAlpha = 0.9;
  g.strokeStyle = '#ffca6a';
  g.lineWidth = 1.4;
  g.beginPath();
  for (const i of visible) {
    if (!store.voices[i].pinned) continue;
    const [px, py] = toScreen(i, w, h);
    const r = radiusOf(i) + 2;
    g.moveTo(px + r, py);
    g.arc(px, py, r, 0, Math.PI * 2);
  }
  g.stroke();

  g.globalAlpha = 1;
  for (const [i, colour] of [[selected, '#ffffff'], [hovered, '#ffca6a']] as const) {
    if (i < 0 || !xs.length || xs[i] === undefined) continue;
    const [px, py] = toScreen(i, w, h);
    g.strokeStyle = colour;
    g.lineWidth = 2;
    g.beginPath();
    g.arc(px, py, radiusOf(i) + 5, 0, Math.PI * 2);
    g.stroke();
  }

  drawOverlay(w, h, dpr);
}

function drawOverlay(w: number, h: number, dpr: number): void {
  const g = overlay.getContext('2d')!;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  if (lassoPoints.length > 1) {
    g.strokeStyle = '#6ea8fe';
    g.fillStyle = 'rgba(110,168,254,0.09)';
    g.lineWidth = 1.4;
    g.beginPath();
    g.moveTo(lassoPoints[0][0], lassoPoints[0][1]);
    for (const [x, y] of lassoPoints.slice(1)) g.lineTo(x, y);
    g.closePath();
    g.fill();
    g.stroke();
  }
  if (interpolateMode && interpAt && interpResult) {
    // Draw the blend: a line out to each contributor, weighted by how much it
    // is actually contributing. Without this the interpolated sound has no
    // visible connection to anything on the plot, and there is no way to tell
    // a tight local blend from one reaching halfway across the map.
    const rect = canvas.getBoundingClientRect();

    // Drawn heavily on purpose. The blend is a guess assembled from whatever
    // happened to be nearby, and it should look like one - you need to see at a
    // glance which patches it leaned on and how hard, over a background of
    // twenty thousand faint dots.
    g.lineCap = 'round';
    for (const c of interpResult.contributions) {
      if (xs[c.index] === undefined) continue;
      const [px, py] = toScreen(c.index, rect.width, rect.height);

      // A dark casing under each line, so it stays readable over dense colour.
      g.globalAlpha = 0.5;
      g.strokeStyle = '#14161a';
      g.lineWidth = 3.5 + c.weight * 7;
      g.beginPath();
      g.moveTo(interpAt[0], interpAt[1]);
      g.lineTo(px, py);
      g.stroke();

      g.globalAlpha = 0.55 + c.weight * 0.45;
      g.strokeStyle = '#ffca6a';
      g.lineWidth = 1.6 + c.weight * 5;
      g.beginPath();
      g.moveTo(interpAt[0], interpAt[1]);
      g.lineTo(px, py);
      g.stroke();

      g.globalAlpha = 1;
      g.fillStyle = '#ffca6a';
      g.beginPath();
      g.arc(px, py, 3 + c.weight * 6, 0, Math.PI * 2);
      g.fill();
      g.strokeStyle = '#14161a';
      g.lineWidth = 1.5;
      g.stroke();
    }
    g.globalAlpha = 1;
    g.lineCap = 'butt';

    // Label the strongest contributors. Three when pinned and there is time to
    // read them, just the dominant one while the cursor is still moving.
    const labelled = interpFrozen ? interpResult.contributions.slice(0, 3) : interpResult.contributions.slice(0, 1);
    g.font = '600 12px system-ui, sans-serif';
    for (const c of labelled) {
      const name = ctx.store.voices[c.index]?.name.trim();
      if (!name || xs[c.index] === undefined) continue;
      const [px, py] = toScreen(c.index, rect.width, rect.height);
      const text = `${name} ${Math.round(c.weight * 100)}%`;
      const tw = g.measureText(text).width;
      g.fillStyle = 'rgba(20, 22, 26, 0.82)';
      g.fillRect(px + 8, py - 20, tw + 8, 16);
      g.fillStyle = '#ffca6a';
      g.fillText(text, px + 12, py - 8);
    }
  }

  if (interpolateMode && interpAt) {
    // Mark where the blend was taken from: with no point under the cursor
    // there is otherwise nothing on screen tying the sound to a position.
    g.strokeStyle = '#14161a';
    g.lineWidth = interpFrozen ? 6 : 4.5;
    g.setLineDash([]);
    g.beginPath();
    g.arc(interpAt[0], interpAt[1], 15, 0, Math.PI * 2);
    g.stroke();

    g.strokeStyle = '#ffffff';
    g.lineWidth = interpFrozen ? 3 : 2;
    g.setLineDash(interpFrozen ? [] : [4, 4]);
    g.beginPath();
    g.moveTo(interpAt[0] - 12, interpAt[1]);
    g.lineTo(interpAt[0] + 12, interpAt[1]);
    g.moveTo(interpAt[0], interpAt[1] - 12);
    g.lineTo(interpAt[0], interpAt[1] + 12);
    g.stroke();
    g.beginPath();
    g.arc(interpAt[0], interpAt[1], 15, 0, Math.PI * 2);
    g.stroke();
    g.setLineDash([]);
  }

  g.fillStyle = '#939aa6';
  g.font = '11px system-ui, sans-serif';
  g.fillText(axisById(xAxisId).label, 10, h - 8);
  g.save();
  g.translate(12, h - 24);
  g.rotate(-Math.PI / 2);
  g.fillText(axisById(yAxisId).label, 0, 0);
  g.restore();
}

// -------------------------------------------------------------- hit test

/**
 * The voices currently in play: what is drawn, narrowed to the search and
 * category filter when one is active.
 *
 * Interpolation always works from this set rather than the whole corpus - if
 * you have searched for organs, the blend under your cursor should be made of
 * organs.
 */
function activeSet(): number[] {
  if (!matched) return visible;
  return visible.filter((i) => matched!.has(i));
}

/**
 * With "snap to results" on, only matches are pickable. Dimmed points stay as
 * context rather than becoming targets, so sweeping through a highlighted
 * region cannot catch a neighbour and lose your place. Turn it off to hear what
 * is actually sitting around the matches.
 */
function pick(mx: number, my: number, radius = 18): number {
  const rect = canvas.getBoundingClientRect();
  const w = rect.width;
  const h = rect.height;
  let best = -1;
  let bestD = radius * radius;
  for (const i of visible) {
    if (snapToMatches && matched && !matched.has(i)) continue;
    const [px, py] = toScreen(i, w, h);
    const dx = px - mx;
    const dy = py - my;
    const d = dx * dx + dy * dy;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

function pointInPolygon(x: number, y: number, poly: Array<[number, number]>): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * Hovering starts the short prefix immediately and slides onto the full phrase
 * as soon as it has rendered - the prefix is the same audio as the phrase's
 * opening, so the join is inaudible. Dwell on a point and you get the whole
 * melody looping; sweep past and you get one clean note.
 */
/** The phrase an audition should use: the short prefix, or the whole thing. */
function phrase(full: boolean) {
  if (!usePhrase) return singleNotePhrase(auditionNote, auditionVel);
  return full ? DEMO_PHRASE : HOVER_PHRASE;
}

/** Whatever the sidebar is currently describing: the selection, else the hover. */
function targetVoice(): number {
  return selected >= 0 ? selected : hovered;
}

/**
 * Rate the voice under the cursor. Pressing the rating it already has clears
 * it, which is the only way to undo a mis-key without leaving the map.
 */
async function rateTarget(value: number): Promise<void> {
  const i = targetVoice();
  if (i < 0) return;
  const current = ctx.store.ratingOf(i);
  if (current === value) await ctx.store.clearRating(i);
  else await ctx.store.rate(i, value, 'round1');
  renderSide();
  draw();
  list?.refresh();
}

/**
 * @param auto how this playback came about, so the autoplay setting can veto
 *   it: 'hover' for a sweep, 'click' for landing on a patch deliberately, and
 *   omitted for an explicit Play.
 */
async function audition(i: number, quick = false, auto?: 'click' | 'hover'): Promise<void> {
  if (i < 0 || keyboard.playing) return;
  if (auto && !ctx.player.mayPlay(auto)) return;
  const v = ctx.store.voices[i];
  if (!v) return;
  if (!usePhrase) {
    await ctx.player.audition(v.id, v.unpacked, singleNotePhrase(auditionNote, auditionVel), { loop: loopPhrase });
    return;
  }
  if (quick) {
    await ctx.player.auditionProgressive(v.id, v.unpacked, HOVER_PHRASE, DEMO_PHRASE, { loop: loopPhrase });
  } else {
    await ctx.player.audition(v.id, v.unpacked, DEMO_PHRASE, { loop: loopPhrase });
  }
}

/** Whatever the MIDI keyboard should be playing right now. */
function armKeyboard(): void {
  const i = selected >= 0 ? selected : hovered;
  keyboard.setPatch(i >= 0 ? ctx.store.voices[i]?.unpacked ?? null : null);
}


// --------------------------------------------------------- interpolation

/**
 * Blend the voices around the cursor and play the result.
 *
 * Neighbours are taken in screen space rather than in the full feature space,
 * because the cursor is a position on this plot and the plot is what the user
 * is reasoning about. The algorithm is voted on first and everything on a
 * different algorithm is then discarded: operator 3 means something different
 * in every algorithm, so averaging across them produces noise rather than a
 * blend.
 */
function runInterpolation(mx: number, my: number): void {
  const store = ctx.store;
  const rect = canvas.getBoundingClientRect();
  const w = rect.width;
  const h = rect.height;
  const pool = activeSet();
  if (pool.length === 0) {
    interpResult = null;
    renderSide();
    return;
  }

  const scored: Array<{ i: number; d: number }> = [];
  for (const i of pool) {
    const [px, py] = toScreen(i, w, h);
    const dx = px - mx;
    const dy = py - my;
    scored.push({ i, d: Math.sqrt(dx * dx + dy * dy) });
  }
  scored.sort((a, b) => a.d - b.d);

  const votePool = scored.slice(0, Math.max(interpNeighbours, interpVotePool));
  const votePatches = votePool.map((c) => store.voices[c.i].unpacked);
  const voteWeights = inverseDistanceWeights(votePool.map((c) => c.d));
  const { algorithm, share } = dominantAlgorithm(votePatches, voteWeights);
  interpAlgorithmShare = share;

  // Reach past the vote pool rather than settling for however few of its
  // members happened to share the winning algorithm. Fixing the algorithm
  // usually does thin the field out a lot - a corpus this size spreads across
  // all 32 - so this walks the whole sorted list and takes the nearest N that
  // match, however far out it has to go, rather than dropping them.
  const matching = scored.filter((c) => (store.voices[c.i].unpacked[P.algorithm] & 31) === algorithm)
    .slice(0, interpNeighbours);
  if (matching.length === 0) {
    interpResult = null;
    renderSide();
    return;
  }

  // How many closer voices were passed over to get there, and how far the net
  // had to be cast. Both matter: if the blend is reaching across the plot it is
  // not describing the spot under the cursor any more.
  const reach = matching[matching.length - 1].d;
  interpSkipped = scored.filter(
    (c) => c.d < reach && (store.voices[c.i].unpacked[P.algorithm] & 31) !== algorithm,
  ).length;
  interpReach = reach;
  interpNearest = scored[0] ? scored[0].d : 0;

  interpResult = interpolateVoices(
    matching.map((c) => store.voices[c.i].unpacked),
    blendWeights(matching.map((c) => c.d), interpBias),
    matching.map((c) => c.i),
    { algorithm, maxContributors: interpNeighbours, name: 'BLEND' },
  );
  interpAt = [mx, my];

  if (interpResult) {
    // Arm the keyboard unconditionally. This used to sit inside the guard
    // below, so while you were holding notes the blend under the cursor never
    // reached the keyboard and the next key press played a stale patch - the
    // two features looked like they were fighting each other.
    keyboard.setPatch(interpResult.voice);
    if (!keyboard.playing && ctx.player.mayPlay('hover')) {
      const id = `blend-${voiceHash(interpResult.voice)}`;
      void ctx.player.audition(id, interpResult.voice, phrase(false), { loop: loopPhrase });
    }
  }
  renderSide();
  draw();
}

/**
 * Short enough to feel like the sound is following the cursor rather than
 * catching up with it. The work behind each one is a scan over the active set
 * plus a two-second render, both of which land inside this window on a normal
 * machine.
 */
const INTERPOLATE_DEBOUNCE_MS = 70;

function scheduleInterpolation(mx: number, my: number): void {
  if (interpTimer !== null) window.clearTimeout(interpTimer);
  interpTimer = window.setTimeout(() => {
    interpTimer = null;
    runInterpolation(mx, my);
  }, INTERPOLATE_DEBOUNCE_MS);
}

function interpolationPanel(): HTMLElement | null {
  if (!interpolateMode) return null;
  const store = ctx.store;
  const panel = el('div', { class: 'panel', style: { marginBottom: '14px' } },
    el('h3', { style: { marginTop: 0 } }, 'Interpolated patch'));

  if (!interpResult) {
    panel.appendChild(el('p', { class: 'muted', style: { marginBottom: 0 } },
      'Move over the gaps between points and a patch is blended from what is nearest, and played. Land on an actual ',
      'patch and you get that patch instead. Click to pin a blend in place.'));
    return panel;
  }

  panel.appendChild(el('div', { class: 'row', style: { marginBottom: '8px' } },
    el('button', {
      class: interpFrozen ? 'btn primary' : 'btn',
      style: { padding: '3px 10px' },
      onclick: () => {
        interpFrozen = !interpFrozen;
        renderSide();
        draw();
      },
    }, interpFrozen ? 'Pinned \u2014 click the plot to move on' : 'Following the cursor'),
  ));

  panel.appendChild(el('div', { class: 'muted', style: { marginBottom: '8px' } },
    `algorithm ${interpResult.algorithm + 1}`,
    `  \u00b7  ${interpResult.contributions.length} contributors`,
    `  \u00b7  ${Math.round(interpAlgorithmShare * 100)}% of neighbours agree`,
  ));

  panel.appendChild(algorithmPanel(interpResult.algorithm, interpResult.voice));

  panel.appendChild(el('div', { class: 'muted', style: { fontSize: '11.5px', marginBottom: '8px' } },
    'tuning from ',
    el('b', {}, store.voices[interpResult.tuningDonor]?.name.trim() || '(unnamed)'),
    interpResult.envelopeDonor !== null
      ? el('span', {}, ', envelope from ',
        el('b', {}, store.voices[interpResult.envelopeDonor]?.name.trim() || '(unnamed)'))
      : ', envelopes averaged',
    ' — both are shapes rather than quantities, so averaging them lands between two things and sounds like neither.',
  ));

  if (interpSkipped > 0) {
    panel.appendChild(el('p', { class: 'muted', style: { fontSize: '11.5px', marginTop: 0 } },
      `${interpSkipped} closer voice${interpSkipped === 1 ? '' : 's'} skipped for being on another algorithm. `,
      'Operator roles only line up within an algorithm, so blending across them would average a carrier with a modulator.'));
  }

  if (interpReach > interpNearest * 6 && interpReach > 90) {
    panel.appendChild(el('p', { class: 'warn', style: { fontSize: '11.5px' } },
      'The nearest voices on this algorithm are a long way off, so this blend describes the region loosely rather ',
      'than the exact spot under the cursor. Fewer contributors would tighten it.'));
  }

  const list = el('div', { class: 'stack', style: { gap: '2px', marginBottom: '10px' } });
  for (const c of interpResult.contributions) {
    const v = store.voices[c.index];
    if (!v) continue;
    list.appendChild(el('div', { class: 'row', style: { gap: '8px', justifyContent: 'space-between' } },
      el('span', { class: 'mono', style: { fontSize: '11.5px' } }, v.name || '(unnamed)'),
      el('span', { class: 'muted mono', style: { fontSize: '11px' } }, `${Math.round(c.weight * 100)}%`),
    ));
  }
  panel.appendChild(list);

  panel.appendChild(el('div', { class: 'row' },
    el('button', {
      class: 'btn',
      onclick: () => {
        if (!interpResult) return;
        const id = `blend-${voiceHash(interpResult.voice)}`;
        void ctx.player.audition(id, interpResult.voice, phrase(true), { loop: loopPhrase });
      },
    }, 'Play in full'),
    el('button', {
      class: 'btn primary',
      onclick: async () => {
        if (!interpResult) return;
        const names = interpResult.contributions
          .map((c) => store.voices[c.index]?.name.trim())
          .filter(Boolean)
          .slice(0, 3)
          .join(' + ');
        const suggested = window.prompt('Name for this patch (10 characters on a DX7):', 'BLEND');
        if (suggested === null) return;
        const ix = await store.addSynthesised(interpResult.voice, suggested, `blend of ${names}`);
        if (ix !== null && ix >= 0) {
          selected = ix;
          computeLayout();
          renderSide();
          draw();
        }
      },
    }, 'Keep this patch'),
  ));
  panel.appendChild(el('p', { class: 'hint', style: { marginTop: '10px', marginBottom: 0 } },
    'Kept patches are pinned and flagged as yours, so they go into the final 128 regardless of rating. ',
    'They have no features until the next analysis pass.'));

  return panel;
}

// ------------------------------------------------------------ side panel

function renderSide(): void {
  clear(sideEl);
  const store = ctx.store;
  const i = selected >= 0 ? selected : hovered;

  const interp = interpolationPanel();
  if (interp) sideEl.appendChild(interp);

  if (lassoSelection.length) {
    sideEl.appendChild(el('div', { class: 'panel', style: { marginBottom: '14px' } },
      el('h3', { style: { marginTop: 0 } }, `${fmtInt(lassoSelection.length)} voices lassoed`),
      el('div', { class: 'row' },
        el('button', {
          class: 'btn primary',
          onclick: () => {
            sessionStorage.setItem('rateQueue', JSON.stringify(lassoSelection));
            ctx.go('rate');
          },
        }, 'Rate these'),
        el('button', {
          class: 'btn',
          onclick: () => {
            lassoSelection = [];
            renderSide();
            draw();
          },
        }, 'Clear'),
      ),
    ));
  }

  if (i < 0) {
    sideEl.appendChild(el('p', { class: 'muted' }, 'Hover a point to hear it. Click to keep it selected.'));
    return;
  }

  sideEl.appendChild(voiceDetails(store, i, {
    onPlay: (n) => void audition(n),
    onRate: (r) => void rateTarget(r),
    onOpen: (n) => {
      selected = n;
      armKeyboard();
      void audition(n, false, 'click');
      renderSide();
      draw();
    },
    onChange: () => {
      renderSide();
      draw();
    },
  }));
}

// ---------------------------------------------------------------- controls

function applyFilters(): void {
  query = parseQuery(searchText);
  const filtering = query.terms.length > 0 || focusCategory !== '' || focusRating !== '';
  matched = filtering ? new Set<number>() : null;
  if (matched) {
    const store = ctx.store;
    for (let i = 0; i < store.voices.length; i++) {
      const cat = store.categoryOf(i);
      if (focusCategory && cat !== focusCategory) continue;
      if (focusSub && store.subcategoryOf(i) !== focusSub) continue;
      if (focusRating !== '') {
        const r = store.ratingOf(i);
        if (focusRating === 'unrated') {
          if (r !== null) continue;
        } else if (r === null || r < focusRating) continue;
      }
      const tags = cat ? `${cat} ${CATEGORY_LABELS[cat]} ${subcategoryLabel(cat, store.subcategoryOf(i))}` : '';
      if (matchesQuery(store.voices[i], query, searchScope, tags)) matched.add(i);
    }
  }
  computeLayout();
  renderControls();
  renderLegend();
  draw();
}

/**
 * Hand the list the same set the canvas is drawing, in its own order.
 *
 * Nothing happens while the list is hidden. It is cheap - a sort of forty
 * thousand is a few milliseconds - but painting rows is not free of
 * consequences: a row asks for a predicted rating, and asking for one used to
 * compute all of them.
 */
function refreshList(): void {
  if (!list || mode !== 'list') return;
  list.update(sortIndices(ctx.store, visible, listState));
}

function applyMode(): void {
  if (!listEl || !canvas) return;
  const showList = mode === 'list';
  listEl.hidden = !showList;
  const wrap = canvas.parentElement;
  if (wrap) wrap.hidden = showList;
  if (showList) refreshList();
}

function renderControls(): void {
  clear(controlsEl);
  const groups = groupedAxes();
  const important = importantAxisIds();
  const axisSelect = (current: AxisId | '', onChange: (id: AxisId) => void, first?: { value: string; label: string }) =>
    el('select', {
      class: 'axis-select',
      onchange: (e: Event) => onChange((e.target as HTMLSelectElement).value),
    }, ...(first ? [el('option', { value: first.value, selected: current === first.value }, first.label)] : []),
    ...groups.map((g) => {
      const optgroup = el('optgroup', { label: g.label });
      for (const a of g.axes) {
        optgroup.appendChild(el('option', {
          value: a.id,
          selected: a.id === current,
        }, important.has(a.id) ? `\u2022 ${a.label}` : a.label));
      }
      return optgroup;
    }));

  const searchInput = el('input', {
    class: 'text',
    type: 'search',
    value: searchText,
    placeholder: 'bank piano   ·   e-piano OR rhodes',
    title: 'Case-insensitive substrings, OR or commas between terms. Category and subcategory names match too.',
    style: { width: '260px' },
    oninput: (e: Event) => {
      searchText = (e.target as HTMLInputElement).value;
    },
    onchange: () => applyFilters(),
    onkeydown: (e: KeyboardEvent) => {
      if (e.key === 'Enter') applyFilters();
      e.stopPropagation();
    },
  }) as HTMLInputElement;

  // Axes, colour and size describe a plot. In the list they would be controls
  // with nothing to control, which is worse than not being there.
  const plot = mode === 'map';

  append(controlsEl, [
    el('label', { class: 'field', title: 'The same voices and the same filters, drawn as a scatter or as a table.' }, 'as',
      el('select', {
        onchange: (e: Event) => {
          mode = (e.target as HTMLSelectElement).value as typeof mode;
          setSetting('map.mode', mode);
          renderControls();
          applyMode();
          draw();
        },
      },
        el('option', { value: 'map', selected: mode === 'map' }, 'map'),
        el('option', { value: 'list', selected: mode === 'list' }, 'list'),
      )),
    plot ? el('label', { class: 'field' }, 'x', axisSelect(xAxisId, (id) => {
      xAxisId = id;
      setSetting('map.xAxis', id);
      computeLayout();
      draw();
    })) : null,
    plot ? el('label', { class: 'field' }, 'y', axisSelect(yAxisId, (id) => {
      yAxisId = id;
      setSetting('map.yAxis', id);
      computeLayout();
      draw();
    })) : null,
    plot ? el('label', { class: 'field' }, 'colour',
      el('select', {
        onchange: (e: Event) => {
          colourBy = (e.target as HTMLSelectElement).value as typeof colourBy;
          setSetting('map.colourBy', colourBy);
          renderLegend();
          draw();
        },
      }, ...(['category', 'subcategory', 'rating', 'predicted', 'cluster', 'source', 'algorithm'] as const).map((c) =>
        el('option', { value: c, selected: c === colourBy }, c))),
    ) : null,
    el('label', { class: 'field' },
      el('input', {
        type: 'checkbox',
        checked: collapseMerged,
        onchange: (e: Event) => {
          collapseMerged = (e.target as HTMLInputElement).checked; setSetting('map.collapseMerged', collapseMerged);
          computeLayout();
          renderControls();
          draw();
        },
      }), 'collapse near-identical'),
    plot ? el('label', {
      class: 'field',
      title: 'Play a patch blended from the voices nearest the cursor, rather than the nearest single patch. Only ever uses what is currently shown.',
    },
      el('input', {
        type: 'checkbox',
        checked: interpolateMode,
        onchange: (e: Event) => {
          interpolateMode = (e.target as HTMLInputElement).checked; setSetting('map.interpolate', interpolateMode);
          interpResult = null;
          interpFrozen = false;
          if (!interpolateMode) interpAt = null;
          renderControls();
          renderSide();
          draw();
        },
      }), 'interpolate') : null,
    plot && interpolateMode ? el('label', { class: 'field' }, 'blend of',
      el('input', {
        type: 'number', min: 2, max: 32, value: interpNeighbours,
        style: { width: '54px' },
        onchange: (e: Event) => { interpNeighbours = Number((e.target as HTMLInputElement).value); setSetting('map.interpNeighbours', interpNeighbours); },
      })) : null,
    interpolateMode ? el('label', {
      class: 'field',
      title: 'How sharply the blend leans on the nearest contributor. Left mixes them evenly; right is dominated by whatever is closest.',
    }, 'bias',
      el('input', {
        type: 'range', min: 0, max: 100, value: Math.round(interpBias * 100),
        style: { width: '90px' },
        oninput: (e: Event) => { interpBias = Number((e.target as HTMLInputElement).value) / 100; },
        onchange: () => {
          if (interpAt) runInterpolation(interpAt[0], interpAt[1]);
        },
      })) : null,
    interpolateMode ? el('label', {
      class: 'field',
      title: 'How close to a real patch you have to be for it to win over a blend. Larger snaps to patches more readily; smaller gives you more room to blend between them.',
    }, 'snap',
      el('input', {
        type: 'number', min: 0, max: 40, value: interpSnapRadius,
        style: { width: '54px' },
        onchange: (e: Event) => { interpSnapRadius = Number((e.target as HTMLInputElement).value); setSetting('map.snapRadius', interpSnapRadius); },
      }), 'px') : null,
    el('label', { class: 'field' },
      el('input', {
        type: 'checkbox',
        checked: usePhrase,
        onchange: (e: Event) => { usePhrase = (e.target as HTMLInputElement).checked; setSetting('audition.phrase', usePhrase); },
      }), 'demo phrase'),
    el('label', { class: 'field' },
      el('input', {
        type: 'checkbox',
        checked: loopPhrase,
        onchange: (e: Event) => { loopPhrase = (e.target as HTMLInputElement).checked; setSetting('audition.loop', loopPhrase); },
      }), 'loop'),
    plot ? el('label', { class: 'field' }, 'size', axisSelect(sizeAxisId, (id) => {
      sizeAxisId = id;
      setSetting('map.sizeAxis', id);
      computeSizes();
      draw();
    }, { value: '', label: 'uniform' })) : null,
    plot ? el('button', {
      class: 'btn',
      onclick: () => {
        scale = 1;
        offsetX = 0;
        offsetY = 0;
        draw();
      },
    }, 'Reset view') : null,
  ]);

  // ---- second row: search, volume, keyboard ----
  const subDefs = focusCategory ? SUBCATEGORIES[focusCategory] ?? [] : [];
  const row2 = el('div', { class: 'map-controls', style: { borderTop: '1px solid var(--line)' } },
    el('label', { class: 'field' }, 'show',
      el('select', {
        onchange: (e: Event) => {
          const value = (e.target as HTMLSelectElement).value;
          focusSub = '';
          if (value === 'unrated' || value.startsWith('min')) {
            focusRating = value === 'unrated' ? 'unrated' : (Number(value.slice(3)) as 1 | 2 | 3 | 4 | 5);
            focusCategory = '';
            colourBy = 'rating';
            setSetting('map.colourBy', colourBy);
          } else {
            focusRating = '';
            focusCategory = value as Category | '';
            if (focusCategory) {
              colourBy = 'subcategory';
              setSetting('map.colourBy', colourBy);
            }
          }
          applyFilters();
        },
      },
        el('option', {
          value: '',
          selected: focusCategory === '' && focusRating === '',
        }, 'everything'),
        // Two ways to narrow the map, in one control because they are the same
        // question - which of these am I looking at - and only ever one at a
        // time. The group labels are the separator.
        el('optgroup', { label: 'category' },
          ...CATEGORIES.map((c) => el('option', {
            value: c,
            selected: c === focusCategory,
          }, CATEGORY_LABELS[c]))),
        el('optgroup', { label: 'rating' },
          el('option', { value: 'unrated', selected: focusRating === 'unrated' }, 'not rated yet'),
          ...([1, 2, 3, 4, 5] as const).map((r) => el('option', {
            value: `min${r}`,
            selected: focusRating === r,
          }, r === 1 ? 'rated at all' : r === 5 ? '★'.repeat(5) : `${'★'.repeat(r)} or better`))),
      )),
    focusCategory ? el('label', { class: 'field' },
      el('select', {
        onchange: (e: Event) => {
          focusSub = (e.target as HTMLSelectElement).value;
          applyFilters();
        },
      },
        el('option', { value: '', selected: focusSub === '' }, 'all subcategories'),
        ...subDefs.map((d) => el('option', { value: d.id, selected: d.id === focusSub }, d.label)),
      )) : null,
    el('label', {
      class: 'field',
      title: 'Every word must match, anywhere in the name, its aliases, or the path. OR (or a comma) separates alternatives, and "quotes" keep a phrase together.',
    }, 'search', searchInput),
    el('label', { class: 'field' },
      el('select', {
        onchange: (e: Event) => {
          searchScope = (e.target as HTMLSelectElement).value as typeof searchScope; setSetting('map.searchScope', searchScope);
          applyFilters();
        },
      },
        el('option', { value: 'name', selected: searchScope === 'name' }, 'name only'),
        el('option', { value: 'all', selected: searchScope === 'all' }, 'name and file path'),
      )),
    el('label', { class: 'field' },
      el('select', {
        onchange: (e: Event) => {
          searchMode = (e.target as HTMLSelectElement).value as typeof searchMode; setSetting('map.searchMode', searchMode);
          applyFilters();
        },
      },
        el('option', { value: 'highlight', selected: searchMode === 'highlight' }, 'highlight matches'),
        el('option', { value: 'only', selected: searchMode === 'only' }, 'show only matches'),
      )),
    matched ? el('label', { class: 'field' },
      el('input', {
        type: 'checkbox',
        checked: snapToMatches,
        onchange: (e: Event) => { snapToMatches = (e.target as HTMLInputElement).checked; setSetting('map.snapToMatches', snapToMatches); },
      }), 'snap to results') : null,
    matched ? el('span', { class: 'muted' }, `${fmtInt(matched.size)} match${matched.size === 1 ? '' : 'es'}`) : null,
    el('div', { class: 'spacer', style: { flex: '1' } }),
  );
  controlsEl.parentElement?.querySelector('.map-controls-2')?.remove();
  row2.classList.add('map-controls-2');
  controlsEl.after(row2);
}

function renderLegend(): void {
  clear(legendEl);
  if (colourBy === 'category') {
    for (const c of CATEGORIES) {
      legendEl.appendChild(el('span', {},
        el('i', { style: { background: CATEGORY_COLOURS[c] } }), CATEGORY_LABELS[c]));
    }
  } else if (colourBy === 'rating') {
    legendEl.appendChild(el('span', {}, el('i', { style: { background: ratingColour(0) } }), 'unrated'));
    for (let r = 1; r <= 5; r++) {
      legendEl.appendChild(el('span', {}, el('i', { style: { background: ratingColour(r) } }), String(r)));
    }
  } else if (colourBy === 'predicted') {
    legendEl.appendChild(el('span', { class: 'muted' }, 'the rating model\u2019s guess, rounded:'));
    for (let r = 1; r <= 5; r++) {
      legendEl.appendChild(el('span', {}, el('i', { style: { background: ratingColour(r) } }), String(r)));
    }
  } else if (colourBy === 'subcategory') {
    const cat = (focusCategory || null)
      ?? (selected >= 0 ? ctx.store.categoryOf(selected) : null)
      ?? (hovered >= 0 ? ctx.store.categoryOf(hovered) : null);
    if (cat) {
      const focused = cat === focusCategory;
      for (const d of SUBCATEGORIES[cat] ?? []) {
        legendEl.appendChild(el('span', {},
          el('i', { style: { background: subcategoryColour(cat, d.id, focused) } }),
          focused ? d.label : `${cat}: ${d.label}`));
      }
    } else {
      legendEl.appendChild(el('span', { class: 'muted' },
        'shades within each category. Pick one under "show" to see its subcategories named, or hover a point.'));
    }
  } else {
    legendEl.appendChild(el('span', { class: 'muted' }, `coloured by ${colourBy}`));
  }
  legendEl.appendChild(el('span', { class: 'muted' }, `  ${fmtInt(visible.length)} points shown`));
}

function attachCanvasEvents(): void {
  const wrap = canvas.parentElement!;

  wrap.addEventListener('mousemove', (e) => {
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    if (lassoing) {
      lassoPoints.push([mx, my]);
      draw();
      return;
    }
    if (panning) {
      offsetX += mx - panStart[0];
      offsetY += my - panStart[1];
      panStart = [mx, my];
      draw();
      return;
    }

    if (interpolateMode) {
      if (interpFrozen) return;

      // Sitting on an actual patch beats a blend of it. The snap radius here is
      // tighter than for normal hovering, because in this mode the gaps between
      // points are the interesting part and a generous radius would swallow
      // them.
      const onPoint = pick(mx, my, interpSnapRadius);
      if (onPoint >= 0) {
        // Cancel any blend still queued from the last position. Without this a
        // timer scheduled a moment ago fires after the cursor has already
        // landed on a patch and replaces it with a blend, which made it look
        // like snapping never worked at all.
        if (interpTimer !== null) {
          window.clearTimeout(interpTimer);
          interpTimer = null;
        }
        if (interpResult) {
          interpResult = null;
          interpAt = null;
        }
        if (onPoint !== hovered) {
          hovered = onPoint;
          renderSide();
          armKeyboard();
          draw();
          const now = performance.now();
          if (hoverAudition && now - lastAuditionAt > HOVER_INTERVAL_MS) {
            lastAuditionAt = now;
            void audition(onPoint, true, 'hover');
          }
        }
        return;
      }

      if (hovered !== -1) {
        hovered = -1;
        draw();
      }
      scheduleInterpolation(mx, my);
      return;
    }

    const hit = pick(mx, my);
    if (hit !== hovered) {
      hovered = hit;
      // The subcategory legend is per-category, so it follows the cursor.
      if (colourBy === 'subcategory') renderLegend();
      draw();
      if (selected < 0) {
        renderSide();
        armKeyboard();
      }
      const now = performance.now();
      if (hoverAudition && hit >= 0 && now - lastAuditionAt > HOVER_INTERVAL_MS) {
        lastAuditionAt = now;
        void audition(hit, false, 'hover');
      }
    }
  });

  wrap.addEventListener('mousedown', (e) => {
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    void ctx.player.unlock();
    if (e.shiftKey) {
      lassoing = true;
      lassoPoints = [[mx, my]];
    } else {
      panning = true;
      panStart = [mx, my];
    }
  });

  window.addEventListener('mouseup', () => {
    if (lassoing) {
      lassoing = false;
      if (lassoPoints.length > 2) {
        const rect = canvas.getBoundingClientRect();
        lassoSelection = visible.filter((i) => {
          const [px, py] = toScreen(i, rect.width, rect.height);
          return pointInPolygon(px, py, lassoPoints);
        });
      }
      lassoPoints = [];
      renderSide();
      draw();
    }
    panning = false;
  });

  wrap.addEventListener('click', (e) => {
    if (e.shiftKey) return;
    const rect = canvas.getBoundingClientRect();

    if (interpolateMode) {
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      if (interpTimer !== null) {
        window.clearTimeout(interpTimer);
        interpTimer = null;
      }
      const onPoint = pick(mx, my, interpSnapRadius);
      if (onPoint >= 0) {
        // Same rule as hovering: a real patch under the cursor wins.
        interpResult = null;
        interpAt = null;
        interpFrozen = false;
        selected = onPoint;
        armKeyboard();
        renderSide();
        draw();
        void audition(onPoint, true, 'click');
        return;
      }
      if (interpFrozen) {
        // Clicking again releases it and blends wherever you clicked.
        interpFrozen = false;
        runInterpolation(mx, my);
      } else {
        runInterpolation(mx, my);
        interpFrozen = true;
      }
      renderSide();
      draw();
      return;
    }

    const hit = pick(e.clientX - rect.left, e.clientY - rect.top);
    // Clicking the selected point again lets it go, so clearing a selection
    // does not mean hunting for empty space in a dense plot.
    if (hit >= 0 && hit === selected) {
      selected = -1;
      hovered = hit;
      armKeyboard();
      renderSide();
      draw();
      return;
    }
    selected = hit;
    armKeyboard();
    renderSide();
    draw();
    if (hit >= 0) void audition(hit, false, 'click');
  });

  wrap.addEventListener('wheel', (e) => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const factor = Math.exp(-e.deltaY * 0.0015);
    const next = Math.max(0.4, Math.min(80, scale * factor));
    const k = next / scale;
    offsetX = mx - (mx - offsetX) * k;
    offsetY = my - (my - offsetY) * k;
    scale = next;
    draw();
  }, { passive: false });

  wrap.addEventListener('mouseleave', () => {
    hovered = -1;
    draw();
  });
}

export const view: View = {
  flush: true,
  mount(container, c) {
    ctx = c;
    root = container;
    clear(root);

    canvas = el('canvas') as HTMLCanvasElement;
    overlay = el('canvas', { style: { pointerEvents: 'none' } }) as HTMLCanvasElement;
    legendEl = el('div', { class: 'legend', style: { padding: '8px 12px', borderTop: '1px solid var(--line)' } });
    sideEl = el('aside', { class: 'map-side' });
    controlsEl = el('div', { class: 'map-controls' });

    const wrap = el('div', { class: 'map-canvas-wrap' }, canvas, overlay);
    listEl = el('div', { class: 'list-pane', hidden: true });
    const main = el('div', { class: 'map-main' }, controlsEl, wrap, listEl, legendEl);
    const layout = el('div', { class: 'map-layout' }, main, sideEl);
    layout.appendChild(sidebarSplitter(layout, { key: 'ui.mapSideWidth', defaultWidth: 300 }));
    root.appendChild(layout);

    list = createListView(listEl, ctx.store, listState, {
      onHover: (i) => {
        if (selected >= 0) return;
        hovered = i;
        armKeyboard();
        renderSide();
        void audition(i, true, 'hover');
        list?.refresh();
      },
      onOpen: (i) => {
        selected = selected === i ? -1 : i;
        hovered = i;
        armKeyboard();
        renderSide();
        void audition(i, false, 'click');
        list?.refresh();
      },
      onRate: (i, value) => {
        void ctx.store.rate(i, value, 'round1').then(() => list?.refresh());
      },
      current: () => (selected >= 0 ? selected : hovered),
      pinned: () => selected,
      matched: () => (searchMode === 'highlight' ? matched : null),
    }, () => {
      setSetting('map.listSort', listState.sort);
      setSetting('map.listDescending', listState.descending);
      refreshList();
    });
    applyMode();

    // The second control row is inserted after controlsEl by renderControls.
    computeLayout();
    renderControls();
    renderLegend();
    renderSide();
    attachCanvasEvents();
    draw();

    const onResize = () => draw();
    window.addEventListener('resize', onResize);

    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const i = targetVoice();
      if (e.key >= '1' && e.key <= '5') {
        if (i < 0) return;
        e.preventDefault();
        void rateTarget(Number(e.key));
      } else if (e.key.toLowerCase() === 'p') {
        if (i < 0) return;
        e.preventDefault();
        void ctx.store.togglePin(i).then(() => {
          renderSide();
          draw();
        });
      } else if (e.key === ' ') {
        if (i < 0) return;
        e.preventDefault();
        void audition(i, true);
      } else if (e.key === 'Escape') {
        if (selected < 0) return;
        e.preventDefault();
        selected = -1;
        renderSide();
        draw();
      }
    };
    window.addEventListener('keydown', onKey);
    const unsubKeyboard = keyboard.subscribe(() => renderControls());
    unsubscribe = () => {
      window.removeEventListener('resize', onResize);
      window.removeEventListener('keydown', onKey);
      unsubKeyboard();
    };
    requestAnimationFrame(() => {
      computeLayout();
      draw();
    });
  },
  unmount() {
    list = null;
    listEl = null;
    unsubscribe?.();
    unsubscribe = null;
    ctx?.player.stop();
    keyboard.engine.allNotesOff();
  },
};
