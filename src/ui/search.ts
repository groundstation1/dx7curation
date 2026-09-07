/*
 * Search over the corpus.
 *
 * Deliberately dumb: case-insensitive substring matching, with OR between
 * terms. Patch names in these archives are inconsistent enough that "e-piano OR
 * epiano OR e.piano OR rhodes" is exactly the query you want to write, and
 * anything cleverer would just get in the way of that.
 */
import type { LoadedVoice } from './state.ts';

export interface SearchQuery {
  terms: string[];
  raw: string;
}

/** Split on OR (any case) and commas; blank terms are dropped. */
export function parseQuery(raw: string): SearchQuery {
  const terms = raw
    .split(/\s+OR\s+|,/i)
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length > 0);
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
  for (const term of query.terms) {
    if (text.includes(term)) return true;
  }
  return false;
}
