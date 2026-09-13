/*
 * Naming the regions of the map, in the words the programmers used.
 *
 * The plot puts patches that sound alike next to each other, and it works -
 * but a field of coloured dots tells you there is structure without telling
 * you what any of it is. The colours name nine categories, which is the
 * classifier's vocabulary, not the corpus's: it can say "keys", and the thing
 * you are looking at is the Rhodes corner.
 *
 * The corpus can say it, though. Thirty years of programmers typed a name into
 * ten characters of sysex for every one of these patches, and 97.6% of them
 * are still readable words. Where a region of the map is full of patches
 * called RHODES, the word RHODES belongs on it.
 *
 * This is annotation and nothing else. Not one number here reaches the
 * layout, the clustering, the categories or the model - the map is laid out
 * from what the patches sound like, exactly as before, and then the labels are
 * read back off the finished picture. A wrong label is a wrong caption; it
 * cannot move a dot.
 *
 * What makes a word the name of a region:
 *
 *   it is there a lot      enough patches in the cell carry it, in absolute
 *                          terms and as a share, so one file of eight named
 *                          BELL cannot label a neighbourhood
 *   it is there unusually  far more than its share of the whole corpus. PIANO
 *                          is the commonest word in the archive, so finding it
 *                          somewhere is worth almost nothing; finding STEINWAY
 *                          in one cell is worth a great deal
 *
 * Those two pull against each other, which is the point: the score is the
 * number of patches carrying the word times the log of how surprising that is.
 * Measured on the shipped library, the top twenty come out as PIANO, BASS,
 * RHODES, CLAV, STRINGS, STEINWAY, ORGAN, SAX, HARP, BRASS, PLUCK, PIPES,
 * TIMPANI, PICCOLO, FLUTE, HARPSICHORD - which is a map legend.
 */

/** A word, and where on the plot it belongs. Coordinates are the plot's own. */
export interface MapLabel {
  text: string;
  x: number;
  y: number;
  /** Patches in the region carrying the word; used for ranking and for size. */
  hits: number;
  /** How many times more common here than in the corpus at large. */
  lift: number;
}

/*
 * Words that are in the archive but are not about the sound.
 *
 * Deliberately short. It is tempting to expand the abbreviations - BRS is
 * brass, PNO is piano - and that would be inventing vocabulary the corpus does
 * not have: if a region is full of patches called BRS then BRS is what is
 * written on them, and a reader who has just seen the patch names in the
 * sidebar will recognise it. Only words that carry no information at all are
 * dropped.
 */
const STOP = new Set([
  'THE', 'AND', 'NEW', 'OLD', 'DX7', 'DX', 'TX', 'SYX', 'VOICE', 'INIT',
  'SOUND', 'PATCH', 'VER', 'MIX', 'SET', 'BANK', 'ROM', 'CART', 'FOR', 'WITH',
]);

/** Words of at least three letters, upper-cased, from one patch name. */
export function nameTokens(name: string): string[] {
  const out: string[] = [];
  for (const t of String(name || '').toUpperCase().split(/[^A-Z]+/)) {
    if (t.length < 3 || t.length > 12 || STOP.has(t)) continue;
    if (!out.includes(t)) out.push(t);
  }
  return out;
}

export interface LabelInput {
  /** Indices currently plotted. Labels follow the filters for free. */
  visible: number[];
  /** Normalised plot coordinates, as the map computes them. */
  xs: Float32Array;
  ys: Float32Array;
  /** Tokens per voice, built once for the corpus and reused. */
  tokens: string[][];
  /** How many of the whole corpus carry each word. */
  docFreq: Map<string, number>;
  /** Size of the corpus the frequencies were counted over. */
  corpus: number;
}

/** Grid the plot is divided into. Fine enough to separate the Rhodes corner
 *  from the rest of the keys, coarse enough that a cell holds a neighbourhood
 *  rather than a handful of patches. */
const GX = 32;
const GY = 22;
/** A cell with less than this in it is not a region, it is a few dots. */
const MIN_CELL = 30;
/** And a word needs this many carriers, and this share of the cell. */
const MIN_HITS = 5;
const MIN_SHARE = 0.06;
/** Twice its corpus rate, below which "unusual" is not the word for it. */
const MIN_LIFT = 2;
/** The same word can name two places - there really are two organ regions -
 *  but not five, which is what an unmerged PIANO does to a plot. */
const MAX_PER_WORD = 2;

/**
 * Work out what to call each part of the plot.
 *
 * Returns them best first, as many as qualify; the caller draws as many as fit
 * without colliding, so zooming in reveals more of the same list rather than
 * recomputing a different one.
 */
export function nameLabels(input: LabelInput): MapLabel[] {
  const { visible, xs, ys, tokens, docFreq, corpus } = input;
  if (visible.length < MIN_CELL || corpus === 0) return [];

  interface Cell { n: number; sx: number; sy: number; counts: Map<string, number> }
  const cells = new Map<number, Cell>();

  for (const i of visible) {
    const x = xs[i];
    const y = ys[i];
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    // Outliers live outside nought-to-one; they fold into the edge cells,
    // which is where they are drawn crowded together anyway.
    const gx = Math.max(0, Math.min(GX - 1, Math.floor(x * GX)));
    const gy = Math.max(0, Math.min(GY - 1, Math.floor(y * GY)));
    const key = gy * GX + gx;
    let cell = cells.get(key);
    if (!cell) cells.set(key, (cell = { n: 0, sx: 0, sy: 0, counts: new Map() }));
    cell.n++;
    cell.sx += x;
    cell.sy += y;
    const ts = tokens[i];
    if (!ts) continue;
    for (const t of ts) cell.counts.set(t, (cell.counts.get(t) ?? 0) + 1);
  }

  // ---- the best word for each cell that has one ----
  const winner = new Map<number, string>();
  for (const [key, cell] of cells) {
    if (cell.n < MIN_CELL) continue;
    let bestWord = '';
    let bestScore = 0;
    for (const [t, hits] of cell.counts) {
      if (hits < MIN_HITS || hits / cell.n < MIN_SHARE) continue;
      const expected = ((docFreq.get(t) ?? 0) / corpus) * cell.n;
      if (expected <= 0) continue;
      const lift = hits / expected;
      if (lift < MIN_LIFT) continue;
      const score = hits * Math.log(lift);
      if (score > bestScore) {
        bestScore = score;
        bestWord = t;
      }
    }
    if (bestWord) winner.set(key, bestWord);
  }

  /*
   * Neighbouring cells that chose the same word are one place.
   *
   * Without this the biggest word in the archive gets the most labels: PIANO
   * wins nine adjacent cells and is drawn nine times across one region, which
   * is the opposite of naming it. Union-find over the grid, four-connected.
   */
  const parent = new Map<number, number>();
  const find = (k: number): number => {
    let root = k;
    while (parent.get(root) !== root) root = parent.get(root)!;
    while (parent.get(k) !== root) {
      const next = parent.get(k)!;
      parent.set(k, root);
      k = next;
    }
    return root;
  };
  for (const key of winner.keys()) parent.set(key, key);
  for (const key of winner.keys()) {
    const gx = key % GX;
    const gy = (key - gx) / GX;
    for (const [dx, dy] of [[1, 0], [0, 1]] as const) {
      const nx = gx + dx;
      const ny = gy + dy;
      if (nx >= GX || ny >= GY) continue;
      const nk = ny * GX + nx;
      if (winner.get(nk) !== winner.get(key)) continue;
      const a = find(key);
      const b = find(nk);
      if (a !== b) parent.set(a, b);
    }
  }

  interface Region { text: string; hits: number; pop: number; sx: number; sy: number }
  const regions = new Map<number, Region>();
  for (const [key, text] of winner) {
    const root = find(key);
    const cell = cells.get(key)!;
    let r = regions.get(root);
    if (!r) regions.set(root, (r = { text, hits: 0, pop: 0, sx: 0, sy: 0 }));
    r.hits += cell.counts.get(text) ?? 0;
    r.pop += cell.n;
    r.sx += cell.sx;
    r.sy += cell.sy;
  }

  const out: Array<MapLabel & { score: number }> = [];
  for (const r of regions.values()) {
    const expected = ((docFreq.get(r.text) ?? 0) / corpus) * r.pop;
    const lift = expected > 0 ? r.hits / expected : 1;
    out.push({
      text: r.text,
      // The centroid of every patch in the region, not of the cells - so the
      // word lands where the dots actually are and not in the middle of an L.
      x: r.sx / r.pop,
      y: r.sy / r.pop,
      hits: r.hits,
      lift,
      score: r.hits * Math.log(Math.max(1.01, lift)),
    });
  }
  out.sort((a, b) => b.score - a.score);

  const used = new Map<string, number>();
  const kept: MapLabel[] = [];
  for (const r of out) {
    const seen = used.get(r.text) ?? 0;
    if (seen >= MAX_PER_WORD) continue;
    used.set(r.text, seen + 1);
    kept.push({ text: r.text, x: r.x, y: r.y, hits: r.hits, lift: r.lift });
  }
  return kept;
}

/** Count how many patches in the whole corpus carry each word. */
export function countTokens(tokens: string[][]): Map<string, number> {
  const out = new Map<string, number>();
  for (const ts of tokens) {
    if (!ts) continue;
    for (const t of ts) out.set(t, (out.get(t) ?? 0) + 1);
  }
  return out;
}
