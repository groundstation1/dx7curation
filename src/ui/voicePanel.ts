/*
 * Everything worth knowing about one voice, as a panel.
 *
 * This started life inside the map's sidebar, which is where it is most obvious
 * why it exists: the point of the map is to decide whether a patch is worth
 * keeping, and that decision wants the algorithm, the measured character, the
 * category the classifier chose and how many near-copies of it are in the
 * corpus, all in one place.
 *
 * Rating and the face-off want exactly the same thing - they are the same
 * decision, taken with fewer patches in front of you - so it lives here and all
 * three views share it. What differs between them is only which sections make
 * sense: the face-off is already a family comparison, so repeating the family
 * lists inside each side would say nothing.
 */
import { el } from './dom.ts';
import { algorithmPanel } from './algorithmDiagram.ts';
import { CATEGORIES, CATEGORY_LABELS, subcategoryLabel, type Category } from '../cluster/category.ts';
import { P } from '../sysex/voice.ts';
import type { Store } from './state.ts';

export interface VoicePanelOptions {
  /** Replay this voice. Omitted, the Play button is left out. */
  onPlay?: (index: number) => void;
  /** Rate the voice. Omitted, the rating row is left out. */
  onRate?: (value: number) => void;
  /** Jump to a related voice. Omitted, the lists are shown but not clickable. */
  onOpen?: (index: number) => void;
  /** Something was changed through the panel and the caller should redraw. */
  onChange?: () => void;
  /** The name and algorithm line. On by default. */
  heading?: boolean;
  /** The three tiers of duplicate. On by default. */
  duplicates?: boolean;
  /** The merged and family voice lists. On by default. */
  related?: boolean;
  /** Which files this voice arrived in. On by default. */
  sources?: boolean;
}

export function voiceDetails(store: Store, i: number, opts: VoicePanelOptions = {}): HTMLElement {
  const v = store.voices[i];
  const panel = el('div', { class: 'voice-panel' });
  if (!v) return panel;

  const a = store.analysis[i];
  const cat = store.categoryOf(i);
  const rating = store.ratingOf(i);
  const merged = store.mergedMembers(i);
  const changed = () => opts.onChange?.();

  if (opts.heading !== false) {
    panel.appendChild(el('div', { class: 'mono', style: { fontSize: '17px' } }, v.name || '(unnamed)'));
    panel.appendChild(el('div', { class: 'muted', style: { marginTop: '2px' } },
      `algorithm ${(v.unpacked[P.algorithm] & 31) + 1}`,
      `  ·  feedback ${v.unpacked[P.feedback] & 7}`,
      v.pinned ? '  ·  pinned' : ''));
  }

  // The algorithm, drawn. Two patches on the same algorithm are the same
  // instrument wired differently, and that is much faster to take in as a
  // picture than as a number between 1 and 32.
  panel.appendChild(algorithmPanel(v.unpacked[P.algorithm] & 31, v.unpacked));

  if (opts.onRate) {
    const keys = el('div', { class: 'rate-keys map-rate' });
    for (let r = 1; r <= 5; r++) {
      keys.appendChild(el('button', {
        class: rating === r ? 'on' : '',
        title: `Rate ${r}`,
        onclick: () => opts.onRate?.(r),
      }, String(r)));
    }
    panel.appendChild(keys);
    panel.appendChild(el('div', { class: 'muted', style: { textAlign: 'center', fontSize: '11px', marginTop: '4px' } },
      rating ? el('span', {}, 'rated ', el('b', {}, String(rating)), ' — press the same number again to clear')
        : el('span', {}, 'press ', el('kbd', {}, '1'), '–', el('kbd', {}, '5'), ' to rate, ', el('kbd', {}, 'p'), ' to pin')));
  }

  const buttons = el('div', { class: 'row', style: { marginTop: '12px' } });
  if (opts.onPlay) buttons.appendChild(el('button', { class: 'btn', onclick: () => opts.onPlay?.(i) }, 'Play'));
  buttons.appendChild(el('button', {
    class: 'btn',
    onclick: () => {
      void store.togglePin(i).then(changed);
    },
  }, v.pinned ? 'Unpin' : 'Pin'));
  panel.appendChild(buttons);

  const dl = el('dl', { class: 'detail' });
  const add = (k: string, value: string) => {
    dl.appendChild(el('dt', {}, k));
    dl.appendChild(el('dd', {}, value));
  };

  dl.appendChild(el('dt', {}, 'category'));
  dl.appendChild(el('dd', {}, el('select', {
    onchange: (e: Event) => {
      const value = (e.target as HTMLSelectElement).value;
      void store.setCategoryOverride(i, value === 'auto' ? null : (value as Category)).then(changed);
    },
  },
    el('option', { value: 'auto', selected: !store.categoryOverrides.has(v.id) }, `auto: ${cat ?? '-'}`),
    ...CATEGORIES.map((c) => el('option', {
      value: c,
      selected: store.categoryOverrides.get(v.id) === c,
    }, CATEGORY_LABELS[c])),
  )));

  const sub = store.subcategoryOf(i);
  if (cat && sub) add('subcategory', subcategoryLabel(cat, sub));
  add('rating', rating ? '★'.repeat(rating) : 'not rated');
  const predicted = store.predictedRating(i);
  if (predicted !== null) add('predicted rating', predicted.toFixed(2));
  if (a) {
    add('attack', `${(Math.pow(10, a.acoustic.logAttackTime) * 1000).toFixed(0)} ms`);
    add('release', `${Math.pow(10, a.acoustic.logReleaseTime).toFixed(2)} s${a.acoustic.releaseCensored ? ' (still ringing)' : ''}`);
    add('sustain', a.acoustic.sustainRatio.toFixed(2));
    add('brightness', `${a.acoustic.centroidOct.toFixed(2)} octaves above f0`);
    add('register', `${a.acoustic.registerOct >= 0 ? '+' : ''}${a.acoustic.registerOct.toFixed(2)} octaves vs the note played`);
    add('inharmonicity', a.acoustic.inharmonicity.toFixed(3));
    add('velocity range', `${a.acoustic.velLevelDb.toFixed(1)} dB, ${a.acoustic.velBrightnessOct.toFixed(2)} oct brighter`);
  }
  panel.appendChild(dl);

  // ---- duplicates, in three distinct tiers ----
  //
  // These are genuinely different things and conflating them was confusing:
  //   exact   byte-identical apart from the name; collapsed on import, so this
  //           voice IS all of them and there is nothing to compare
  //   merged  different bytes, below the merge threshold; a separate row in the
  //           table, but treated as the same sound and hidden behind this one
  //   family  below the looser threshold; similar but audibly different, and
  //           what the face-off actually compares
  const mergedOthers = merged.filter((m) => m !== i);
  const contenders = store.familyContenders(i).filter((m) => m !== i);

  if (opts.duplicates !== false) {
    let copiesAcrossMerged = 0;
    for (const m of merged) copiesAcrossMerged += store.voices[m]?.sources.length ?? 0;

    panel.appendChild(el('h3', {}, 'Duplicates'));
    const dupes = el('dl', { class: 'detail' });
    const addDupe = (k: string, value: string, note: string) => {
      dupes.appendChild(el('dt', {}, k));
      dupes.appendChild(el('dd', {}, value, el('div', { class: 'muted', style: { fontSize: '11px' } }, note)));
    };
    addDupe('exact copies',
      v.sources.length === 1 ? 'just this one' : `${v.sources.length} files`,
      'byte-identical once the name is ignored, collapsed on import');
    addDupe('merged',
      mergedOthers.length === 0 ? 'none' : `${mergedOthers.length} other voice${mergedOthers.length === 1 ? '' : 's'}`,
      `below the merge threshold of ${store.mergeThreshold.toFixed(2)}; treated as the same sound`);
    addDupe('family',
      contenders.length === 0 ? 'unique' : `${contenders.length} distinct sound${contenders.length === 1 ? '' : 's'}`,
      `below ${store.threshold.toFixed(2)}; similar but audibly different, so these go to the face-off`);
    if (mergedOthers.length || v.sources.length > 1) {
      addDupe('copies in the corpus', String(copiesAcrossMerged),
        'total source files this sound arrived in, across every merged voice');
    }
    panel.appendChild(dupes);
  }

  if (opts.related !== false) {
    const voiceList = (title: string, indices: number[], note: string) => {
      if (indices.length === 0) return;
      panel.appendChild(el('h3', {}, title));
      panel.appendChild(el('div', { class: 'muted', style: { fontSize: '11px', marginBottom: '5px' } }, note));
      const list = el('div', { class: 'stack', style: { gap: '3px' } });
      for (const m of indices.slice(0, 14)) {
        const name = store.voices[m].name || '(unnamed)';
        list.appendChild(opts.onOpen
          ? el('button', {
            class: 'btn',
            style: { textAlign: 'left', padding: '4px 8px' },
            onclick: () => opts.onOpen?.(m),
          }, name)
          : el('div', { class: 'muted mono', style: { fontSize: '11px' } }, name));
      }
      if (indices.length > 14) {
        list.appendChild(el('div', { class: 'muted' }, `and ${indices.length - 14} more`));
      }
      panel.appendChild(list);
    };

    voiceList('Merged into this one', mergedOthers, 'these should be indistinguishable; if one is not, raise the merge threshold');
    voiceList('Others in this family', contenders, 'similar but audibly different');
  }

  if (opts.sources !== false) {
    panel.appendChild(el('h3', {}, `Where this one came from (${v.sources.length})`));
    const ul = el('ul', { class: 'muted mono', style: { margin: 0, paddingLeft: '16px', fontSize: '11px' } });
    for (const s of v.sources.slice(0, 10)) {
      ul.appendChild(el('li', {}, `${s.name.trim() || '(unnamed)'} — ${s.file} slot ${s.slot + 1}`));
    }
    if (v.sources.length > 10) ul.appendChild(el('li', {}, `and ${v.sources.length - 10} more`));
    panel.appendChild(ul);
  }

  return panel;
}
