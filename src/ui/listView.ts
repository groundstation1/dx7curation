/*
 * The corpus as a table, as an alternative to the scatter.
 *
 * The map is for finding regions - "what lives over here, and does it sound
 * like its neighbours". A list is for the other half of the job: reading what
 * you have decided, sorting by it, and spotting the thing that is obviously out
 * of place. Ratings, predictions, categories and family sizes are all numbers,
 * and numbers want a column.
 *
 * It shares everything with the map that decides *which* voices are in front of
 * you - the search, the category and rating filters, the merge collapsing - and
 * differs only in how they are drawn. Hovering, clicking and rating behave the
 * same, so the sidebar and the MIDI keyboard do not care which one you are in.
 *
 * Rows are virtualised. Thirty thousand table rows is about a gigabyte of DOM
 * and several seconds of layout; a window of the forty or so that fit on screen
 * is instant, and the scrollbar still says how much there is.
 */
import { clear, el, fmtInt } from './dom.ts';
import { CATEGORY_LABELS, type Category } from '../cluster/category.ts';
import { categoryColour } from './colour.ts';
import type { Store } from './state.ts';

/** Fixed, because virtual scrolling needs to know where a row is without asking. */
const ROW_HEIGHT = 26;
/** Rendered beyond the viewport, so a fast scroll does not show empty space. */
const OVERSCAN = 8;
/**
 * A hard ceiling on how many rows are ever built at once.
 *
 * The window is meant to be the forty or so that fit on screen, and it is
 * computed from the scroller's own height - so a layout that lets the scroller
 * grow to its content turns "what fits" into "everything", silently, and the
 * only symptom is that the app stops responding. This makes that mistake a
 * cosmetic one rather than a hang.
 */
const MAX_ROWS = 300;

export type SortKey =
  | 'name' | 'category' | 'rating' | 'predicted' | 'family'
  | 'attack' | 'release' | 'brightness' | 'sources';

export interface ListState {
  sort: SortKey;
  descending: boolean;
}

export interface ListHandlers {
  onHover(index: number): void;
  onOpen(index: number): void;
  onRate(index: number, value: number): void;
  /** The voice the sidebar is showing, so the row can be marked. */
  current(): number;
  /**
   * The voice a click has pinned, which is drawn differently from the one the
   * cursor happens to be over. Without the distinction a click looks exactly
   * like a hover, and there is nothing to tell you it stuck.
   */
  pinned(): number;
  /**
   * The search hits, when the search is highlighting rather than filtering, or
   * null when every row counts. On the map the misses are dimmed rather than
   * removed, so that you can see where the matches sit among everything else;
   * the list does the same, because a search that silently did nothing here
   * would look broken.
   */
  matched(): Set<number> | null;
}

interface Column {
  key: SortKey | null;
  label: string;
  /** CSS grid width. */
  width: string;
  align?: 'right';
  cell: (store: Store, index: number) => Node | string;
}

function ratingCell(store: Store, index: number): Node {
  const rating = store.ratingOf(index);
  return el('span', { class: rating ? 'rating-on' : 'muted' }, rating ? '★'.repeat(rating) : '·');
}

const COLUMNS: Column[] = [
  {
    key: 'name',
    label: 'name',
    width: 'minmax(120px, 2fr)',
    cell: (store, i) => {
      const v = store.voices[i];
      const cat = store.categoryOf(i);
      return el('span', { class: 'list-name' },
        el('i', { style: { background: cat ? categoryColour(cat) : 'var(--raise-2)' } }),
        v.name || '(unnamed)',
        v.pinned ? el('span', { class: 'warn', title: 'pinned' }, ' ●') : null);
    },
  },
  {
    key: 'category',
    label: 'category',
    width: 'minmax(90px, 1fr)',
    cell: (store, i) => {
      const cat = store.categoryOf(i);
      return cat ? CATEGORY_LABELS[cat as Category] ?? cat : '—';
    },
  },
  { key: 'rating', label: 'rating', width: '72px', cell: ratingCell },
  {
    key: 'predicted',
    label: 'guess',
    width: '72px',
    // Stars, like the rating, because a guess at a rating is worth reading in
    // the same currency as the thing it is guessing - a 4.2 next to a column
    // of stars takes a moment to place. Dimmer, because it is a guess.
    cell: (store, i) => {
      const p = store.predictedRating(i);
      if (p === null) return el('span', { class: 'muted' }, '·');
      const stars = Math.max(1, Math.min(5, Math.round(p)));
      return el('span', { class: 'rating-guess', title: `predicted ${p.toFixed(2)}` }, '★'.repeat(stars));
    },
  },
  {
    key: 'family',
    label: 'family',
    width: '54px',
    align: 'right',
    cell: (store, i) => String(store.clusterMembers(i).length),
  },
  {
    key: 'attack',
    label: 'attack',
    width: '62px',
    align: 'right',
    cell: (store, i) => {
      const a = store.analysis[i];
      return a ? `${(Math.pow(10, a.acoustic.logAttackTime) * 1000).toFixed(0)} ms` : '—';
    },
  },
  {
    key: 'release',
    label: 'release',
    width: '62px',
    align: 'right',
    cell: (store, i) => {
      const a = store.analysis[i];
      return a ? `${Math.pow(10, a.acoustic.logReleaseTime).toFixed(1)} s` : '—';
    },
  },
  {
    key: 'brightness',
    label: 'bright',
    width: '58px',
    align: 'right',
    cell: (store, i) => {
      const a = store.analysis[i];
      return a ? a.acoustic.centroidOct.toFixed(1) : '—';
    },
  },
  {
    key: 'sources',
    label: 'from',
    width: 'minmax(90px, 1.4fr)',
    cell: (store, i) => {
      const v = store.voices[i];
      const first = v.sources[0];
      const label = first ? first.file.split('/').pop() ?? first.file : '—';
      return el('span', {
        class: 'list-from',
        title: v.sources.map((s) => s.file).join('\n'),
      }, v.sources.length > 1 ? `${label} +${v.sources.length - 1}` : label);
    },
  },
];

const TEMPLATE = COLUMNS.map((c) => c.width).join(' ');

/** The value a column sorts on, with names lowercased so the order reads right. */
function sortValue(store: Store, index: number, key: SortKey): number | string {
  const a = store.analysis[index];
  switch (key) {
    case 'name': return (store.voices[index].name || '~').toLowerCase();
    case 'category': return store.categoryOf(index) ?? '~';
    case 'rating': return store.ratingOf(index) ?? -1;
    case 'predicted': return store.predictedRating(index) ?? -Infinity;
    case 'family': return store.clusterMembers(index).length;
    case 'attack': return a ? a.acoustic.logAttackTime : Infinity;
    case 'release': return a ? a.acoustic.logReleaseTime : Infinity;
    case 'brightness': return a ? a.acoustic.centroidOct : -Infinity;
    case 'sources': return store.voices[index].sources.length;
  }
}

export function sortIndices(store: Store, indices: number[], state: ListState): number[] {
  const out = indices.slice();
  const sign = state.descending ? -1 : 1;
  out.sort((x, y) => {
    const a = sortValue(store, x, state.sort);
    const b = sortValue(store, y, state.sort);
    if (a === b) return x - y;
    return (typeof a === 'string' ? String(a).localeCompare(String(b)) : (a as number) - (b as number)) * sign;
  });
  return out;
}

export interface ListView {
  /** Re-render with a new set, keeping the scroll position where it makes sense. */
  update(indices: number[]): void;
  /** Repaint the visible rows only - after a rating, say. */
  refresh(): void;
  /**
   * Move the highlight without rebuilding anything.
   *
   * Rebuilding on hover destroys the row under the cursor, and a row that is
   * replaced between pointerdown and pointerup produces no click event at all -
   * so clicking a row did nothing, intermittently and then reliably, depending
   * on whether the mouse twitched. Marking touches two class lists.
   */
  mark(): void;
  /** Put a voice on screen and mark it. */
  reveal(index: number): void;
}

export function createListView(
  host: HTMLElement, store: Store, state: ListState, handlers: ListHandlers,
  onSortChange: () => void,
): ListView {
  let indices: number[] = [];

  // The header is a grid inside a clipped box rather than a grid itself, so
  // that the columns can be wider than the pane without spilling over the
  // sidebar next to it. Its horizontal scroll is driven from the rows below,
  // which is what keeps the two aligned.
  const headGrid = el('div', { class: 'list-head-grid', style: { gridTemplateColumns: TEMPLATE } });
  const header = el('div', { class: 'list-head' }, headGrid);
  const spacer = el('div', { class: 'list-spacer' });
  const rows = el('div', { class: 'list-rows' });
  const scroller = el('div', { class: 'list-scroll' }, spacer, rows);
  const count = el('div', { class: 'list-count muted' });

  clear(host);
  host.appendChild(header);
  host.appendChild(scroller);
  host.appendChild(count);

  const renderHeader = () => {
    clear(headGrid);
    for (const col of COLUMNS) {
      const active = col.key === state.sort;
      headGrid.appendChild(el('button', {
        class: `list-th${active ? ' on' : ''}${col.align === 'right' ? ' num' : ''}`,
        disabled: col.key === null,
        onclick: () => {
          if (!col.key) return;
          if (state.sort === col.key) state.descending = !state.descending;
          else {
            state.sort = col.key;
            // Names read naturally ascending; everything else is more useful
            // with the big numbers at the top.
            state.descending = col.key !== 'name' && col.key !== 'category';
          }
          onSortChange();
        },
      }, col.label, active ? el('span', { class: 'list-arrow' }, state.descending ? ' ▾' : ' ▴') : null));
    }
  };

  const paint = () => {
    const first = Math.max(0, Math.floor(scroller.scrollTop / ROW_HEIGHT) - OVERSCAN);
    const fit = Math.min(MAX_ROWS, Math.ceil(scroller.clientHeight / ROW_HEIGHT) + OVERSCAN * 2);
    const last = Math.min(indices.length, first + fit);
    const current = handlers.current();
    const held = handlers.pinned();
    const hits = handlers.matched();

    clear(rows);
    rows.style.transform = `translateY(${first * ROW_HEIGHT}px)`;
    for (let at = first; at < last; at++) {
      const index = indices[at];
      const row = el('div', {
        class: `list-row${index === current ? ' on' : ''}${index === held ? ' held' : ''}`
          + `${hits && !hits.has(index) ? ' dim' : ''}`,
        style: { gridTemplateColumns: TEMPLATE },
        'data-index': String(index),
        onpointerenter: () => handlers.onHover(index),
        onclick: () => handlers.onOpen(index),
      });
      for (const col of COLUMNS) {
        row.appendChild(el('div', { class: col.align === 'right' ? 'list-cell num' : 'list-cell' },
          col.cell(store, index)));
      }
      rows.appendChild(row);
    }
  };

  scroller.addEventListener('scroll', () => {
    header.scrollLeft = scroller.scrollLeft;
    paint();
  }, { passive: true });
  window.addEventListener('resize', paint);

  renderHeader();

  const mark = () => {
    const current = handlers.current();
    const held = handlers.pinned();
    for (const row of Array.from(rows.children) as HTMLElement[]) {
      const index = Number(row.dataset.index);
      row.classList.toggle('on', index === current);
      row.classList.toggle('held', index === held);
    }
  };

  return {
    mark,
    update(next) {
      indices = next;
      spacer.style.height = `${indices.length * ROW_HEIGHT}px`;
      count.textContent = `${fmtInt(indices.length)} shown`;
      renderHeader();
      paint();
    },
    refresh() {
      renderHeader();
      paint();
    },
    reveal(index) {
      const at = indices.indexOf(index);
      if (at < 0) return;
      const top = at * ROW_HEIGHT;
      const above = top < scroller.scrollTop;
      const below = top + ROW_HEIGHT > scroller.scrollTop + scroller.clientHeight;
      if (!above && !below) {
        // Already on screen. Marking touches two class lists; painting rebuilds
        // every row, which destroys the one under the cursor - and a row
        // replaced between pointerdown and pointerup produces no click at all.
        // This runs on every hover of the plot next door, so it matters.
        mark();
        return;
      }
      scroller.scrollTop = top - scroller.clientHeight / 2;
      paint();
    },
  };
}
