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
import { matchesQuery, parseQuery, isActiveQuery, type SearchQuery, type SearchScope } from '../search.ts';
import { getSetting, setSetting } from '../settings.ts';
import { richSelect } from '../menu.ts';
import { adv, isAdvanced } from '../advanced.ts';
import { loopPhrase, usePhrase } from '../soundBar.ts';
import { blendWeights, dominantAlgorithm, interpolateVoices, inverseDistanceWeights, voiceHash, type InterpolationResult } from '../../engine/interpolate.ts';

type AxisId = string;

interface Axis {
  id: AxisId;
  label: string;
  /**
   * The name to draw on the plot, when the picker's name says more.
   *
   * A few axes carry a figure of merit in their label - how much of the
   * variance this component explains, how well the taste model scores. That is
   * exactly what you want when choosing between sixty axes in a dropdown, and
   * noise once the axis is chosen and drawn along the edge of its own chart,
   * where the only question left is which way is which.
   */
  short?: string;
  /**
   * What the two ends mean, when the axis knows better than the table does.
   *
   * An empty pair means the direction is not a quantity and saying "low" and
   * "high" about it would be a lie.
   */
  ends?: [string, string];
  value: (i: number) => number;
}

/**
 * What the two ends of an axis mean, in words.
 *
 * "brightness (oct above f0)" tells you what is being measured and nothing at
 * all about which way is which, so reading a scatter meant hovering a point at
 * each end to work out the direction. A pair of adjectives either side of the
 * name answers it before you have to ask.
 *
 * Only the axes worth plotting are listed. Everything else falls back to low
 * and high, which is honest and still better than nothing.
 */
const AXIS_ENDS: Record<string, [string, string]> = {
  attack: ['sharper', 'slower'],
  decay: ['shorter', 'longer'],
  release: ['shorter', 'longer'],
  sustain: ['plucked', 'sustained'],
  brightness: ['darker', 'brighter'],
  absBrightness: ['darker', 'brighter'],
  attackBrightness: ['soft edge', 'hard edge'],
  brightnessSlope: ['closes down', 'opens up'],
  inharmonicity: ['harmonic', 'clangy'],
  oddEven: ['even harmonics', 'odd harmonics'],
  flatness: ['tonal', 'noisy'],
  spread: ['narrow', 'wide'],
  register: ['low', 'high'],
  loudness: ['quiet', 'loud'],
  velLevel: ['velocity does little', 'velocity does a lot'],
  velBrightness: ['tone stays put', 'tone opens with force'],
  velAttack: ['attack fixed', 'attack follows force'],
  keyBrightness: ['even across the keys', 'brighter up top'],
  keyLevel: ['even across the keys', 'louder up top'],
  keyDecay: ['even across the keys', 'shorter up top'],
  modResponse: ['wheel does nothing', 'wheel does a lot'],
  modVibrato: ['no vibrato', 'deep vibrato'],
  modTremolo: ['no tremolo', 'deep tremolo'],
  modTimbre: ['tone fixed', 'wheel opens the tone'],
  modBrightness: ['no change', 'brightens'],
  predicted: ['you would not', 'you would'],
  rating: ['unrated and low', 'five stars'],
  familySounds: ['nothing else like it', 'a crowded corner'],
  familySize: ['one of a kind', 'many near-copies'],
  algorithm: ['algorithm 1', 'algorithm 32'],
  carriers: ['one carrier', 'many carriers'],
  feedback: ['none', 'strong'],
  activeOps: ['few operators', 'all six'],
  lfoSpeed: ['slow', 'fast'],
  pca1: ['', ''],
  pca2: ['', ''],
  lda1: ['', ''],
  lda2: ['', ''],
};

function axisEnds(id: AxisId): [string, string] {
  return axisById(id).ends ?? AXIS_ENDS[id] ?? ['low', 'high'];
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
/*
 * Trimmed from 0.28, because the brightness peaks at the default zoom.
 *
 * That peak is inherent rather than a bug in the scaling: zoomed all the way
 * out is where the whole corpus is packed into the plot and the overlap is
 * greatest, and zooming in spreads the same points over more area. The
 * adaptive alpha raises the weight as the crowding eases, which is what fixes
 * the far-out view being a haze, and the two effects cross near the default.
 * So the base is set for that crossing rather than for either extreme.
 */
const BASE_ALPHA = 0.25;
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
/**
 * A voice the cursor is over in the family or duplicate lists.
 *
 * Separate from `hovered` on purpose. Those lists sit beside a patch you have
 * pinned, and the sidebar has to go on showing that patch while you run down
 * them - so this marks the map without disturbing anything else.
 */
let listed = -1;
let selected = -1;
/**
 * Scatter, table, or both.
 *
 * The same voices, the same filters, the same sidebar - only the drawing
 * differs. The map answers "what lives over here"; the list answers "what have
 * I decided, and sorted by what". They are worth having at the same time, which
 * is why this is three states rather than a toggle - and why it is a segmented
 * control rather than the dropdown it used to be, where the fact that a table
 * existed at all was a line item in a menu of seventeen.
 */
type Mode = 'map' | 'split' | 'list';
/*
 * The plot alone by default.
 *
 * Split was the default on the reasoning that showing both says what the
 * screen can do. It also halves the only thing anybody came here for: the map
 * is the view you read by sweeping it, and a plot given half the height is a
 * plot you zoom before you can use. The table is one click away and keeps
 * whatever state you leave it in, so anyone who wants it has it.
 */
let mode: Mode = getSetting<Mode>('map.mode', 'map');
/** How tall the plot is in split mode, dragged by the divider. */
let plotHeight = getSetting('map.plotHeight', 340);
let splitEl: HTMLElement | null = null;
let plotEl: HTMLElement | null = null;
let resetEl: HTMLElement | null = null;
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
let sizeAxisId: AxisId | '' = getSetting<AxisId | ''>('map.sizeAxis', 'familySounds');
let sizes = new Float32Array(0);
/**
 * How much of the corpus to fold together before drawing it.
 *
 * There are two thresholds and therefore three answers, which is why this is a
 * pulldown rather than the checkbox it started as:
 *
 *   copies   every voice, including the forty files that are byte-identical
 *            once you ignore the name
 *   sounds   one dot per distinct sound - things below the merge threshold are
 *            the same patch and drawing forty of them says nothing
 *   family   one dot per family, so a cluster of forty near-relatives becomes
 *            the single representative you would actually rate
 *
 * The last is the one that makes a forty-thousand-voice corpus legible: the
 * plot stops being a solid mass of electric pianos and becomes the couple of
 * thousand decisions there actually are.
 */
type Collapse = 'copies' | 'sounds' | 'family';

/**
 * One dot per family by default.
 *
 * On a real corpus roughly half of everything is a near-relative of something
 * else, so drawing every copy makes the plot a solid mass with the same sound
 * in it forty times. Collapsing to families also puts the map in the units the
 * rating queue has always used: what you see is what you would be asked about.
 *
 * One per distinct sound by default, rather than one per family. A family is
 * the unit the rating queue works in, but it groups things that are audibly
 * different, so collapsing to it hides sounds you have never heard behind a
 * representative - fine for a work queue, wrong for a map you are exploring.
 * Distinct sounds is the finest grouping that still removes the copies.
 *
 * The stored value wins if there is one; failing that, an old checkbox that
 * was explicitly switched off still means "show me everything".
 */
const storedCollapse = getSetting<Collapse | ''>('map.collapse', '');
let collapse: Collapse = storedCollapse
  || (getSetting('map.collapseMerged', true) ? 'sounds' : 'copies');
/** Kept as a constant: the transport's play setting is the switch now. */
const hoverAudition = true;
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
/**
 * Widen a minimum rating to take in the unjudged as well.
 *
 * "Four stars or better" is what you have decided; "four stars or better, or
 * not rated yet" is that plus everything you have not decided about - the
 * keepers and the candidates, which together are the only patches still worth
 * looking at. Everything rated three or less has been ruled out and is just in
 * the way.
 */
let orUnrated = false;
let matched: Set<number> | null = null;
/**
 * Which patches count, by where they came from.
 *
 * Only offered when the corpus actually holds a prepared collection, because
 * until then everything is yours and the control would be a pulldown with one
 * meaningful entry.
 */
let focusOrigin: '' | 'mine' | 'bundled' = '';

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

const STAR = '\u2605';

// ------------------------------------------------------------------ axes

function axes(): Axis[] {
  const store = ctx.store;
  const list: Axis[] = [];
  if (store.projection) {
    const p = store.projection;
    const pct = (i: number) => ((store.pcaExplained[i] ?? 0) * 100).toFixed(0);
    list.push({ id: 'pca1', label: `variation axis 1 (${pct(0)}%)`, short: 'variation axis 1', value: (i) => p[i * 2] });
    list.push({ id: 'pca2', label: `variation axis 2 (${pct(1)}%)`, short: 'variation axis 2', value: (i) => p[i * 2 + 1] });
  }
  /*
   * The neighbourhood map.
   *
   * First in the list when it exists, because it is the one that answers the
   * question people actually bring to a map of sounds: is this near the things
   * it sounds like. Its two axes have no meaning individually - they are the
   * two directions of a layout, not measurements of anything - so they are
   * only ever offered as a pair, and the ends are left unlabelled.
   */
  if (store.embedding && store.embedding.length >= store.voices.length * 2) {
    const e = store.embedding;
    list.push({ id: 'embed1', label: 'neighbourhood map (across)', short: 'neighbourhood map', ends: ['', ''], value: (i) => e[i * 2] });
    list.push({ id: 'embed2', label: 'neighbourhood map (down)', short: '', ends: ['', ''], value: (i) => e[i * 2 + 1] });
  }
  if (store.ldaProjection) {
    const p = store.ldaProjection;
    const pct = (i: number) => ((store.ldaExplained[i] ?? 0) * 100).toFixed(0);
    list.push({ id: 'lda1', label: `category axis 1 (${pct(0)}% of separation)`, short: 'category axis 1', value: (i) => p[i * 2] });
    list.push({ id: 'lda2', label: `category axis 2 (${pct(1)}% of separation)`, short: 'category axis 2', value: (i) => p[i * 2 + 1] });
  }
  for (let d = 0; d < FEATURE_COUNT; d++) {
    const def = FEATURE_DEFS[d];
    list.push({ id: def.name, label: def.label, value: (i) => store.analysis[i]?.vector[d] ?? 0 });
  }
  // The thing the whole app is for. It was available as a colour and not as an
  // axis, which meant you could not plot what you actually think against
  // anything the app measured.
  list.push({
    id: 'rating',
    label: 'your rating',
    short: 'your rating',
    value: (i) => store.effectiveRating(i) ?? 0,
  });
  if (store.tasteModel) {
    list.push({
      id: 'predicted',
      label: `predicted rating (R\u00b2 ${store.tasteModel.r2.toFixed(2)})`,
      short: 'predicted rating',
      value: (i) => store.predictedRating(i) ?? 0,
    });
  }
  list.push({ id: 'algorithm', label: 'algorithm (1-32)', short: 'algorithm', value: (i) => (store.voices[i].unpacked[P.algorithm] & 31) + 1 });
  /*
   * Two ways to count a family, and they say different things.
   *
   * The number of voices counts every copy: a patch that twenty archives all
   * carried has a family of twenty before anything similar to it is
   * considered, so the dot grows for having been popular to redistribute
   * rather than for sitting in a crowded corner of the sound space. That is a
   * fact about the files, and occasionally the one you want.
   *
   * Counting distinct sounds instead - one per merge cluster, which is what a
   * face-off would actually be between - answers the question the size of a
   * dot is usually read as asking: how many genuinely different patches are
   * near enough to this one to be confused with it. That is the default.
   */
  list.push({
    id: 'familySounds',
    label: 'family size, ignoring copies',
    short: 'distinct sounds nearby',
    value: (i) => ctx.store.familyContenders(i).length,
  });
  list.push({ id: 'familySize', label: 'family size, counting every copy', short: 'copies nearby', value: (i) => ctx.store.clusterMembers(i).length });
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
    ids: ['pca1', 'pca2', 'lda1', 'lda2', 'rating', 'predicted'],
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
    ids: ['familySounds', 'familySize'],
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
  /*
   * Folding is only possible once there is something to fold by.
   *
   * Without the near-duplicate pass there are no representatives, every voice
   * fails the test, and the plot comes out empty - which reads as a broken map
   * rather than as a pass that has not run. It matters more now that this
   * screen is the first thing shown: the layout finishes before the grouping
   * does, so there is a window where the setting is real and the data is not.
   */
  const canFoldSounds = collapse === 'sounds' && store.mergeRepresentatives.length > 0;
  const canFoldFamily = collapse === 'family' && store.representatives.length > 0;

  visible = [];
  for (let i = 0; i < n; i++) {
    if (!store.analysis[i]) continue;
    if (canFoldSounds && !store.isMergeRepresentative(i)) continue;
    if (canFoldFamily && !store.isFamilyRepresentative(i)) continue;
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

/*
 * How much to shrink every dot, given how crowded the plot is.
 *
 * Dot sizes were fixed in pixels, which means the same corpus is a readable
 * field of points on a wide monitor and an undifferentiated smear in a narrow
 * pane - the structure is there in both, and in one of them every dot is
 * sitting on four others. What matters is not the pixel size but how much
 * room each point has, so the scale follows the spacing: the square root of
 * area over count, which is the average distance between neighbours if they
 * were spread evenly.
 *
 * Normalised so that the sizes chosen by hand come out unchanged at the size
 * of plot they were chosen on - about 1200 by 700 with a few thousand points -
 * and clamped, because a corpus of forty patches should not get dinner plates
 * and one of forty thousand should still leave something visible.
 */
/*
 * The spacing at which the hand-chosen size and weight are left alone.
 *
 * This has to be the ordinary case, not a convenient round number: a large
 * corpus in a window of a reasonable size, which is about thirty-five thousand
 * points in fourteen hundred by eight hundred. Calibrating it against a
 * smaller count instead made every realistic view come out below 1, so the
 * whole map dimmed - correct in the cramped pane it was tested in, and wrong
 * everywhere the app is actually used.
 */
const REFERENCE_SPACING = Math.sqrt((1400 * 800) / 35000);

function densityScale(w: number, h: number, count: number): number {
  if (count <= 0) return 1;
  const spacing = Math.sqrt((w * h) / count);
  return Math.max(0.45, Math.min(1.8, spacing / REFERENCE_SPACING));
}

let pointScale = 1;

function radiusOf(i: number): number {
  // Quantised to a quarter pixel: every distinct radius is a separate cached
  // sprite per colour, and the scale varies continuously with the zoom.
  return Math.max(0.55, Math.round((sizes[i] || BASE_RADIUS) * pointScale * 4) / 4);
}

/**
 * The order dots are painted in: biggest first, so the smallest end up on top.
 *
 * The hit test already ignores size, but that alone does not make a small dot
 * as easy to hit as a big one - a small dot painted underneath a big one is
 * invisible, and you cannot aim at what you cannot see. Painting small last
 * means every dot has some of itself showing, which is what actually equalises
 * them.
 *
 * Only worth computing when a size axis is on; with uniform dots the order
 * cannot matter, and sorting forty thousand indices for nothing is a cost paid
 * on every filter change.
 */
let drawOrder: number[] = [];

function computeDrawOrder(): void {
  if (!sizeAxisAtWork()) {
    drawOrder = visible;
    return;
  }
  drawOrder = visible.slice().sort((a, b) => radiusOf(b) - radiusOf(a));
}

/**
 * Sizing is off while every copy is drawn separately.
 *
 * Both size axes count a neighbourhood - how many distinct sounds, or how many
 * copies, sit close to this one - which is a property of the group a dot stands
 * for. With one dot per copy no dot stands for a group: the twenty copies of a
 * popular patch are twenty dots, each drawn at the size of all twenty, so the
 * crowded corner is drawn crowded *and* large and the same fact is counted
 * twice. The setting is kept, not cleared, so folding back to one per sound
 * brings the sizing back with it.
 */
function sizeAxisAtWork(): AxisId | '' {
  return collapse === 'copies' ? '' : sizeAxisId;
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
  /*
   * Uniform means the small end of the sizing range, not a middle.
   *
   * A dot with no number in it was drawn larger than the smallest dot of a
   * sized plot, so switching sizing on made most of the plot shrink - which
   * reads as the whole corpus having become less of something. The floor is
   * the floor either way: turning sizing on now only ever grows the dots that
   * earned it.
   */
  sizes = new Float32Array(n).fill(MIN_RADIUS);
  const active = sizeAxisAtWork();
  if (!active) {
    computeDrawOrder();
    return;
  }

  const axis = axisById(active);
  const raw = new Float32Array(n);
  const vals: number[] = [];
  for (const i of visible) {
    const v = axis.value(i);
    raw[i] = v;
    if (Number.isFinite(v)) vals.push(v);
  }
  if (vals.length === 0) {
    computeDrawOrder();
    return;
  }
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
  computeDrawOrder();
}

// ----------------------------------------------------------------- draw

function draw(): void {
  // There is nothing to reset until something has been zoomed or dragged, so
  // the button only exists once it would do something.
  if (resetEl) resetEl.hidden = scale === 1 && offsetX === 0 && offsetY === 0;
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
  // From the stylesheet, so the legend fading out over the bottom of the plot
  // is fading into exactly this colour and not one near it.
  g.fillStyle = plotBackground();
  g.fillRect(0, 0, w, h);

  const store = ctx.store;
  const lassoSet = lassoSelection.length ? new Set(lassoSelection) : null;
  const highlight = searchMode === 'highlight' && matched ? matched : null;

  /*
   * Crowding decides both the size and the weight of a dot.
   *
   * Dots are drawn additively, so in a dense region twenty of them stack into
   * a flat white patch and whatever structure was in there is gone. Easing the
   * alpha down as the crowding goes up keeps the dense regions readable as
   * regions - and because zooming in spreads the same points over more area,
   * it also means the picture gets crisper as you go in, rather than staying
   * the smear it was.
   */
  pointScale = densityScale(w * scale, h * scale, visible.length);
  // Quantised for the same reason as the radius.
  const round100 = (v: number) => Math.round(v * 100) / 100;
  const alpha = round100(Math.max(0.17, Math.min(0.55, BASE_ALPHA * Math.pow(pointScale, 0.7))));
  const dimAlpha = round100(Math.max(0.04, DIMMED_ALPHA * Math.pow(pointScale, 0.7)));

  /*
   * Dots land on whole device pixels.
   *
   * A sprite drawn at a fractional position is resampled across two pixels in
   * each direction, and the eye reads the result as out of focus - which it
   * is. Overlapping dots make it look worse but are not the cause: a single
   * isolated dot at x.5 is blurred too. Snapping costs nothing and is the
   * difference between a field of points and a haze.
   */
  const snap = (v: number) => Math.round(v * dpr) / dpr;

  g.globalAlpha = 1;
  for (const i of drawOrder) {
    const [px, py] = toScreen(i, w, h);
    if (px < -20 || py < -20 || px > w + 20 || py > h + 20) continue;
    const dimmed = (lassoSet && !lassoSet.has(i)) || (highlight && !highlight.has(i));
    const r = radiusOf(i);
    const spr = sprite(colourOf(i), r, dimmed ? dimAlpha : alpha, dpr);
    const size = spr.width / dpr;
    g.drawImage(spr, snap(px - size / 2), snap(py - size / 2), size, size);
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
  for (const [i, colour] of [[selected, '#ffffff'], [hovered, '#ffca6a'], [listed, '#ffca6a']] as const) {
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
    g.font = AXIS_FONT_STRONG;
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

  // The legend floats over the bottom of the plot, so the axis label sits
  // above it rather than underneath it.
  drawAxisLabels(g, w, h - (legendEl?.offsetHeight ?? 0));
}

let plotBg = '';

function plotBackground(): string {
  if (!plotBg) {
    plotBg = getComputedStyle(document.documentElement).getPropertyValue('--plot-bg').trim() || '#14161a';
  }
  return plotBg;
}

/**
 * What the two axes are, said plainly.
 *
 * Centred on each edge rather than tucked into the bottom-left corner, at a
 * size you can read without leaning in, and with a dark halo so they survive
 * being drawn over a dense patch of dots. These are the only thing on the plot
 * that says what you are looking at - a scatter with no axis labels is a
 * picture of nothing - and they were 11px grey in the corner, where the
 * y-axis one could run off the bottom of a short plot in split mode.
 */
function drawAxisLabels(g: CanvasRenderingContext2D, w: number, h: number): void {
  g.save();
  g.shadowColor = 'rgba(0, 0, 0, 0.9)';
  g.shadowBlur = 6;
  g.textBaseline = 'alphabetic';

  /*
   * One line reading `softer <- attack -> harder`, centred on its axis.
   *
   * The name is set brighter and heavier than the two ends, so the eye gets
   * "attack" first and the direction second - which is the order you want them
   * in. Drawn in three pieces around the centre rather than as one string,
   * because the name has to be centred whether or not the two ends are the
   * same length.
   */
  const measure = (parts: Array<[string, boolean]>): number => {
    let width = 0;
    for (const [text, strong] of parts) {
      g.font = strong ? AXIS_FONT_STRONG : AXIS_FONT;
      width += g.measureText(text).width;
    }
    return width;
  };

  /**
   * The line for one axis, dropped back to the bare name when the full one
   * will not fit along that edge.
   *
   * Worth doing rather than letting it overflow: the y-axis label is rotated,
   * so a line too long for a short plot does not truncate at the edge - it
   * runs off the top of the canvas and takes the axis name with it, which is
   * the one word that had to survive.
   */
  const line = (id: AxisId, room: number): { parts: Array<[string, boolean]>; width: number } => {
    const [lo, hi] = axisEnds(id);
    const axis = axisById(id);
    const name = axis.short ?? axis.label;
    if (lo) {
      const full: Array<[string, boolean]> = [
        [`${lo}  ←  `, false], [name, true], [`  →  ${hi}`, false],
      ];
      const width = measure(full);
      if (width <= room) return { parts: full, width };
    }
    // Even the name alone can be longer than a short edge, and a rotated label
    // does not truncate at the edge - it runs off it.
    g.font = AXIS_FONT_STRONG;
    let text = name;
    while (text.length > 4 && g.measureText(`${text}…`).width > room) {
      text = text.slice(0, -1);
    }
    const bare: Array<[string, boolean]> = [[text === name ? name : `${text}…`, true]];
    return { parts: bare, width: measure(bare) };
  };

  const put = (parts: Array<[string, boolean]>, startX: number) => {
    let at = startX;
    for (const [text, strong] of parts) {
      g.font = strong ? AXIS_FONT_STRONG : AXIS_FONT;
      g.fillStyle = strong ? '#c9d0dc' : '#8d95a3';
      g.fillText(text, at, 0);
      at += g.measureText(text).width;
    }
  };

  // Each label is centred along its own edge, minus a margin at both ends.
  const x = line(xAxisId, w - 40);
  g.save();
  g.translate(0, h - 9);
  put(x.parts, Math.max(10, (w - x.width) / 2));
  g.restore();

  const y = line(yAxisId, h - 40);
  g.save();
  g.translate(16, (h + Math.min(y.width, h - 20)) / 2);
  g.rotate(-Math.PI / 2);
  put(y.parts, 0);
  g.restore();

  g.restore();
}

// Canvas text does not inherit, so the plot has to name the face itself.
const AXIS_FONT = "11.5px 'Space Mono', ui-monospace, monospace";
const AXIS_FONT_STRONG = "700 12.5px 'Space Mono', ui-monospace, monospace";

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
/**
 * The voice under the cursor: nearest centre within a fixed radius.
 *
 * Fixed, deliberately - the drawn radius never enters this. Sizing dots by
 * family size means some are four times the area of others, and if the target
 * grew with them, the patches with forty near-copies would be easy to land on
 * and the one-of-a-kind ones would be nearly unhittable. Those are exactly
 * backwards: a sound nothing else in the corpus resembles is the more
 * interesting thing to point at.
 *
 * Draw order does the other half of this; see `drawOrder`.
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
  if (!usePhrase()) return singleNotePhrase(auditionNote, auditionVel);
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
  // Something is about to play; a stop queued on the way here must not land
  // on top of it.
  cancelSilence();
  if (auto && !ctx.player.mayPlay(auto)) return;
  const v = ctx.store.voices[i];
  if (!v) return;
  if (!usePhrase()) {
    await ctx.player.audition(v.id, v.unpacked, singleNotePhrase(auditionNote, auditionVel), { loop: loopPhrase() });
    return;
  }
  if (quick) {
    await ctx.player.auditionProgressive(v.id, v.unpacked, HOVER_PHRASE, DEMO_PHRASE, { loop: loopPhrase() });
  } else {
    await ctx.player.audition(v.id, v.unpacked, DEMO_PHRASE, { loop: loopPhrase() });
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
      void ctx.player.audition(id, interpResult.voice, phrase(false), { loop: loopPhrase() });
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
      class: interpFrozen ? 'btn on' : 'btn',
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
        void ctx.player.audition(id, interpResult.voice, phrase(true), { loop: loopPhrase() });
      },
    }, 'Play in full'),
    el('button', {
      class: 'btn',
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
    'Kept patches become favourites and are flagged as yours, so they go into the final 128 regardless of rating. ',
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
    autoPlay: ctx.player.autoPlay,
    onHover: (n) => {
      // Leaving the list puts everything back on whatever is selected - the
      // keyboard, and the sound too. Having gone down the family to compare
      // them, what you want next is the one you pinned, and having to click it
      // again to get it back is a step that says nothing.
      if (listed !== n) {
        listed = n;
        draw();
      }
      if (n < 0) {
        armKeyboard();
        const back = selected >= 0 ? selected : hovered;
        if (back >= 0 && ctx.player.mayPlay('hover')) {
          lastAuditionAt = performance.now();
          void audition(back, false, 'hover');
        }
        return;
      }
      // Overrides the pinned selection, deliberately: the whole point of this
      // list is to compare the family against the patch you have pinned, so
      // hovering one has to sound, and the keyboard has to follow what you are
      // hearing rather than stay on the pin.
      keyboard.setPatch(ctx.store.voices[n]?.unpacked ?? null);
      // The same rate limit a sweep across the map or down the table uses:
      // without it, running the cursor down a family of forty queues forty
      // renders and the sound arrives long after the cursor has gone.
      const now = performance.now();
      if (now - lastAuditionAt <= HOVER_INTERVAL_MS) return;
      lastAuditionAt = now;
      void audition(n, true, 'hover');
    },
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
      // The table draws the pin and the rating too, so a change made in the
      // sidebar has to reach it or the row sits there contradicting the panel
      // right next to it.
      list?.refresh();
    },
  }));
}

/**
 * Open Browse with a search already typed in.
 *
 * Set rather than applied: the caller is on another screen and this module may
 * not be mounted, and mounting runs the filter anyway.
 */
export function presetSearch(text: string, scope: SearchScope = 'all'): void {
  searchText = text;
  searchScope = scope;
  searchMode = 'only';
  searchOpen = true;
}

// ---------------------------------------------------------------- controls

function applyFilters(): void {
  query = parseQuery(searchText);
  const filtering = isActiveQuery(query) || focusCategory !== '' || focusRating !== '' || focusOrigin !== '';
  matched = filtering ? new Set<number>() : null;
  if (matched) {
    const store = ctx.store;
    for (let i = 0; i < store.voices.length; i++) {
      if (focusOrigin === 'mine' && !store.isMine(i)) continue;
      if (focusOrigin === 'bundled' && store.isMine(i)) continue;
      const cat = store.categoryOf(i);
      if (focusCategory && cat !== focusCategory) continue;
      if (focusSub && store.subcategoryOf(i) !== focusSub) continue;
      if (focusRating !== '') {
        const r = store.ratingOf(i);
        if (focusRating === 'unrated') {
          if (r !== null) continue;
        } else if (orUnrated) {
          if (r !== null && r < focusRating) continue;
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
  if (!list || mode === 'map') return;
  list.update(sortIndices(ctx.store, visible, listState));
}

/**
 * Give the plot and the table the room the current mode says they get.
 *
 * In split the plot is a fixed band and the table takes whatever is left, so
 * dragging the divider means one number. The hidden half is genuinely hidden -
 * `[hidden]` outranks the pane's own `display: flex` - which is what makes a
 * folded-away table cost nothing rather than quietly rendering rows behind the
 * one you are looking at.
 */
/**
 * Point the table at whatever the plot is pointing at.
 *
 * The two halves of split mode show the same set and had no idea about each
 * other: hovering a dot told you nothing about where that patch was in the
 * table, and the table might be scrolled thousands of rows away from it. Both
 * are views of one selection, so both follow it.
 *
 * Only scrolls when the row is actually off screen - `reveal` checks - since
 * yanking the table under the cursor on every pixel of a sweep across the plot
 * would be unusable.
 */
function syncList(): void {
  if (!list || mode === 'map') return;
  const target = selected >= 0 ? selected : hovered;
  if (target >= 0) list.reveal(target);
  else list.mark();
}

/**
 * Move to the next or previous row, and play it.
 *
 * Walks the order the table is actually sorted in rather than the order the
 * corpus is stored in, so stepping down after sorting by rating goes down the
 * ratings. The selection follows, which means the sidebar and the plot follow
 * too - they are all pointed at the same thing.
 */
function stepList(delta: number): void {
  const order = sortIndices(ctx.store, visible, listState);
  if (order.length === 0) return;
  const current = selected >= 0 ? selected : hovered;
  const at = order.indexOf(current);
  const next = at < 0
    ? (delta > 0 ? 0 : order.length - 1)
    : Math.max(0, Math.min(order.length - 1, at + delta));
  const target = order[next];
  if (target === undefined) return;
  selected = target;
  hovered = target;
  armKeyboard();
  renderSide();
  list?.reveal(target);
  draw();
  void audition(target, false, 'click');
}

function applyMode(): void {
  if (!listEl || !canvas) return;
  listEl.hidden = mode === 'map';
  if (splitEl) splitEl.hidden = mode !== 'split';
  if (plotEl) {
    plotEl.hidden = mode === 'list';
    plotEl.style.flex = mode === 'split' ? '0 0 auto' : '1';
    plotEl.style.height = mode === 'split' ? `${fittedPlotHeight()}px` : '';
  }
  if (mode !== 'map') refreshList();
  if (mode !== 'list') draw();
}

/**
 * The draggable edge between the plot and the table in split mode.
 *
 * Dragging it to either end is also how you fold one away without reaching for
 * the mode switch, which is the gesture most people try first.
 */
function makeSplitter(): HTMLElement {
  const handle = el('div', { class: 'pane-split', title: 'Drag to resize. Double-click to even it up.' });
  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    handle.classList.add('dragging');
    const top = plotEl ? plotEl.getBoundingClientRect().top : 0;

    const move = (ev: PointerEvent) => setPlotHeight(ev.clientY - top);
    const up = (ev: PointerEvent) => {
      handle.releasePointerCapture(ev.pointerId);
      handle.classList.remove('dragging');
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      setSetting('map.plotHeight', plotHeight);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
  });
  handle.addEventListener('dblclick', () => {
    setPlotHeight(plotRoom() / 2);
    setSetting('map.plotHeight', plotHeight);
  });
  return handle;
}

/**
 * How much room is left for the plot once the controls have had theirs.
 *
 * The stored height is a preference, not a promise: a window shorter than the
 * last one, or a control bar that has wrapped onto a second row, can leave less
 * room than the number that was saved. Without clamping on every layout - not
 * only on drag - the plot simply overflows the column and the table underneath
 * it gets nothing, which looks exactly like split mode being broken.
 */
function plotRoom(): number {
  const main = plotEl?.parentElement;
  if (!main) return window.innerHeight;
  // Two gutters, and enough left over for a usable handful of rows.
  return main.clientHeight - controlsEl.offsetHeight - 24 - MIN_LIST_HEIGHT;
}

function fittedPlotHeight(): number {
  return Math.round(Math.max(MIN_PLOT_HEIGHT, Math.min(plotRoom(), plotHeight)));
}

/**
 * Go quiet, but only once the cursor has really stopped on nothing.
 *
 * Stopping the moment the cursor is off a point was wrong in the most common
 * case there is: sweeping from one dot to the next crosses empty space, so the
 * sound was cut on the way and the arrival was then swallowed by the audition
 * rate limit, leaving a named patch in the sidebar and silence in the room.
 *
 * The delay is longer than that rate limit on purpose. A crossing that lands
 * on another dot never trips it, and if it does trip - because the crossing
 * was slow - enough time has passed that the next audition is allowed through
 * anyway. Parking on the background still goes quiet, which is the case this
 * is for.
 */
const SILENCE_DELAY_MS = 280;
let silenceTimer: number | null = null;

function cancelSilence(): void {
  if (silenceTimer === null) return;
  window.clearTimeout(silenceTimer);
  silenceTimer = null;
}

function scheduleSilence(): void {
  cancelSilence();
  // A pinned patch owns the sound, and a sound started by clicking was asked
  // for - neither should stop because the cursor wandered off a dot.
  if (selected >= 0 || !ctx.player.mayPlay('hover')) return;
  silenceTimer = window.setTimeout(() => {
    silenceTimer = null;
    if (hovered < 0 && selected < 0) ctx.player.stop();
  }, SILENCE_DELAY_MS);
}

/** Clamp the plot band so neither half can be dragged out of existence. */
function setPlotHeight(px: number): void {
  plotHeight = Math.round(Math.max(MIN_PLOT_HEIGHT, Math.min(plotRoom(), px)));
  applyMode();
}

const MIN_PLOT_HEIGHT = 120;
const MIN_LIST_HEIGHT = 110;

/**
 * Ready-made pairs of axes.
 *
 * There are sixty-odd axes and a few thousand possible pairs of them, almost
 * all of which produce a cloud that tells you nothing. Two dropdowns of sixty
 * is a control that technically offers everything and in practice offers
 * whichever two you picked the first time. These are the views worth opening
 * the map on, each answering a question you would actually ask; the raw axes
 * are still there under the advanced switch for when you have a specific one
 * in mind.
 */
interface MapPreset {
  id: string;
  label: string;
  x: AxisId;
  y: AxisId;
  colour: typeof colourBy;
  /** What you are looking at, in one line. */
  note: string;
}

const PRESETS: MapPreset[] = [
  {
    id: 'neighbourhood', label: 'What sits near what', x: 'embed1', y: 'embed2', colour: 'category',
    note: 'laid out so that patches which sound alike land together; distance between groups means nothing',
  },
  {
    id: 'learned', label: 'Everything at once', x: 'pca1', y: 'pca2', colour: 'category',
    note: 'the two directions the corpus varies most in',
  },
  {
    id: 'categories', label: 'Kinds of sound', x: 'lda1', y: 'lda2', colour: 'category',
    note: 'the axes that separate the categories best',
  },
  {
    id: 'envelope', label: 'Attack / release', x: 'attack', y: 'release', colour: 'category',
    note: 'plucks bottom left, pads top right',
  },
  {
    id: 'timbre', label: 'Brightness / attack', x: 'attack', y: 'brightness', colour: 'category',
    note: 'the two things you hear in the first half second',
  },
  {
    id: 'taste', label: 'What you like', x: 'predicted', y: 'brightness', colour: 'rating',
    note: 'the model against timbre, so you can see whether it just likes one sound',
  },
  {
    id: 'dynamics', label: 'How it plays', x: 'velLevel', y: 'velBrightness', colour: 'category',
    note: 'how much velocity changes the level, and how much it changes the tone',
  },
  {
    id: 'modwheel', label: 'Mod wheel', x: 'modVibrato', y: 'modTimbre', colour: 'category',
    note: 'vibrato against timbre change; an unused wheel sits at the origin',
  },
  {
    id: 'copies', label: 'Where the copies are', x: 'familySize', y: 'predicted', colour: 'cluster',
    note: 'how many near-identical versions of each patch the corpus holds',
  },
];

/*
 * The neighbourhood map is the default.
 *
 * It is the one that answers the question a map of sounds is opened with - is
 * this near the things it sounds like - and it measures better at that than
 * the principal components do, on the real corpus, by a factor of about four.
 * The variation axes stay one selection away for the times you want the other
 * kind of honesty: a projection where the distances mean something globally.
 *
 * Until the layout has been computed the preset does not exist, so the fall
 * back below hands it to the old default rather than letting axisById put both
 * axes on the same thing.
 */
let presetId = getSetting('map.preset', 'neighbourhood');

function applyPreset(id: string): void {
  const preset = PRESETS.find((item) => item.id === id);
  presetId = id;
  setSetting('map.preset', id);
  if (!preset) return;
  xAxisId = preset.x;
  yAxisId = preset.y;
  colourBy = preset.colour;
  setSetting('map.xAxis', xAxisId);
  setSetting('map.yAxis', yAxisId);
  setSetting('map.colourBy', colourBy);
  computeLayout();
  renderControls();
  renderLegend();
  draw();
}

/** Touching an axis by hand means you are no longer on a preset. */
function offPreset(): void {
  presetId = 'custom';
  setSetting('map.preset', 'custom');
}

// -------------------------------------------------------------- the search

let searchOpen = false;
let searchDebounce = 0;

function magnifier(): SVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('class', 'ico');
  svg.setAttribute('aria-hidden', 'true');
  const circle = document.createElementNS(ns, 'circle');
  circle.setAttribute('cx', '7');
  circle.setAttribute('cy', '7');
  circle.setAttribute('r', '4.4');
  const handle = document.createElementNS(ns, 'path');
  handle.setAttribute('d', 'M10.3 10.3 L14 14');
  for (const node of [circle, handle]) {
    node.setAttribute('fill', 'none');
    node.setAttribute('stroke', 'currentColor');
    node.setAttribute('stroke-width', '1.6');
    node.setAttribute('stroke-linecap', 'round');
    svg.appendChild(node);
  }
  return svg;
}

function searchControl(): HTMLElement {
  const active = searchText.trim().length > 0;
  const wrap = el('div', { class: 'search-wrap' });

  wrap.appendChild(el('button', {
    class: active ? 'search-btn on' : 'search-btn',
    title: 'Search names, aliases, categories and file paths',
    onclick: () => {
      searchOpen = !searchOpen;
      renderControls();
    },
  },
    // Drawn rather than typed. U+2315 is nominally a magnifier and renders
    // as a bare circle, a telephone recorder or nothing at all depending on
    // the font the system reaches for; an inline SVG is the same everywhere.
    magnifier(),
    active ? el('span', { class: 'q' }, searchText) : 'Search',
    active
      ? el('span', {
        class: 'x',
        title: 'Clear',
        onclick: (e: Event) => {
          e.stopPropagation();
          searchText = '';
          searchOpen = false;
          applyFilters();
        },
      }, '\u00d7')
      : null,
  ));

  if (!searchOpen) return wrap;

  const input = el('input', {
    class: 'text',
    type: 'search',
    value: searchText,
    placeholder: 'bank piano   \u00b7   e-piano OR rhodes',
    oninput: (e: Event) => {
      searchText = (e.target as HTMLInputElement).value;
      // Debounced: every keystroke rebuilds the match set over the whole
      // corpus, and at forty thousand voices that is not a cost worth paying
      // per character.
      clearTimeout(searchDebounce);
      searchDebounce = window.setTimeout(() => applyFilters(), 180);
    },
    onkeydown: (e: KeyboardEvent) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        clearTimeout(searchDebounce);
        applyFilters();
      } else if (e.key === 'Escape') {
        searchOpen = false;
        renderControls();
      }
    },
  }) as HTMLInputElement;

  const pop = el('div', { class: 'search-pop' },
    input,
    el('div', { class: 'row' },
      el('select', {
        onchange: (e: Event) => {
          searchScope = (e.target as HTMLSelectElement).value as typeof searchScope;
          setSetting('map.searchScope', searchScope);
          applyFilters();
        },
      },
        el('option', { value: 'name', selected: searchScope === 'name' }, 'name only'),
        el('option', { value: 'all', selected: searchScope === 'all' }, 'name and file path')),
      el('select', {
        onchange: (e: Event) => {
          searchMode = (e.target as HTMLSelectElement).value as typeof searchMode;
          setSetting('map.searchMode', searchMode);
          applyFilters();
        },
      },
        el('option', { value: 'highlight', selected: searchMode === 'highlight' }, 'highlight matches'),
        el('option', { value: 'only', selected: searchMode === 'only' }, 'show only matches')),
      matched
        ? el('label', { class: 'field' },
          el('input', {
            type: 'checkbox',
            checked: snapToMatches,
            onchange: (e: Event) => {
              snapToMatches = (e.target as HTMLInputElement).checked;
              setSetting('map.snapToMatches', snapToMatches);
            },
          }), 'snap to results')
        : null,
      matched ? el('span', { class: 'muted' }, fmtInt(matched.size) + ' match' + (matched.size === 1 ? '' : 'es')) : null,
    ),
    el('div', { class: 'note' },
      'Every word has to match somewhere. ', el('b', {}, 'OR'), ' or a comma separates alternatives, ',
      el('b', {}, '-word'), ' rules it out, ', el('b', {}, '"quotes"'), ' keep a phrase together.'),
  );
  wrap.appendChild(pop);

  setTimeout(() => {
    // Flip to the right when the popover would hang off the window. Letting it
    // overflow is not cosmetic: focusing the input makes the browser scroll it
    // into view, and the nearest scrollable ancestor is the whole map column,
    // which slides sideways and takes the control bar with it.
    if (wrap.getBoundingClientRect().left + pop.offsetWidth > window.innerWidth - 8) {
      pop.style.left = 'auto';
      pop.style.right = '0';
    }
    input.focus({ preventScroll: true });
    // Focus survives the rebuild that every keystroke causes, which is the
    // only reason this can be a live search rather than Enter-to-apply.
    input.setSelectionRange(input.value.length, input.value.length);
  }, 0);

  return wrap;
}

// ------------------------------------------------------------- the controls

function renderControls(): void {
  clear(controlsEl);
  const groups = groupedAxes();
  const important = importantAxisIds();
  const plot = mode !== 'list';

  const axisSelect = (
    current: AxisId | '', onChange: (id: AxisId) => void,
    first?: { value: string; label: string }, disabled?: boolean,
  ) =>
    el('select', {
      class: 'axis-select',
      disabled: !!disabled,
      onchange: (e: Event) => onChange((e.target as HTMLSelectElement).value),
    }, ...(first ? [el('option', { value: first.value, selected: current === first.value }, first.label)] : []),
    ...groups.map((g) => {
      const optgroup = el('optgroup', { label: g.label });
      for (const a of g.axes) {
        optgroup.appendChild(el('option', {
          value: a.id,
          selected: a.id === current,
        }, important.has(a.id) ? a.label : '  ' + a.label));
      }
      return optgroup;
    }));


  /**
   * One group of related controls, behind a small caps label.
   *
   * Without the grouping this bar was eight equal-weight widgets in a row, all
   * the same size, all the same colour, in no particular order - so finding the
   * one you wanted meant reading every one of them. Three groups with a rule
   * between them and a label on each is the difference between a control panel
   * and a toolbar.
   */
  const group = (label: string | null, ...items: Array<Node | null>) =>
    el('div', { class: 'ctl' }, label ? el('span', { class: 'ctl-label' }, label) : null, ...items);

  append(controlsEl, [
    // Both drawings, and the fact that there are two of them, in one control.
    group(null, el('div', { class: 'seg', title: 'The same voices and the same filters, drawn as a scatter, a table, or both.' },
      ...(['map', 'split', 'list'] as const).map((m) => el('button', {
        class: m === mode ? 'on' : '',
        onclick: () => {
          mode = m;
          setSetting('map.mode', m);
          renderControls();
          applyMode();
        },
      }, m === 'split' ? 'both' : m)))),

    plot ? el('span', { class: 'bar-sep' }) : null,

    // The caption belongs to the pulldown it describes, so it sits beside it
    // and truncates rather than being exiled to the end of the bar where it is
    // no longer obviously about anything.
    /*
     * The explanation belongs in the option, not beside the pulldown.
     *
     * Next to it, it describes the view you are already looking at - the one
     * moment you need it least. Inside, it is there while you are choosing
     * between nine of them, which is the only time "what is this one" is
     * actually being asked. A native select cannot hold it as anything but
     * more label, in the same weight and colour as the name, so this is not
     * one: richSelect draws the explanation as explanation.
     *
     * A preset whose axes this corpus has not got is left out entirely -
     * axisById would substitute the first axis for both and the plot would
     * come out as a diagonal line.
     */
    plot ? group('view', richSelect({
      value: presetId,
      title: 'Which pair of axes to plot, and what the dots are coloured by',
      onChange: (id) => applyPreset(id),
      options: [
        ...PRESETS.filter((item) => {
          const ids = new Set(axes().map((a) => a.id));
          return ids.has(item.x) && ids.has(item.y);
        }).map((item) => ({ value: item.id, label: item.label, note: item.note })),
        ...(presetId === 'custom'
          ? [{ value: 'custom', label: 'custom', note: 'axes you chose yourself' }]
          : []),
      ],
    })) : null,

    el('span', { class: 'bar-sep' }),

    /*
     * Yours or the app's is a question you ask once, if ever.
     *
     * It earns a permanent slot only while you are actively separating two
     * imports, which is a job with a beginning and an end - the rest of the
     * time it is a third pulldown in the group you reach for constantly, set
     * to "from anywhere" and saying nothing.
     */
    group('show', showSelect(), focusCategory ? subSelect() : null, adv(originSelect())),

    // ---- everything below is advanced ----
    adv(el('span', { class: 'bar-sep' })),
    adv(plot ? el('span', { class: 'ctl-label' }, 'axes') : null),
    adv(plot ? el('label', { class: 'field' }, 'x', axisSelect(xAxisId, (id) => {
      xAxisId = id;
      setSetting('map.xAxis', id);
      offPreset();
      computeLayout();
      renderControls();
      // An axis change can drop points too - anything without a finite value
      // on the new axis leaves the plot - so the count goes with it.
      renderLegend();
      draw();
    })) : null),
    adv(plot ? el('label', { class: 'field' }, 'y', axisSelect(yAxisId, (id) => {
      yAxisId = id;
      setSetting('map.yAxis', id);
      offPreset();
      computeLayout();
      renderControls();
      // An axis change can drop points too - anything without a finite value
      // on the new axis leaves the plot - so the count goes with it.
      renderLegend();
      draw();
    })) : null),
    adv(plot ? el('label', { class: 'field' }, 'colour',
      el('select', {
        onchange: (e: Event) => {
          colourBy = (e.target as HTMLSelectElement).value as typeof colourBy;
          setSetting('map.colourBy', colourBy);
          offPreset();
          renderLegend();
          draw();
        },
      }, ...(['category', 'subcategory', 'rating', 'predicted', 'cluster', 'source', 'algorithm'] as const).map((c) =>
        el('option', { value: c, selected: c === colourBy }, c)))) : null),
    adv(plot ? el('label', {
      class: collapse === 'copies' ? 'field off' : 'field',
      title: collapse === 'copies'
        ? 'Off while every copy is drawn: both size axes count what is near a dot, and with one dot per copy that gets counted once per copy.'
        : '',
    }, 'size', axisSelect(sizeAxisId, (id) => {
      sizeAxisId = id;
      setSetting('map.sizeAxis', id);
      computeSizes();
      draw();
    }, { value: '', label: 'uniform' }, collapse === 'copies')) : null),
    adv(el('span', { class: 'bar-sep' })),
    el('label', {
      class: 'field',
      title: 'How much to fold together: every copy, one per distinct sound, or one per family.',
    }, 'show one per',
      el('select', {
        onchange: (e: Event) => {
          collapse = (e.target as HTMLSelectElement).value as Collapse;
          setSetting('map.collapse', collapse);
          computeLayout();
          renderControls();
          // The legend carries the count of what is plotted, and folding is
          // the control that changes that count most - it was the one path
          // that redrew the dots without redrawing the number beside them.
          renderLegend();
          draw();
        },
      },
        el('option', { value: 'copies', selected: collapse === 'copies' }, 'copy'),
        el('option', { value: 'sounds', selected: collapse === 'sounds' }, 'distinct sound'),
        el('option', {
          value: 'family',
          selected: collapse === 'family',
          disabled: ctx.store.representatives.length === 0,
        }, 'family'),
      )),
    adv(plot ? el('label', {
      class: 'field',
      title: 'Play a patch blended from the voices nearest the cursor, rather than the nearest single patch. Only ever uses what is currently shown.',
    },
      el('input', {
        type: 'checkbox',
        checked: interpolateMode,
        onchange: (e: Event) => {
          interpolateMode = (e.target as HTMLInputElement).checked;
          setSetting('map.interpolate', interpolateMode);
          interpResult = null;
          interpFrozen = false;
          if (!interpolateMode) interpAt = null;
          renderControls();
          renderSide();
          draw();
        },
      }), 'interpolate') : null),
    adv(plot && interpolateMode ? el('label', { class: 'field' }, 'blend of',
      el('input', {
        type: 'number', min: 2, max: 32, value: interpNeighbours,
        style: { width: '54px' },
        onchange: (e: Event) => {
          interpNeighbours = Number((e.target as HTMLInputElement).value);
          setSetting('map.interpNeighbours', interpNeighbours);
        },
      })) : null),
    adv(interpolateMode ? el('label', {
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
      })) : null),
    adv(interpolateMode ? el('label', {
      class: 'field',
      title: 'How close to a real patch you have to be for it to win over a blend. Larger snaps to patches more readily; smaller gives you more room to blend between them.',
    }, 'snap',
      el('input', {
        type: 'number', min: 0, max: 40, value: interpSnapRadius,
        style: { width: '54px' },
        onchange: (e: Event) => {
          interpSnapRadius = Number((e.target as HTMLInputElement).value);
          setSetting('map.snapRadius', interpSnapRadius);
        },
      }), 'px') : null),

    /*
     * Last, at the end of everything.
     *
     * It is the only control here that is a text field, the only one that is
     * about finding one patch rather than about how the whole plot is drawn,
     * and the only one that grows when it is in use. In the middle of the bar
     * it pushed everything after it sideways every time it opened.
     */
    searchControl(),
  ]);
}

/** The one filter that earns a permanent slot: which slice am I looking at. */
/**
 * Yours, or the set that came with the app.
 *
 * The point of tagging a bundled collection is being able to put it away
 * again: after dropping a few of your own banks into forty thousand shipped
 * ones, "show me only what I brought" is the first thing you want and there is
 * otherwise no way to ask for it.
 */
function originSelect(): HTMLElement | null {
  const names = ctx.store.bundleNames();
  if (names.length === 0) return null;
  const label = names.length === 1 ? names[0] : 'what came with the app';
  return el('select', {
    title: 'Whether to show the patches you added, the ones that came with the app, or both.',
    onchange: (e: Event) => {
      focusOrigin = (e.target as HTMLSelectElement).value as typeof focusOrigin;
      applyFilters();
    },
  },
    el('option', { value: '', selected: focusOrigin === '' }, 'from anywhere'),
    el('option', { value: 'mine', selected: focusOrigin === 'mine' }, 'only what I added'),
    el('option', { value: 'bundled', selected: focusOrigin === 'bundled' }, `only ${label}`),
  );
}

function showSelect(): HTMLElement {
  return el('select', {
    onchange: (e: Event) => {
      const value = (e.target as HTMLSelectElement).value;
      focusSub = '';
      if (value === 'unrated' || value.startsWith('min') || value.startsWith('or')) {
        // "or4" is four-or-better plus the unrated; "min4" is four-or-better.
        orUnrated = value.startsWith('or');
        focusRating = value === 'unrated'
          ? 'unrated'
          : (Number(value.slice(orUnrated ? 2 : 3)) as 1 | 2 | 3 | 4 | 5);
        focusCategory = '';
        colourBy = 'rating';
        setSetting('map.colourBy', colourBy);
      } else {
        focusRating = '';
        orUnrated = false;
        focusCategory = value as Category | '';
        if (focusCategory) {
          colourBy = 'subcategory';
          setSetting('map.colourBy', colourBy);
        }
      }
      applyFilters();
    },
  },
    el('option', { value: '', selected: focusCategory === '' && focusRating === '' }, 'everything'),
    // Two ways to narrow the map, in one control because they are the same
    // question - which of these am I looking at - and only ever one at a time.
    // The group labels are the separator.
    el('optgroup', { label: 'category' },
      ...CATEGORIES.map((c) => el('option', { value: c, selected: c === focusCategory }, CATEGORY_LABELS[c]))),
    el('optgroup', { label: 'rating' },
      el('option', { value: 'unrated', selected: focusRating === 'unrated' }, 'not rated yet'),
      ...([1, 2, 3, 4, 5] as const).map((r) => el('option', {
        value: 'min' + r,
        selected: focusRating === r && !orUnrated,
      }, r === 1 ? 'rated at all' : r === 5 ? STAR.repeat(5) : STAR.repeat(r) + ' or better'))),
    // The working set: what you have kept, plus what you have not judged.
    // Everything in between has been ruled out and is only in the way.
    el('optgroup', { label: 'still in play' },
      ...([3, 4, 5] as const).map((r) => el('option', {
        value: 'or' + r,
        selected: focusRating === r && orUnrated,
      }, (r === 5 ? STAR.repeat(5) : STAR.repeat(r) + '+') + ', or not rated yet'))),
  );
}

function subSelect(): HTMLElement {
  const subDefs = focusCategory ? SUBCATEGORIES[focusCategory] ?? [] : [];
  return el('select', {
    onchange: (e: Event) => {
      focusSub = (e.target as HTMLSelectElement).value;
      applyFilters();
    },
  },
    el('option', { value: '', selected: focusSub === '' }, 'all subcategories'),
    ...subDefs.map((d) => el('option', { value: d.id, selected: d.id === focusSub }, d.label)),
  );
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
      syncList();
      if (selected < 0) {
        renderSide();
        armKeyboard();
      }
      // A pinned patch owns the sound. Sweeping the plot with one held would
      // otherwise cut it off and play whatever the cursor crossed, which
      // defeats the point of pinning: you pin a patch to keep listening to it
      // while you look around for the next one.
      const now = performance.now();
      if (hoverAudition && selected < 0 && hit >= 0 && now - lastAuditionAt > HOVER_INTERVAL_MS) {
        lastAuditionAt = now;
        void audition(hit, false, 'hover');
      }
      if (hit < 0) scheduleSilence();
      else cancelSilence();
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
    syncList();
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
    // Leaving the plot entirely is the same as leaving a point, for the same
    // reason - and the sidebar follows the cursor, so it is blank now too.
    if (selected < 0) {
      renderSide();
      scheduleSilence();
    }
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
    legendEl = el('div', { class: 'legend' });
    sideEl = el('aside', { class: 'map-side' });
    controlsEl = el('div', { class: 'map-controls' });

    // Floating over the plot rather than spending a slot in the control bar on
    // something you need about once a session, and only after zooming.
    resetEl = el('button', {
      class: 'map-reset',
      hidden: true,
      onclick: () => {
        scale = 1;
        offsetX = 0;
        offsetY = 0;
        draw();
      },
    }, 'Reset view');
    const wrap = el('div', { class: 'map-canvas-wrap' }, canvas, overlay, resetEl);
    // The plot and its legend are one card: the legend says what the colours on
    // the plot mean, so putting a gutter between them would be separating a
    // thing from its own caption.
    plotEl = el('div', { class: 'map-plot' }, wrap, legendEl);
    listEl = el('div', { class: 'list-pane', hidden: true });
    splitEl = makeSplitter();
    const main = el('div', { class: 'map-main' }, controlsEl, plotEl, splitEl, listEl);
    const layout = el('div', { class: 'map-layout' }, main, sideEl);
    layout.appendChild(sidebarSplitter(layout, {
      key: 'ui.mapSideWidth',
      defaultWidth: 380,
      onResize: () => draw(),
    }));
    root.appendChild(layout);

    list = createListView(listEl, ctx.store, listState, {
      onHover: (i) => {
        if (selected >= 0) return;
        hovered = i;
        armKeyboard();
        renderSide();
        list?.mark();
        // The plot marks what the cursor is on, wherever the cursor is.
        if (mode === 'split') draw();
        // The same rate limit the map uses for a sweep: without it, running the
        // cursor down the list queues one full render per row and the sound
        // arrives seconds after the cursor has gone.
        const now = performance.now();
        if (now - lastAuditionAt > HOVER_INTERVAL_MS) {
          lastAuditionAt = now;
          void audition(i, true, 'hover');
        }
      },
      onOpen: (i) => {
        selected = selected === i ? -1 : i;
        hovered = i;
        armKeyboard();
        renderSide();
        void audition(i, false, 'click');
        list?.mark();
        if (mode === 'split') draw();
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

    /*
     * Drop any saved axis that no longer exists.
     *
     * Settings outlive builds, and an axis can go away - a feature renamed, a
     * projection that needs data this corpus has not got. axisById falls back
     * to the first axis in the list, which is fine for one axis and
     * catastrophic for two: x and y both land on variation axis 1 and the map
     * draws every patch on a perfect diagonal, which looks like the projection
     * has broken rather than like a stale setting.
     */
    const available = new Set(axes().map((a) => a.id));
    const chosen = PRESETS.find((item) => item.id === presetId);
    if (chosen && (!available.has(chosen.x) || !available.has(chosen.y))) {
      // Its axes are not there - usually the layout has not been computed on
      // this corpus yet - so fall back rather than drawing a diagonal.
      const fallback = PRESETS.find((item) => available.has(item.x) && available.has(item.y));
      if (fallback) applyPreset(fallback.id);
    } else if (chosen) {
      xAxisId = chosen.x;
      yAxisId = chosen.y;
    }
    if (!available.has(xAxisId)) {
      xAxisId = 'pca1';
      setSetting('map.xAxis', xAxisId);
    }
    if (!available.has(yAxisId)) {
      yAxisId = available.has('pca2') ? 'pca2' : 'brightness';
      setSetting('map.yAxis', yAxisId);
    }
    if (xAxisId === yAxisId) {
      yAxisId = xAxisId === 'pca1' && available.has('pca2') ? 'pca2' : 'brightness';
      setSetting('map.yAxis', yAxisId);
    }
    if (sizeAxisId && !available.has(sizeAxisId)) {
      sizeAxisId = '';
      setSetting('map.sizeAxis', sizeAxisId);
    }

    // The second control row is inserted after controlsEl by renderControls.
    //
    // Through applyFilters rather than straight to the layout: the filters are
    // module state that outlives the mount, so arriving here with a search
    // already set - from the source table, or from the last time this screen
    // was open while ratings changed underneath it - has to recompute what
    // matches. Skipping it left the search box holding a query that had never
    // been run.
    applyFilters();
    renderLegend();
    renderSide();
    attachCanvasEvents();
    draw();

    const onResize = () => applyMode();
    window.addEventListener('resize', onResize);

    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const i = targetVoice();
      if (e.key >= '1' && e.key <= '5') {
        if (i < 0) return;
        e.preventDefault();
        void rateTarget(Number(e.key));
      } else if (e.key === '6' || e.code === 'Digit6' || e.key.toLowerCase() === 'p') {
        if (i < 0) return;
        e.preventDefault();
        void ctx.store.togglePin(i).then(() => {
          renderSide();
          draw();
          list?.refresh();
        });
      } else if (e.key === ' ') {
        if (i < 0) return;
        e.preventDefault();
        void audition(i, true);
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        // Step through the table from the keyboard, which is how you audition a
        // run of patches without taking a hand off it. Only in the table: on
        // the plot, "the next one" is not a question with an answer.
        if (mode === 'map' || !list) return;
        e.preventDefault();
        stepList(e.key === 'ArrowDown' ? 1 : -1);
      } else if (e.key === 'Escape') {
        if (selected < 0) return;
        e.preventDefault();
        selected = -1;
        renderSide();
        draw();
        // The table draws the pin too, so releasing it has to reach the row.
        list?.mark();
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
    cancelSilence();
    list = null;
    listEl = null;
    splitEl = null;
    plotEl = null;
    resetEl = null;
    unsubscribe?.();
    unsubscribe = null;
    ctx?.player.stop();
    keyboard.engine.allNotesOff();
  },
};
