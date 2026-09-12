/*
 * Which of the files you dropped in are actually worth their space.
 *
 * Thirty thousand patches arrive as a handful of archives, and those archives
 * are not equal: one is somebody's curated working set, the next is every
 * cartridge ever dumped with the duplicates left in, and a third is four
 * hundred variations on INIT VOICE. That is the difference between an hour
 * well spent and an hour of pressing 1. You cannot see it from the file names,
 * but after a few hundred ratings it is sitting in the data.
 *
 * Two numbers per source, because they answer different questions:
 *
 *   your average   the mean of the ratings you actually gave in there, which
 *                  is the honest one and is missing for most sources
 *   expected       your ratings where you have them and the model's guess
 *                  everywhere else, which covers everything and is the one to
 *                  read when deciding where to point the next session
 *
 * Ranking by a raw mean would be useless: a folder with one five-star patch in
 * it would beat a folder with sixty good ones, every time, and the top of the
 * table would be nothing but sources you have barely touched. So the ordering
 * uses a mean pulled toward the corpus average by a few imaginary average
 * ratings - the standard fix, and the one that makes "best" mean "reliably
 * better" rather than "luckiest small sample". The displayed average stays
 * raw, since that is what you would compute by hand and disagreeing with the
 * order is easier when you can see both.
 */

export type SourceLevel = 'archive' | 'folder' | 'file';

export const SOURCE_LEVELS: ReadonlyArray<{ id: SourceLevel; label: string }> = [
  { id: 'archive', label: 'archive' },
  { id: 'folder', label: 'folder' },
  { id: 'file', label: 'file' },
];

/**
 * How many average ratings to add to every source before ranking it.
 *
 * Four is enough that a single five-star patch cannot carry a source to the
 * top - one 5 lands at 3.4 against a corpus mean of 3 - and small enough that
 * a dozen real ratings almost completely outvote it.
 */
export const PRIOR = 4;

/** The part of a path this level groups by. */
export function sourceKey(path: string, level: SourceLevel): string {
  if (level === 'file') return path;
  const cut = level === 'archive' ? path.indexOf('/') : path.lastIndexOf('/');
  return cut > 0 ? path.slice(0, cut) : path;
}

export interface SourceScore {
  key: string;
  /** Distinct voices that arrived from here. */
  voices: number;
  /** How many of those you have rated. */
  rated: number;
  /** Mean of your ratings here, or null if you have not rated any. */
  average: number | null;
  /** That mean pulled toward the corpus average. What the order is by. */
  score: number | null;
  /** Your ratings where they exist, predictions elsewhere. */
  expected: number | null;
}

export interface SourceRankInput {
  count: number;
  /** Every file one voice arrived in. Repeats within a source are fine. */
  filesOf(index: number): readonly string[];
  ratingOf(index: number): number | null;
  predictedOf?(index: number): number | null;
  level: SourceLevel;
  prior?: number;
}

export function rankSources(input: SourceRankInput): SourceScore[] {
  interface Group { voices: number; rated: number; sum: number; expSum: number; expN: number }
  const groups = new Map<string, Group>();

  // The corpus mean is over voices, not over source entries: a patch that
  // turns up in twenty archives is one opinion, not twenty.
  let allSum = 0;
  let allN = 0;
  const seen = new Set<string>();

  for (let i = 0; i < input.count; i++) {
    const rating = input.ratingOf(i);
    if (rating !== null) {
      allSum += rating;
      allN++;
    }
    const expect = rating ?? input.predictedOf?.(i) ?? null;

    // Once per source, however many of its files the voice sat in - a bank
    // that carries the same patch in three slots is not three endorsements.
    seen.clear();
    for (const path of input.filesOf(i)) {
      const key = sourceKey(path, input.level);
      if (seen.has(key)) continue;
      seen.add(key);
      let g = groups.get(key);
      if (!g) {
        g = { voices: 0, rated: 0, sum: 0, expSum: 0, expN: 0 };
        groups.set(key, g);
      }
      g.voices++;
      if (rating !== null) {
        g.rated++;
        g.sum += rating;
      }
      if (expect !== null) {
        g.expSum += expect;
        g.expN++;
      }
    }
  }

  const mean = allN > 0 ? allSum / allN : 0;
  const prior = input.prior ?? PRIOR;
  const out: SourceScore[] = [];
  for (const [key, g] of groups) {
    out.push({
      key,
      voices: g.voices,
      rated: g.rated,
      average: g.rated > 0 ? g.sum / g.rated : null,
      score: g.rated > 0 ? (g.sum + prior * mean) / (g.rated + prior) : null,
      expected: g.expN > 0 ? g.expSum / g.expN : null,
    });
  }
  return sortSources(out, 'score');
}

/**
 * Order by one of the two numbers.
 *
 * A source with nothing to say goes last whichever way round the sort is:
 * "worst first" means the worst of the ones you know about, not a list of
 * everything you have not rated yet.
 */
export function sortSources(rows: SourceScore[], by: 'score' | 'expected', worst = false): SourceScore[] {
  const value = (r: SourceScore) => (by === 'score' ? r.score : r.expected);
  return rows.slice().sort((a, b) => {
    const x = value(a);
    const y = value(b);
    if (x === null && y === null) return b.voices - a.voices;
    if (x === null) return 1;
    if (y === null) return -1;
    return worst ? x - y : y - x;
  });
}
