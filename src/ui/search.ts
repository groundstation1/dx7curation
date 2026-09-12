/*
 * Search over the corpus.
 *
 * Deliberately dumb, with exactly three operators:
 *
 *   space  every word must appear somewhere - not necessarily in the same
 *          field, so "FM-1_Bank piano" finds the pianos that came out of that
 *          bank file even though no single field contains both words
 *   OR     alternatives, also written as a comma
 *   -word  and not that, also written as "NOT word"
 *
 * All three matter for this corpus. Patch names in these archives are
 * inconsistent enough that "e-piano OR epiano OR e.piano OR rhodes" is exactly
 * the query you want to write; once you have thirty thousand voices, narrowing
 * by two words at once is the only way to get a list you can look at; and
 * excluding is how you deal with a word that is too popular to search for -
 * "bass -sub", "piano -e.piano", or the ever-present "-init".
 *
 * A minus only counts at the start of a word, so "e-piano" and "FM-1_Bank" are
 * unaffected. Outside a quote it negates - including in front of one, so
 * -"e.piano 1" drops that phrase - and inside a quote it is just a character,
 * which is how you search for a literal leading minus.
 *
 * Exclusion binds to the whole query rather than to one alternative: it reads
 * as "any of these, but never that", which is what anyone typing it means.
 *
 * Double quotes make a phrase, for the rare case where the space is part of
 * what you are looking for.
 */
import type { LoadedVoice } from './state.ts';

export interface SearchQuery {
  /**
   * Alternatives, each a list of words that must all match. A voice matches if
   * any one alternative does.
   */
  terms: string[][];
  /** Words that must not appear. Any one of them rules a voice out. */
  exclude: string[];
  raw: string;
}

/**
 * Split a single alternative into words, keeping "quoted phrases" whole, and
 * separating out the ones that were negated.
 *
 * The negation marker is read before the quote rather than inside it, because
 * a phrase is exactly the thing you most want to exclude - a file path, a bank
 * name - and -"DX7_AllTheWeb" has to mean what it looks like. Inside the quote
 * a minus is only a character, which is how you search for one.
 *
 * A bare "NOT" negates whatever follows it, quoted or not.
 */
function words(text: string): { want: string[]; not: string[] } {
  const want: string[] = [];
  const not: string[] = [];
  // Either an optionally negated "phrase", or a run of non-space.
  const pattern = /([-!]?)"([^"]*)"|(\S+)/g;
  let negateNext = false;
  let m = pattern.exec(text);
  while (m) {
    const quoted = m[2] !== undefined;
    let word = (m[2] ?? m[3] ?? '').trim().toLowerCase();
    if (!quoted && word.toUpperCase() === 'NOT') {
      negateNext = true;
      m = pattern.exec(text);
      continue;
    }
    let negated = negateNext || (quoted && m[1] !== '');
    negateNext = false;
    if (!quoted && word.length > 1 && (word.startsWith('-') || word.startsWith('!'))) {
      negated = true;
      word = word.slice(1);
    }
    if (word) (negated ? not : want).push(word);
    m = pattern.exec(text);
  }
  return { want, not };
}

/** Split on OR (any case) and commas; blank alternatives are dropped. */
export function parseQuery(raw: string): SearchQuery {
  const parts = raw.split(/\s+OR\s+|,/i).map((part) => words(part));
  const terms = parts.map((p) => p.want).filter((list) => list.length > 0);
  const exclude = parts.flatMap((p) => p.not);
  return { terms, exclude, raw };
}

/**
 * Whether a query asks for anything at all.
 *
 * Worth a function because the answer is not "did they type something": an
 * exclusion on its own is a real query, and a caller that decides whether to
 * filter by counting the wanted words will quietly ignore one.
 */
export function isActiveQuery(query: SearchQuery): boolean {
  return query.terms.length > 0 || query.exclude.length > 0;
}

export type SearchScope = 'name' | 'all';

/**
 * `name` matches the surviving voice name plus every alias it was imported
 * under, since the same patch often arrives with a better name in one archive
 * than another. `all` adds the file paths, which is how you find "everything
 * that came out of the Bobby Blues zip".
 */
export function searchableText(voice: LoadedVoice, scope: SearchScope, extra = ''): string {
  let text = voice.name.toLowerCase();
  if (extra) text += ' ' + extra.toLowerCase();
  for (const s of voice.sources) {
    text += ' ' + s.name.toLowerCase();
    if (scope === 'all') text += ' ' + s.file.toLowerCase() + ' ' + s.bank.toLowerCase();
  }
  return text;
}

export function matchesQuery(voice: LoadedVoice, query: SearchQuery, scope: SearchScope, extra = ''): boolean {
  if (!isActiveQuery(query)) return true;
  const text = searchableText(voice, scope, extra);
  // An excluded word rules a voice out whatever else matched.
  for (const word of query.exclude) {
    if (text.includes(word)) return false;
  }
  // "-init" on its own is a real query: everything except that.
  if (query.terms.length === 0) return true;
  for (const alternative of query.terms) {
    if (alternative.every((word) => text.includes(word))) return true;
  }
  return false;
}
