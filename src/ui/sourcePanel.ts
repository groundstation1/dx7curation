/*
 * Which of your files the good patches actually came from.
 *
 * This lived on Sources, next to the buttons that bring files in - which is
 * where you would look for a fact about files, and is the one screen where
 * this fact is useless. It is a report on your ratings: it says nothing until
 * you have given a few hundred, it changes every time you give more, and the
 * moment you want it is the moment you have just finished a stretch of rating
 * and are wondering where to point the next one. So it sits under the other
 * report on your ratings, on the screen where they are made.
 *
 * Clicking a row opens Browse with everything from that source, which is the
 * only useful thing to do with the answer.
 */
import { clear, el, fmtInt } from './dom.ts';
import type { ViewContext } from './app.ts';
import { getSetting, setSetting } from './settings.ts';
import { runTask } from './task.ts';
import { ratingColour } from './colour.ts';
import { rankSources, sortSources, SOURCE_LEVELS, type SourceLevel, type SourceScore } from './sourceRanking.ts';

/** How many sources the table shows before it stops. */
const SOURCE_ROWS = 24;

let ctx: ViewContext | null = null;

/** Whichever screen is showing the panel, so a row click can navigate. */
export function useSourceContext(c: ViewContext): void {
  ctx = c;
}

let sourceLevel: SourceLevel = getSetting<SourceLevel>('sources.level', 'archive');
let sourceBy: 'score' | 'expected' = getSetting<'score' | 'expected'>('sources.by', 'score');
let sourceWorst = false;
let sourceRows: SourceScore[] | null = null;

/**
 * Which of the files you dropped in were worth it.
 *
 * Ranking is in sourceRanking.ts, including why the order is not by the
 * average you can see. This is the table and the three controls.
 */
export function sourcePanel(): HTMLElement {
  const wrap = el('div', {});
  const body = el('div', {});

  const compute = async () => {
    const store = ctx!.store;
    const wantPredictions = sourceBy === 'expected' && store.tasteModel !== null;
    if (wantPredictions) {
      const all = store.voices.map((_, i) => i);
      await runTask('guessing what is in each file', async (task) => {
        await store.fillPredictions(all, async (done, total) => {
          task.set(total ? done / total : null, `${fmtInt(done)} of ${fmtInt(total)}`);
          await new Promise((r) => setTimeout(r, 0));
        });
      });
    }
    sourceRows = rankSources({
      count: store.voices.length,
      filesOf: (i) => store.voices[i].sources.map((src) => src.file),
      ratingOf: (i) => store.effectiveRating(i),
      predictedOf: wantPredictions ? (i) => store.predictedRating(i) : undefined,
      level: sourceLevel,
    });
  };

  const fill = () => {
    clear(body);
    const rows = sortSources(sourceRows ?? [], sourceBy, sourceWorst)
      .filter((r) => (sourceBy === 'score' ? r.score !== null : r.expected !== null));
    if (rows.length === 0) {
      body.appendChild(el('p', { class: 'muted' }, sourceBy === 'score'
        ? 'Rate a few patches and this fills in.'
        : 'The model needs a few more ratings before it can guess.'));
      return;
    }

    const table = el('table', { class: 'data fixed' });
    table.appendChild(el('thead', {}, el('tr', {},
      el('th', {}, sourceLevel),
      el('th', { class: 'num src-num' }, 'voices'),
      el('th', { class: 'num src-num' }, 'rated'),
      el('th', { class: 'num src-num' }, 'average'),
      el('th', { class: 'num src-num' }, 'expected'),
      el('th', { class: 'src-bar' }, ''),
    )));
    const tbody = el('tbody');
    for (const row of rows.slice(0, SOURCE_ROWS)) {
      const shown = sourceBy === 'score' ? row.average : row.expected;
      const cut = row.key.lastIndexOf('/');
      tbody.appendChild(el('tr', {
        class: 'clickable',
        title: `${row.key}\nClick to browse everything that came from here`,
        onclick: () => void browseSource(row.key),
      },
        el('td', { class: 'src-name' },
          cut >= 0 ? el('span', { class: 'muted' }, row.key.slice(0, cut + 1)) : null,
          el('span', {}, cut >= 0 ? row.key.slice(cut + 1) : row.key)),
        el('td', { class: 'num src-num' }, fmtInt(row.voices)),
        el('td', { class: 'num muted src-num' }, row.rated > 0 ? fmtInt(row.rated) : '-'),
        el('td', { class: 'num src-num' }, row.average === null ? '-' : row.average.toFixed(2)),
        el('td', { class: 'num muted src-num' }, row.expected === null ? '-' : row.expected.toFixed(2)),
        el('td', { class: 'src-bar' }, el('div', { class: 'stat-bar' }, el('i', {
          style: {
            left: '0',
            width: `${Math.max(2, Math.min(1, (shown ?? 0) / 5) * 100)}%`,
            background: ratingColour(Math.round(shown ?? 0)),
          },
        }))),
      ));
    }
    table.appendChild(tbody);
    body.appendChild(table);

    if (rows.length > SOURCE_ROWS) {
      body.appendChild(el('p', { class: 'muted', style: { marginTop: '8px' } },
        `${fmtInt(rows.length - SOURCE_ROWS)} more not shown.`));
    }
  };

  const redraw = async (recompute: boolean) => {
    if (recompute) await compute();
    fill();
  };

  // The direction is a property of the same table, so it updates in place
  // rather than through a rebuild of the screen around it.
  const flip = el('button', {
    class: sourceWorst ? 'btn on' : 'btn',
    title: 'The other end of the list - the folders worth deleting',
    onclick: () => {
      sourceWorst = !sourceWorst;
      flip.className = sourceWorst ? 'btn on' : 'btn';
      flip.textContent = sourceWorst ? 'worst first' : 'best first';
      fill();
    },
  }, sourceWorst ? 'worst first' : 'best first');

  wrap.appendChild(el('div', { class: 'row' },
    el('select', {
      title: 'How much of the path to group by',
      onchange: (e: Event) => {
        sourceLevel = (e.target as HTMLSelectElement).value as SourceLevel;
        setSetting('sources.level', sourceLevel);
        void redraw(true);
      },
    }, ...SOURCE_LEVELS.map((l) => el('option', { value: l.id, selected: l.id === sourceLevel }, `by ${l.label}`))),
    el('select', {
      title: 'Rank by the ratings you gave, or by the model filling in the rest',
      onchange: (e: Event) => {
        sourceBy = (e.target as HTMLSelectElement).value as 'score' | 'expected';
        setSetting('sources.by', sourceBy);
        void redraw(true);
      },
    },
      el('option', { value: 'score', selected: sourceBy === 'score' }, 'by your ratings'),
      el('option', { value: 'expected', selected: sourceBy === 'expected' }, 'by expected'),
    ),
    flip,
  ));
  wrap.appendChild(body);
  wrap.appendChild(el('p', { class: 'note' },
    'Ordered by an average pulled toward the corpus mean, so one lucky five-star patch in a file of three does not beat a folder of sixty good ones.'));

  void redraw(true);
  return wrap;
}

/** Open Browse with everything from one source, using the search's own syntax. */
async function browseSource(key: string): Promise<void> {
  const map = await import('./views/map.ts');
  map.presetSearch(`"${key}"`);
  ctx!.go('map');
}
