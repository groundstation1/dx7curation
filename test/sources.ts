/*
 * Ranking the files patches came out of. Run: node test/sources.ts
 *
 * The two things that are easy to get wrong here are double counting - one
 * patch that arrived in twenty archives is one opinion - and letting a tiny
 * sample win, which is what a raw mean does and is exactly the failure that
 * makes a table like this worth nothing.
 */
import { rankSources, sortSources, sourceKey, type SourceScore } from '../src/ui/sourceRanking.ts';

let fail = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (!ok) fail++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? '  ' + detail : ''}`);
};

console.log('source ranking:');

check('archive is the first segment', sourceKey('a.zip/inner/bank.syx', 'archive') === 'a.zip');
check('folder is everything but the file', sourceKey('a.zip/inner/bank.syx', 'folder') === 'a.zip/inner');
check('file is the whole path', sourceKey('a.zip/inner/bank.syx', 'file') === 'a.zip/inner/bank.syx');
check('a bare file is its own archive', sourceKey('rom1a.syx', 'archive') === 'rom1a.syx');
check('and its own folder', sourceKey('rom1a.syx', 'folder') === 'rom1a.syx');

/** A corpus as a list of [files, rating, predicted]. */
const corpus = (rows: Array<[string[], number | null, number?]>) => ({
  count: rows.length,
  filesOf: (i: number) => rows[i][0],
  ratingOf: (i: number) => rows[i][1],
  predictedOf: (i: number) => rows[i][2] ?? null,
});
const by = (rows: SourceScore[], key: string) => rows.find((r) => r.key === key)!;

// One lucky five against twenty solid fours, with the corpus sitting at three.
const shrink = rankSources({
  ...corpus([
    [['lucky.syx'], 5],
    ...Array.from({ length: 20 }, () => [['solid.syx'], 4] as [string[], number]),
    ...Array.from({ length: 30 }, () => [['bulk.syx'], 2] as [string[], number]),
  ]),
  level: 'file',
});
check('a raw mean would put the single five on top', by(shrink, 'lucky.syx').average === 5);
check('but the order does not', shrink[0].key === 'solid.syx', shrink.map((r) => r.key).join(' > '));
check('the displayed average stays raw', by(shrink, 'solid.syx').average === 4);
check('and the score is pulled toward the corpus mean',
  by(shrink, 'lucky.syx').score! < 3.6 && by(shrink, 'lucky.syx').score! > 3,
  String(by(shrink, 'lucky.syx').score));

// The same patch in three archives is one rating, three times over - and the
// corpus mean must not count it three times either.
const shared = rankSources({
  ...corpus([
    [['a.zip/x.syx', 'b.zip/x.syx', 'c.zip/x.syx'], 5],
    [['a.zip/y.syx'], 1],
  ]),
  level: 'archive',
  prior: 0,
});
check('a shared patch counts once in every archive it is in',
  by(shared, 'b.zip').rated === 1 && by(shared, 'c.zip').rated === 1);
check('and does not inflate the archive it shares with others',
  by(shared, 'a.zip').voices === 2 && by(shared, 'a.zip').average === 3);

// Twice in the same bank is one voice, not two.
const twice = rankSources({
  ...corpus([[['bank.syx', 'bank.syx'], 4]]),
  level: 'file',
  prior: 0,
});
check('the same source listed twice counts once',
  by(twice, 'bank.syx').voices === 1 && by(twice, 'bank.syx').rated === 1);

// The expected column has to cover what you have not rated, or it says nothing
// about the archives worth opening next.
const expect = rankSources({
  ...corpus([
    [['known.syx'], 5, 1],
    [['guessed.syx'], null, 4],
    [['guessed.syx'], null, 2],
  ]),
  level: 'file',
});
check('your rating wins over the guess where you have one',
  by(expect, 'known.syx').expected === 5);
check('and the guess fills in where you have none',
  by(expect, 'guessed.syx').expected === 3 && by(expect, 'guessed.syx').rated === 0);
check('an unrated source has no average at all',
  by(expect, 'guessed.syx').average === null && by(expect, 'guessed.syx').score === null);

// Worst-first is about the sources you know something about.
const worst = sortSources(rankSources({
  ...corpus([[['good.syx'], 5], [['bad.syx'], 1], [['unknown.syx'], null]]),
  level: 'file',
}), 'score', true);
check('worst first starts at the worst you have rated', worst[0].key === 'bad.syx');
check('and still leaves the unrated ones at the end', worst[worst.length - 1].key === 'unknown.syx',
  worst.map((r) => r.key).join(' > '));

console.log(fail === 0 ? '\nall source ranking checks passed' : `\n${fail} check(s) failed`);
process.exit(fail === 0 ? 0 : 1);
