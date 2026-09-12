/*
 * Search over the corpus.
 *
 * Deliberately dumb, with exactly two operators:
 *
 *   space  every word must appear somewhere - not necessarily in the same
 *          field, so "FM-1_Bank piano" finds the pianos that came out of that
 *          bank file even though no single field contains both words
 *   OR     alternatives, also written as a comma
 *
 * Both matter for this corpus. Patch names in these archives are inconsistent
 * enough that "e-piano OR epiano OR e.piano OR rhodes" is exactly the query you
 * want to write; and once you have thirty thousand voices, narrowing by two
 * words at once is the only way to get a list you can actually look at.
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
  raw: string;
}

/** Split a single alternative into words, keeping "quoted phrases" whole. */
function words(text: string): string[] {
  const out: string[] = [];
  const pattern = /"([^"]*)"|(\S+)/g;
  let m = pattern.exec(text);
  while (m) {
    const word = (m[1] ?? m[2] ?? '').trim().toLowerCase();
    if (word) out.push(word);
    m = pattern.exec(text);
  }
  return out;
}

/** Split on OR (any case) and commas; blank alternatives are dropped. */
export function parseQuery(raw: string): SearchQuery {
  const terms = raw
    .split(/\s+OR\s+|,/i)
    .map((part) => words(part))
    .filter((list) => list.length > 0);
  return { terms, raw };
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
  if (query.terms.length === 0) return true;
  const text = searchableText(voice, scope, extra);
  for (const alternative of query.terms) {
    if (alternative.every((word) => text.includes(word))) return true;
  }
  return false;
}
