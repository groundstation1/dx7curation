/*
 * What the patch name says.
 *
 * Until now a name reached exactly one place: a keyword nudged the category
 * score and that was the end of it. Everything else - the map, the
 * neighbourhoods, the model that learns what you like - ran on audio alone.
 * That throws away most of what a name is worth. "LEAD" is a statement of
 * intent that no amount of spectral analysis recovers, "ORGAN" separates two
 * things the features genuinely confuse, and the words that carry the most
 * taste in these archives are the ones with no acoustic definition at all:
 * warm, fat, soft, dark, phat, killer. Somebody chose them, about this patch.
 *
 * The obstacle is that a DX7 name is ten characters, so the vocabulary is
 * mangled in two ways at once:
 *
 *   truncated   HARPSICH, STRG ENS, REFS WHISL, CALIOPE
 *   glued       SPANISHGTR, HEAVYMETAL, LASERSWEEP, ORCH-CHIME
 *
 * Splitting on spaces alone gets "harpsich" and "harpsi" and "hpschd" as three
 * unrelated words, and never sees the "gtr" in "spanishgtr" at all. So names
 * are read twice, and the two readings answer different questions:
 *
 *   concepts   curated synonym sets - the category and subcategory keyword
 *              lists that already exist - matched as substrings anywhere in
 *              the name. Substrings are what survive truncation and glue, and
 *              the lists already know that hpschd is a harpsichord. This is
 *              the instrument-identity half, and it is deliberately small.
 *
 *   tokens     whatever is left, split into words, kept if enough patches use
 *              it. Nobody can write this list in advance: it is where the
 *              adjectives live, and which adjectives an archive favours is a
 *              property of that archive. This is the half that learns.
 *
 * Both halves come out as presence flags. What is done with them is in
 * cluster/nameSpace.ts.
 */
import { CATEGORIES, CATEGORY_KEYWORDS, SUBCATEGORIES, type Category } from '../cluster/category.ts';

/**
 * Words that appear on patches of every kind and so separate nothing.
 *
 * Short, and it stays short: a word that is uninformative because it is
 * everywhere is already dropped by the frequency ceiling, and one that is
 * uninformative because it is rare is dropped by the floor. This list is only
 * for words that would pass both and still mean nothing - the bookkeeping
 * somebody left in the name.
 *
 * "voice" is deliberately absent. INIT VOICE is junk, but ROM1A's VOICE 1 is a
 * choir, and the choirs outnumber the inits in most collections.
 */
export const NAME_STOP_WORDS = new Set([
  'init', 'initial', 'default', 'blank', 'empty', 'unused', 'untitled', 'noname',
  'patch', 'preset', 'prog', 'program', 'sound', 'synth', 'sy', 'syn',
  'dx', 'dx7', 'dx21', 'dx27', 'dx100', 'tx', 'tx7', 'tx81z', 'tx802', 'yamaha',
  'syx', 'sysex', 'bank', 'cart', 'cartridge', 'vol', 'volume', 'set', 'lib',
  'new', 'old', 'copy', 'dup', 'test', 'temp', 'tmp', 'edit', 'ver', 'version',
  'the', 'and', 'for', 'with', 'from', 'not', 'via',
]);

/** A curated synonym set: everything in `keywords` means `id`. */
export interface NameConcept {
  id: string;
  label: string;
  keywords: readonly string[];
}

/**
 * The concept list, built from the tables the categoriser already uses.
 *
 * Reusing them is the point. They are the one place in this codebase where the
 * abbreviations of a 10-character format are written down, they were tuned
 * against real archives, and keeping a second copy in sync with them by hand
 * is a promise nobody keeps.
 */
export const NAME_CONCEPTS: readonly NameConcept[] = (() => {
  const out: NameConcept[] = [];
  for (const c of CATEGORIES) {
    out.push({ id: `c:${c}`, label: c, keywords: CATEGORY_KEYWORDS[c] });
    for (const sub of SUBCATEGORIES[c as Category]) {
      if (sub.keywords.length > 0) out.push({ id: `s:${c}/${sub.id}`, label: sub.label, keywords: sub.keywords });
    }
  }
  return out;
})();

/**
 * Names that mean "nobody named this".
 *
 * INIT VOICE is the factory's empty slot and there are thousands of them in a
 * corpus this size. Left alone it is worse than useless: "voice" is a choir
 * keyword, so every untouched slot in every archive would file itself next to
 * the choirs and drag a concept that should mean something into meaning
 * nothing. A name with `init` in it is treated as absent entirely.
 */
const JUNK_WORDS = new Set(['init', 'ini', 'initial', 'initialised', 'initialized']);

function isJunkName(normalized: string): boolean {
  if (normalized === '') return true;
  for (const word of normalized.split(' ')) {
    if (JUNK_WORDS.has(word.replace(/\d+$/, ''))) return true;
  }
  return false;
}

/** Lowercased, punctuation flattened, padding gone. */
export function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/*
 * Reading a name is memoised, because names repeat.
 *
 * Matching the concept table means about six hundred substring searches per
 * name, and a corpus of thirty-five thousand voices holds nothing like
 * thirty-five thousand distinct names - every archive has its own PIANO 1.
 * Caching by the normalised string took the whole pass from a second of
 * frozen tab to something not worth slicing.
 */
const wordCache = new Map<string, string[]>();
const conceptCache = new Map<string, string[]>();

/** Bounded, so a pathological corpus cannot turn this into a memory leak. */
const CACHE_LIMIT = 60000;

function cached(cache: Map<string, string[]>, key: string, make: () => string[]): string[] {
  const hit = cache.get(key);
  if (hit) return hit;
  const value = make();
  if (cache.size >= CACHE_LIMIT) cache.clear();
  cache.set(key, value);
  return value;
}

/**
 * The words of a name, as words.
 *
 * Trailing digits go because they are slot numbers: PIANO 1 through PIANO 5
 * are five patches, not five vocabularies. Only from a word with three letters
 * in front of them, though - B3 is a Hammond and TX7 is a machine, and neither
 * is a B or a TX.
 */
export function nameWords(name: string): string[] {
  const normalized = normalizeName(name);
  return cached(wordCache, normalized, () => {
    if (isJunkName(normalized)) return [];
    const out: string[] = [];
    for (const raw of normalized.split(' ')) {
        const word = /^[a-z]{3,}\d+$/.test(raw) ? raw.replace(/\d+$/, '') : raw;
      /*
       * Two-letter words are dropped. On the real corpus they are almost
       * entirely author initials and bookkeeping - bs, st, ac, ms, eg, hm, ob,
       * mm, jl, mf, jh, it - twenty-five of ninety tokens and hardly a
       * description among them. The few real ones (bs for bass, br for brass)
       * are already covered: their fuller spellings are concepts.
       */
      if (word.length < 3) continue;
      // A bare number is a slot, a year or a count, never a description.
      if (!/[a-z]/.test(word)) continue;
      if (NAME_STOP_WORDS.has(word)) continue;
      out.push(word);
    }
    return out;
  });
}

/**
 * The shortest prefix of a keyword that may stand in for it.
 *
 * Four-letter keywords are already about as short as a word can be and still
 * mean one thing, so their prefixes are not accepted; longer ones are cut down
 * to three, which is where PIA, ORG, BAS and STR live.
 */
const MIN_KEYWORD = 5;
const MIN_PREFIX = 3;

/** Which concepts a name mentions, by substring or by truncation. */
export function nameConceptIds(name: string): string[] {
  const normalized = normalizeName(name);
  return cached(conceptCache, normalized, () => {
    if (isJunkName(normalized)) return [];
    const n = ' ' + normalized + ' ';
    const bare = normalized.split(' ').filter((w) => w.length >= MIN_PREFIX);
    const out: string[] = [];
    for (const concept of NAME_CONCEPTS) {
      const hit = concept.keywords.some((k) => {
        // The keyword lists carry their own spacing - 'ep ', 'harp ' - and it
        // matters: 'ep' inside 'deep' is not an electric piano.
        if (n.includes(k)) return true;
        /*
         * A whole word that is the front of a keyword counts as the keyword.
         *
         * Ten characters is not enough for "BRIGHT PIANO", so archives write
         * BRITE PIAN and WARM PIA, and a table that only knows the word in
         * full sees three unrelated patches. The cut always comes off the end,
         * so a prefix is what is left of the word that was there.
         */
        return k.length >= MIN_KEYWORD && bare.some((w) => w.length < k.length && k.startsWith(w));
      });
      if (hit) out.push(concept.id);
    }
    return out;
  });
}

export interface NameVocabulary {
  /** Concept ids, in the order of their columns. */
  concepts: string[];
  /** Data-driven words, in the order of their columns after the concepts. */
  tokens: string[];
  /** Truncations and extensions, each pointing at the token it counts as. */
  merged: Map<string, string>;
  /** How many voices each column appeared on. */
  documentFrequency: number[];
  /** Human-readable column names, concepts then tokens. */
  labels: string[];
}

export interface VocabularyOptions {
  /** A word has to appear on at least this fraction of voices. */
  minFraction?: number;
  /** And at most this fraction: a word on half the corpus separates nothing. */
  maxFraction?: number;
  /** Never fewer voices than this, however large the corpus. */
  minVoices?: number;
  /** Upper bound on the data-driven half. */
  maxTokens?: number;
}

const DEFAULTS: Required<VocabularyOptions> = {
  // A tenth of a percent: 35 voices in a corpus of 35,000, which is enough for
  // a coefficient to mean something, and 3 in a corpus of 128, which is the
  // least that could.
  minFraction: 0.001,
  maxFraction: 0.4,
  minVoices: 3,
  maxTokens: 160,
};

/**
 * Decide which words are worth a column.
 *
 * `docs` is one entry per voice: every name that voice arrived under, since
 * the same patch is named differently in different archives and the union is
 * more informative than any one of them.
 */
export function buildNameVocabulary(docs: readonly (readonly string[])[], opts: VocabularyOptions = {}): NameVocabulary {
  const o = { ...DEFAULTS, ...opts };
  const n = docs.length;
  const conceptDf = new Map<string, number>();
  const tokenDf = new Map<string, number>();

  for (const names of docs) {
    const concepts = new Set<string>();
    const words = new Set<string>();
    for (const name of names) {
      for (const id of nameConceptIds(name)) concepts.add(id);
      for (const w of nameWords(name)) words.add(w);
    }
    for (const id of concepts) conceptDf.set(id, (conceptDf.get(id) ?? 0) + 1);
    for (const w of words) {
      // A word that already fires a concept does not get a second column of
      // its own: the concept says the same thing across more spellings, and
      // this test catches the plurals and truncations that an equality test
      // against the keyword lists would miss.
      if (nameConceptIds(w).length > 0) continue;
      tokenDf.set(w, (tokenDf.get(w) ?? 0) + 1);
    }
  }

  const floor = Math.max(o.minVoices, Math.round(o.minFraction * n));
  const ceiling = Math.max(floor + 1, Math.floor(o.maxFraction * n));

  const concepts = NAME_CONCEPTS
    .filter((c) => (conceptDf.get(c.id) ?? 0) >= floor)
    .map((c) => c.id);
  /*
   * Fold truncations into the word they are a truncation of.
   *
   * Ten characters, shared between an instrument, an adjective and a number,
   * means the instrument is what gets cut: one archive writes PIANO, the next
   * BRITE PIAN, the next SOFT PIA. Left alone those are three unrelated words
   * with a third of the evidence each, and two of them fall under the
   * frequency floor and vanish.
   *
   * So a word that is a prefix of a more common word counts as that word.
   * Commonest first, and only from three characters up: 'bas' is a bass and
   * 'org' is an organ, but 'ba' is anybody's guess. It catches extensions too
   * - bassline into bass - which is the same phenomenon from the other end.
   */
  const surviving = [...tokenDf.entries()]
    .filter(([, df]) => df >= Math.min(floor, o.minVoices) && df <= ceiling)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

  const merged = new Map<string, string>();
  const canonical: Array<[string, number]> = [];
  for (const [word, df] of surviving) {
    const into = canonical.find(([c]) => (word.length >= 3 && c.startsWith(word)) || (c.length >= 3 && word.startsWith(c)));
    if (into) {
      merged.set(word, into[0]);
      into[1] += df;
    } else {
      canonical.push([word, df]);
    }
  }

  const tokens = canonical
    .filter(([, df]) => df >= floor)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, o.maxTokens)
    .map(([w]) => w);
  const kept = new Set(tokens);
  for (const [from, into] of [...merged]) {
    if (!kept.has(into)) merged.delete(from);
  }

  /*
   * A merged group is labelled with the spelling most archives actually used.
   *
   * The longest one is tempting - "piano" reads better than "pia" - but on the
   * real corpus it picks up compounds: the group around `analog` would be
   * called `analogbs`, and the one around `strng` would be `anlgstrng`. What
   * people wrote most is both the honest label and usually the readable one.
   */
  const display = new Map(tokens.map((t) => [t, t]));

  const labelOf = new Map(NAME_CONCEPTS.map((c) => [c.id, c.label]));
  const mergedDf = new Map(canonical);
  return {
    concepts,
    tokens,
    merged,
    documentFrequency: [
      ...concepts.map((id) => conceptDf.get(id) ?? 0),
      ...tokens.map((w) => mergedDf.get(w) ?? tokenDf.get(w) ?? 0),
    ],
    labels: [
      ...concepts.map((id) => labelOf.get(id) ?? id),
      ...tokens.map((t) => display.get(t) ?? t),
    ],
  };
}

/** The column indices one voice's names light up. */
export function nameColumns(names: readonly string[], vocab: NameVocabulary): number[] {
  const concepts = new Set<string>();
  const words = new Set<string>();
  for (const name of names) {
    for (const id of nameConceptIds(name)) concepts.add(id);
    for (const w of nameWords(name)) words.add(w);
  }
  // A truncation counts as the word it was cut from.
  for (const w of [...words]) {
    const into = vocab.merged.get(w);
    if (into) words.add(into);
  }
  const out: number[] = [];
  for (let i = 0; i < vocab.concepts.length; i++) {
    if (concepts.has(vocab.concepts[i])) out.push(i);
  }
  for (let i = 0; i < vocab.tokens.length; i++) {
    if (words.has(vocab.tokens[i])) out.push(vocab.concepts.length + i);
  }
  return out;
}

export const nameDimensions = (vocab: NameVocabulary): number => vocab.concepts.length + vocab.tokens.length;
