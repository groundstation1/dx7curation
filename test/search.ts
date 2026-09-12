/* Search semantics: space means AND, OR means OR, minus means not. Run: node test/search.ts */
import { parseQuery, matchesQuery } from '../src/ui/search.ts';
import type { LoadedVoice } from '../src/ui/state.ts';

let fail = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (!ok) fail++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? '  ' + detail : ''}`);
};

const voice = (name: string, file: string, alias = name): LoadedVoice => ({
  id: 1,
  name,
  unpacked: new Uint8Array(155),
  packed: new Uint8Array(128),
  sources: [{ file, bank: 'A', slot: 0, name: alias, container: 'bulk', checksumOk: true }],
  pinned: false,
} as unknown as LoadedVoice);

const piano = voice('PIANO   5', 'FM-1_Bank_A.syx');
const brass = voice('BRASS   1', 'FM-1_Bank_A.syx');
const rhodes = voice('E.PIANO 1', 'dx7-collection/keys.syx');

const hits = (raw: string, scope: 'name' | 'all' = 'all') => {
  const q = parseQuery(raw);
  return [piano, brass, rhodes].filter((v) => matchesQuery(v, q, scope)).map((v) => v.name.trim());
};

check('two words match across different fields', String(hits('FM-1_Bank piano')) === 'PIANO   5',
  String(hits('FM-1_Bank piano')));
check('both words are required', hits('FM-1_Bank rhodes').length === 0);
check('OR still works', String(hits('brass OR e.piano')) === 'BRASS   1,E.PIANO 1',
  String(hits('brass OR e.piano')));
check('OR combines with AND per alternative',
  String(hits('FM-1_Bank brass OR e.piano')) === 'BRASS   1,E.PIANO 1');
// "piano" is in E.PIANO 1 as well, which is the substring matching working.
check('a comma is an OR', String(hits('brass, piano')) === 'PIANO   5,BRASS   1,E.PIANO 1',
  String(hits('brass, piano')));
check('quotes keep a phrase together', hits('"piano   5"').length === 1);
check('a phrase that is not there matches nothing', hits('"piano 5"').length === 0);
check('name scope ignores the path', hits('FM-1_Bank piano', 'name').length === 0);
check('an empty query matches everything', hits('').length === 3);
check('case is ignored', hits('PIANO').length === 2, String(hits('PIANO')));

// Exclusion is how you cope with a word that is too popular to search for.
check('a leading minus rules a voice out', String(hits('-piano')) === 'BRASS   1',
  String(hits('-piano')));
check('NOT does the same in words', String(hits('NOT piano')) === 'BRASS   1');
check('an exclamation mark too', String(hits('!piano')) === 'BRASS   1');
check('exclusion narrows a search rather than replacing it',
  String(hits('piano -e.piano')) === 'PIANO   5', String(hits('piano -e.piano')));
check('exclusion binds to the whole query, not one alternative',
  String(hits('brass, piano -e.piano')) === 'PIANO   5,BRASS   1',
  String(hits('brass, piano -e.piano')));
check('a hyphen inside a word is not an exclusion', hits('FM-1_Bank').length === 2);
check('a quoted minus is searched for literally',
  parseQuery('"-piano"').exclude.length === 0 && hits('"-piano"').length === 0);
check('a lone minus is just a word', parseQuery('-').exclude.length === 0);

console.log(fail === 0 ? '\nall search checks passed' : `\n${fail} check(s) failed`);
process.exit(fail === 0 ? 0 : 1);
