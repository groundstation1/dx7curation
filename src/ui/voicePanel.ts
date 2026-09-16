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
import { downloadBytes, el, patchFile } from './dom.ts';
import { algorithmPanel } from './algorithmDiagram.ts';
import { CATEGORIES, CATEGORY_LABELS, subcategoryLabel, type Category } from '../cluster/category.ts';
import { categoryColour } from './colour.ts';
import { patchLinkFor } from './patchLink.ts';
import { sendToDeviceButton } from './midiOut.ts';
import { P } from '../sysex/voice.ts';
import { buildSingleVoice } from '../sysex/write.ts';
import type { Store } from './state.ts';

export interface VoicePanelOptions {
  /** Replay this voice. Omitted, the Play button is left out. */
  onPlay?: (index: number) => void;
  /**
   * What is allowed to start playing on its own.
   *
   * Only 'never' earns a Play button: on click or on hover the patch is
   * already sounding by the time you could reach for one.
   */
  autoPlay?: 'hover' | 'click' | 'never';
  /** Rate the voice. Omitted, the rating row is left out. */
  onRate?: (value: number) => void;
  /** Jump to a related voice. Omitted, the lists are shown but not clickable. */
  onOpen?: (index: number) => void;
  /**
   * Brushing a related voice, so it can be auditioned the way a row in the
   * table is, and so the keyboard follows what you are hearing. Called with -1
   * when the cursor leaves the list. Whether anything actually sounds is the
   * play setting's business, not this panel's.
   */
  onHover?: (index: number) => void;
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

/**
 * A drawn pin, filled when it is stuck in.
 *
 * Drawn rather than a glyph for the same reason as the magnifier: the pushpin
 * characters are emoji on most systems, so they arrive in someone else's
 * colours at someone else's weight and cannot be told to match anything.
 */
function pinIcon(stuck: boolean): SVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('class', 'ico');
  svg.setAttribute('aria-hidden', 'true');
  const head = document.createElementNS(ns, 'path');
  // A pin seen from the side: a slanted head, a shaft, and a point.
  head.setAttribute('d', 'M9.6 1.5 14.5 6.4 12.3 7.1 11.1 10.5 5.5 4.9 8.9 3.7 Z');
  head.setAttribute('fill', stuck ? 'currentColor' : 'none');
  head.setAttribute('stroke', 'currentColor');
  head.setAttribute('stroke-width', '1.3');
  head.setAttribute('stroke-linejoin', 'round');
  const shaft = document.createElementNS(ns, 'path');
  shaft.setAttribute('d', 'M5.5 10.5 1.6 14.4');
  shaft.setAttribute('stroke', 'currentColor');
  shaft.setAttribute('stroke-width', '1.3');
  shaft.setAttribute('stroke-linecap', 'round');
  svg.appendChild(head);
  svg.appendChild(shaft);
  return svg;
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
    panel.appendChild(el('div', { class: 'voice-head' },
      el('div', { style: { minWidth: '0' } },
        el('div', { class: 'mono voice-name' }, v.name || '(unnamed)'),
        el('div', { class: 'muted', style: { marginTop: '2px' } },
          `algorithm ${(v.unpacked[P.algorithm] & 31) + 1}`,
          `  ·  feedback ${v.unpacked[P.feedback] & 7}`,
          v.pinned ? '  ·  favourite' : '')),
      /*
       * The three ways to take a patch somewhere else, stacked.
       *
       * Side by side they were wider than the name beside them in a sidebar
       * of ordinary width, and pushed it to an ellipsis - the one thing on
       * the panel that says which patch this is.
       */
      el('div', { class: 'voice-acts' },
      /*
       * The patch itself, as a link.
       *
       * 128 bytes of sysex fits in a URL, so sending somebody a sound needs no
       * upload and no account: they open the link and it is there, already
       * playing. If they have it, it opens theirs - matched on the parameters,
       * not the name, so their copy with their rating on it wins.
       */
      el('button', {
        class: 'voice-dl',
        title: 'Copy a link that carries this patch',
        onclick: (e: Event) => {
          e.stopPropagation();
          const button = e.currentTarget as HTMLButtonElement;
          const url = patchLinkFor(v.packed, v.name);
          void navigator.clipboard.writeText(url).then(() => {
            button.textContent = 'copied';
            window.setTimeout(() => { button.textContent = '\u21d7 link'; }, 1400);
          }, () => {
            // Clipboard refused - no permission, or an insecure origin. The
            // link still exists, so show it rather than failing silently.
            window.prompt('Copy this link:', url);
          });
        },
      }, '\u21d7 link'),
      // Straight to the hardware: the quickest way to hear what a patch really
      // does. Destructive on the FM-1, which is why its first press asks.
      sendToDeviceButton(v.unpacked, 'voice-dl'),
      // One patch, as a single-voice dump. Every DX7 editor and every clone
      // reads this, and wanting exactly the one you are looking at - to load
      // on the device, to send to someone, to keep - is a good deal more
      // common than wanting all forty thousand.
      el('button', {
        class: 'voice-dl',
        title: 'Download this patch as a single-voice .syx',
        onclick: (e: Event) => {
          e.stopPropagation();
          downloadBytes(buildSingleVoice(v.unpacked), patchFile(v.name));
        },
      }, '↓ .syx'))));
  }

  // The algorithm, drawn. Two patches on the same algorithm are the same
  // instrument wired differently, and that is much faster to take in as a
  // picture than as a number between 1 and 32.
  panel.appendChild(algorithmPanel(v.unpacked[P.algorithm] & 31, v.unpacked));

  /*
   * The three things you actually do to a patch, in one block.
   *
   * They were three separate rows - five numbered buttons, a sentence about
   * what the numbers meant, then Play and Pin on a line of their own - which
   * made the one part of the sidebar you interact with look like three more
   * paragraphs of read-only detail in a panel already full of them.
   *
   * Stars rather than digits: a rating is drawn as stars everywhere else in
   * the app, on the map, in the table and in the banks, so a row of numbers
   * here made you translate between two notations for one thing. The digits
   * are still how you rate quickly, which is what the legend underneath is
   * for - it says which keys do this, rather than being the control itself.
   */
  const actions = el('div', { class: 'voice-actions' });
  const row = el('div', { class: 'act-row' });

  if (opts.onRate) {
    const stars = el('div', {
      class: 'stars',
      title: rating ? `Rated ${rating}. Click the same star again to clear.` : 'Click to rate',
    });
    for (let r = 1; r <= 5; r++) {
      stars.appendChild(el('button', {
        class: `star${rating !== null && r <= rating ? ' on' : ''}`,
        title: `Rate ${r}`,
        onclick: () => opts.onRate?.(r),
      }, '★'));
    }
    row.appendChild(stars);
  }

  // Only worth a button when something has to ask for it. With autoplay on
  // click or on hover the patch in front of you is already sounding, and a
  // Play button then means "do again what just happened by itself".
  if (opts.onPlay && opts.autoPlay === 'never') {
    row.appendChild(el('button', {
      class: 'act-btn',
      title: 'Play the demo phrase',
      onclick: () => opts.onPlay?.(i),
    }, '▶ Play'));
  }
  row.appendChild(el('button', {
    class: v.pinned ? 'act-pin on' : 'act-pin',
    title: v.pinned ? 'A favourite: goes into the final 128 whatever its rating. Click to release.' : 'Mark as a favourite, so it goes into the final 128 regardless of rating',
    onclick: () => {
      void store.togglePin(i).then(changed);
    },
  }, pinIcon(v.pinned)));
  actions.appendChild(row);

  // A legend, not a control: what the keys do, once, quietly.
  actions.appendChild(el('div', { class: 'act-keys muted' },
    el('span', {}, el('kbd', {}, '1'), '–', el('kbd', {}, '5'), ' rate'),
    opts.onPlay ? el('span', {}, el('kbd', {}, 'space'), ' play') : null,
    el('span', {}, el('kbd', {}, '6'), ' favourite'),
    rating ? el('span', {}, 'same key again clears') : null,
  ));
  panel.appendChild(actions);

  /*
   * The measurements, two to a row, with a bar wherever a bar means something.
   *
   * This was one column of eleven label-and-number pairs running off the bottom
   * of the sidebar - a lot of scrolling to answer "is this one bright or not".
   * Two columns halve the height, and a bar against the range the corpus
   * actually occupies answers the question without arithmetic: "1.57 octaves
   * above f0" means nothing by itself, and means "fairly dark" the moment you
   * can see where it falls on the scale.
   *
   * Only quantities with a meaningful range get a bar. Category is a choice,
   * and the rating is already drawn as stars in the block above.
   */
  const grid = el('div', { class: 'stat-grid' });

  /** One cell: a label, a value, and optionally a bar under the pair. */
  const cell = (
    label: string, value: string,
    bar?: { at: number; of: number; from?: number; hint?: string },
  ) => {
    const box = el('div', { class: 'stat-cell', title: bar?.hint ?? '' },
      el('div', { class: 'stat-k' }, label),
      el('div', { class: 'stat-v' }, value));
    if (bar) {
      const frac = Math.max(0, Math.min(1, bar.of === 0 ? 0 : bar.at / bar.of));
      // A signed quantity grows out of its zero point in whichever direction it
      // went; an unsigned one just fills from the left.
      const zero = Math.max(0, Math.min(1, bar.from ?? 0));
      box.appendChild(el('div', { class: 'stat-bar' }, el('i', {
        style: {
          left: `${Math.min(frac, zero) * 100}%`,
          width: `${Math.max(1.5, Math.abs(frac - zero) * 100)}%`,
        },
      })));
    }
    grid.appendChild(box);
  };

  // Category spans both columns: it is the one editable thing down here.
  grid.appendChild(el('div', { class: 'stat-cell wide' },
    el('div', { class: 'stat-k' }, 'category'),
    el('select', {
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
  if (cat && sub) cell('subcategory', subcategoryLabel(cat, sub));

  const predicted = store.predictedRating(i);
  if (predicted !== null) {
    cell('predicted rating', predicted.toFixed(2),
      { at: predicted, of: 5, hint: 'what the model expects you would rate this' });
  }

  if (a) {
    const attackMs = Math.pow(10, a.acoustic.logAttackTime) * 1000;
    const releaseS = Math.pow(10, a.acoustic.logReleaseTime);
    // Scaled to what the corpus actually spans rather than what is
    // theoretically possible: a bar sized for the widest outlier leaves every
    // ordinary patch pinned to the left of it. Times are logarithmic, because
    // the difference between 5 and 50 ms matters and 400 and 450 does not.
    cell('attack', `${attackMs.toFixed(0)} ms`,
      { at: Math.log10(1 + attackMs), of: Math.log10(401), hint: '0 to 400 ms, logarithmic' });
    cell('release', `${releaseS.toFixed(2)} s${a.acoustic.releaseCensored ? '*' : ''}`, {
      at: Math.log10(1 + releaseS),
      of: Math.log10(9),
      hint: a.acoustic.releaseCensored
        ? 'extrapolated: still sounding when the probe ended'
        : '0 to 8 s, logarithmic',
    });
    cell('sustain', a.acoustic.sustainRatio.toFixed(2),
      { at: a.acoustic.sustainRatio, of: 1, hint: '0 plucks and dies, 1 holds' });
    cell('brightness', `${a.acoustic.centroidOct.toFixed(2)} oct`,
      { at: a.acoustic.centroidOct, of: 5, hint: 'octaves above the fundamental' });
    cell('register', `${a.acoustic.registerOct >= 0 ? '+' : ''}${a.acoustic.registerOct.toFixed(2)} oct`,
      { at: (a.acoustic.registerOct + 2) / 4, of: 1, from: 0.5, hint: 'octaves away from the note played' });
    cell('inharmonicity', a.acoustic.inharmonicity.toFixed(3),
      { at: a.acoustic.inharmonicity, of: 0.1, hint: '0 is a harmonic tone; high is bell-like' });
    cell('velocity', `${a.acoustic.velLevelDb.toFixed(1)} dB`,
      { at: a.acoustic.velLevelDb, of: 30, hint: 'how much louder a hard note is' });
    cell('vel. brightness', `${a.acoustic.velBrightnessOct.toFixed(2)} oct`,
      { at: a.acoustic.velBrightnessOct, of: 2, hint: 'how much brighter a hard note is' });
  }
  panel.appendChild(grid);
  if (a?.acoustic.releaseCensored) {
    panel.appendChild(el('div', { class: 'muted', style: { fontSize: '10.5px', marginTop: '6px' } },
      '* release extrapolated: it was still sounding when the probe ended'));
  }

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
  /*
   * The family, nearest first.
   *
   * The list is for comparing this patch against the things it might be
   * confused with, and that comparison has an order: the one that sounds most
   * like it is the one worth hearing first, and the far end of a family of
   * forty is where you stop caring. Cluster membership arrives in index order,
   * which is the order the files happened to be read in and means nothing.
   *
   * Distances are computed once per member rather than inside the comparator,
   * since a large family would otherwise measure the same pair repeatedly.
   */
  const contenders = (() => {
    const list = store.familyContenders(i).filter((m) => m !== i);
    const away = new Map(list.map((m) => [m, store.featureDistance(i, m)]));
    return list.sort((a, b) => (away.get(a) ?? 0) - (away.get(b) ?? 0));
  })();

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
    /*
     * A family list, in the same shape as every other list in the app.
     *
     * These were full-width buttons stacked three pixels apart, which is
     * tolerable for the two or three merged copies and absurd for a family of
     * forty-three: half a screen of grey slabs you have to click one at a time
     * to find out what any of them sound like. As dense rows with the category
     * dot and the rating on them, forty-three is a list you can read - and
     * brushing one plays it, exactly like brushing a row in the table.
     */
    const voiceList = (title: string, indices: number[], note: string) => {
      if (indices.length === 0) return;
      // Raised onto its own surface, because this is a group of other patches
      // sitting inside a panel about one patch, and without a boundary it
      // reads as more facts about the one at the top.
      const group = el('div', { class: 'voice-group' });
      group.appendChild(el('h3', { style: { margin: '0 0 2px' } }, `${title} (${indices.length})`));
      group.appendChild(el('div', { class: 'muted', style: { fontSize: '10.5px', marginBottom: '8px' } }, note));
      const list = el('div', {
        class: 'voice-list',
        // -1 means "the cursor has left": the caller re-arms whatever was
        // selected, so the keyboard does not stay pointed at the last family
        // member you happened to brush past.
        onpointerleave: () => opts.onHover?.(-1),
      });
      for (const m of indices) {
        const mCat = store.categoryOf(m);
        const mRating = store.ratingOf(m);
        list.appendChild(el('button', {
          class: 'vl-row',
          onpointerenter: () => opts.onHover?.(m),
          onclick: () => opts.onOpen?.(m),
        },
          el('span', {
            class: 'dot',
            style: { background: mCat ? categoryColour(mCat) : 'var(--raise-2)' },
          }),
          el('span', { class: 'vl-name' }, store.voices[m].name || '(unnamed)'),
          store.voices[m].pinned ? el('span', { class: 'slot-pin' }, '●') : null,
          el('span', { class: mRating ? 'vl-rating on' : 'vl-rating' },
            mRating ? '★'.repeat(mRating) : ''),
        ));
      }
      group.appendChild(list);
      panel.appendChild(group);
    };

    /*
     * The family first, then the copies.
     *
     * Both lists were here in the other order, which put the least interesting
     * one at the top: merged voices are by definition the ones you cannot tell
     * apart, so there is nothing to listen for, while the family is the set
     * this patch is actually competing against.
     */
    voiceList('Others in this family', contenders, 'similar but audibly different, nearest first');
    voiceList('Merged into this one', mergedOthers, 'these should be indistinguishable; if one is not, raise the merge threshold');
  }

  if (opts.sources !== false) {
    // Every one of them, in a box that scrolls. A count with "and 15 more"
    // under it answers the least interesting half of the question: the whole
    // point of this list is to see which collections a patch turns up in, and
    // the fifteen you cannot see are as much a part of that as the ten you can.
    // Grouped by name and file, with the slots gathered onto one line. A patch
    // that sits in eight slots of the same cartridge, or arrived twice because
    // a folder was imported again, produced eight or sixteen identical-looking
    // lines - which is what made the list long enough to want truncating in the
    // first place. Collapsed, it is usually short enough to read whole.
    const groups = new Map<string, {
      name: string; file: string; slots: number[]; at: number; atFrom: string;
    }>();
    for (const src of v.sources) {
      const name = src.name.trim() || '(unnamed)';
      const key = `${name}\u0000${src.file}`;
      const group = groups.get(key)
        ?? { name, file: src.file, slots: [], at: src.at ?? 0, atFrom: src.atFrom ?? '' };
      group.slots.push(src.slot + 1);
      groups.set(key, group);
    }
    const files = new Set(v.sources.map((src) => src.file)).size;
    panel.appendChild(el('h3', {},
      `Where this one came from (${v.sources.length} in ${files} file${files === 1 ? '' : 's'})`));

    // Dedupe ignores the name bytes, so one voice can arrive under several
    // names. Each line carries the name that copy had in that file, even when
    // it matches this voice's own - it is what the file actually says.
    const ul = el('ul', { class: 'muted mono src-list' });
    // Oldest first, undated last. Where a patch turned up earliest is the
    // closest thing to provenance this corpus can offer.
    const ordered = [...groups.values()].sort((a, b) => (a.at || Infinity) - (b.at || Infinity));
    for (const group of ordered) {
      const counted = new Map<number, number>();
      for (const slot of group.slots) counted.set(slot, (counted.get(slot) ?? 0) + 1);
      const slots = [...counted.entries()]
        .sort((a, b) => a[0] - b[0])
        // A slot listed twice means the same file was imported twice, which is
        // worth seeing rather than silently collapsing.
        .map(([slot, n]) => (n > 1 ? `${slot}×${n}` : String(slot)));
      // Two lines: what it was called and where it sat, then the path.
      //
      // The path is the long, boring, indispensable part - long enough to push
      // the name off the edge if they share a line, and indispensable because
      // it is the only way to tell which of forty collections this came from.
      // It is truncated in the middle rather than the end, since the filename
      // identifies a pack and the directories above it rarely do.
      const line = el('li', {});
      const head = el('div', { class: 'src-head' },
        el('b', {}, group.name),
        el('span', { class: 'muted' },
          `  slot${slots.length === 1 ? '' : 's'} ${slots.join(', ')}`));
      // The date, when the file had one worth keeping. Dimmer for a loose
      // file's own timestamp, which is usually just the day it was downloaded,
      // than for an archive entry's, which usually survives from whenever the
      // pack was put together.
      if (group.at > 0) {
        head.appendChild(el('span', {
          class: 'src-date',
          style: { opacity: group.atFrom === 'archive' ? '0.9' : '0.45' },
          title: group.atFrom === 'archive'
            ? 'from inside the archive, usually the date the pack was made'
            : 'the file\u2019s own timestamp, often just when it was downloaded',
        }, new Date(group.at).toISOString().slice(0, 10)));
      }
      line.appendChild(head);

      const cut = group.file.lastIndexOf('/');
      line.appendChild(el('div', { class: 'src-path', title: group.file },
        el('span', { class: 'src-dir' }, cut >= 0 ? group.file.slice(0, cut) : ''),
        el('span', { class: 'src-file' }, cut >= 0 ? group.file.slice(cut) : group.file)));
      ul.appendChild(line);
    }
    panel.appendChild(ul);
  }

  return panel;
}
