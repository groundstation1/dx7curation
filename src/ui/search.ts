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
 * unaffected, and a quoted "-thing" is searched for literally.
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
 * A quoted word is never negated - quoting is how you search for a literal
 * leading minus - and a bare "NOT" negates whatever follows it.
 */
function words(text: string): { want: string[]; not: string[] } {
  const want: string[] = [];
  const not: string[] = [];
  const pattern = /"([^"]*)"|(\S+)/g;
  let negateNext = false;
  let m = pattern.exec(text);
  while (m) {
    const quoted = m[1] !== undefined;
    let word = (m[1] ?? m[2] ?? '').trim().toLowerCase();
    if (!quoted && word.toUpperCase() === 'NOT') {
      negateNext = true;
      m = pattern.exec(text);
      continue;
    }
    let negated = negateNext;
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
  if (query.terms.length === 0 && query.exclude.length === 0) return true;
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
