/*
 * Build: allocate the 128, order them, write the four banks, and get them onto
 * the device.
 *
 * The allocation controls are all here rather than buried in a config file,
 * because the floors and ceilings are the main thing the user will want to
 * argue with after seeing the first result.
 */
import { clear, downloadBytes, el, fmtInt } from '../dom.ts';
import type { View, ViewContext } from '../app.ts';
import { CATEGORIES, CATEGORY_LABELS, type Category } from '../../cluster/category.ts';
import { allocate, DEFAULT_CEILINGS, DEFAULT_FLOORS, type Candidate, type AllocationResult } from '../../alloc/allocate.ts';
import { chooseEndpoints, seriate, withCategoryAxis } from '../../order/seriate.ts';
import { buildBanksPadded, verifyBank, BANK_NAMES } from '../../sysex/write.ts';
import { listOutputs, midiSupported, requestMidi, sendBanks, sendProgramChange, sendTestNote, type MidiPort } from '../../midi/webmidi.ts';
import { P } from '../../sysex/voice.ts';
import { FEATURE_COUNT } from '../../features/vector.ts';
import { DEMO_PHRASE } from '../../engine/phrase.ts';

const CATEGORY_COLOURS: Record<Category, string> = {
  keys: '#6ea8fe',
  bells: '#c58cf5',
  plucked: '#7bd88f',
  bass: '#f2a65a',
  brass: '#f2777a',
  lead: '#ef8fd0',
  organ: '#8fb0f5',
  strings: '#5fd0c5',
  abstract: '#9aa3b2',
};

let ctx: ViewContext;
let root: HTMLElement;

const floors: Record<Category, number> = { ...DEFAULT_FLOORS };
const ceilings: Record<Category, number> = { ...DEFAULT_CEILINGS };
let minRating = 4;
let total = 128;
let backfill = true;
let categoryAxisWeight = 6;

let allocation: AllocationResult | null = null;
let ordered: number[] = [];
let banks: Uint8Array[] = [];
let bankNames: string[] = [];
let verification: string[] = [];
let midiPorts: MidiPort[] = [];
let midiOutputId = '';
let midiMessage = '';

/**
 * One candidate per surviving near-duplicate family, plus every pinned voice.
 * A family that went through a face-off contributes its winner and any extras
 * the user chose to keep; each of those consumes a slot.
 */
function candidates(): Candidate[] {
  const store = ctx.store;
  const out: Candidate[] = [];
  const seen = new Set<number>();

  const push = (index: number, rating: number, pinned: boolean, tieBreak: number) => {
    if (seen.has(index)) return;
    const cat = store.categoryOf(index);
    if (!cat) return;
    seen.add(index);
    out.push({ id: index, category: cat, rating, pinned, tieBreak });
  };

  if (store.clusters) {
    for (let id = 0; id < store.clusters.clusters.length; id++) {
      const rep = store.representatives[id];
      const rating = store.ratingOf(rep) ?? 0;
      const chosen = store.faceoffExtras.get(id) ?? [rep];
      const familySize = store.clusters.clusters[id].length;
      for (const index of chosen) push(index, rating, store.voices[index]?.pinned ?? false, familySize);
    }
  }
  for (let i = 0; i < store.voices.length; i++) {
    if (store.voices[i].pinned) push(i, store.ratingOf(i) ?? 5, true, 1);
  }
  return out;
}

function runAllocation(): void {
  allocation = allocate(candidates(), { total, minRating, floors, ceilings, backfill });
  ordered = [];
  banks = [];
  verification = [];
  render();
}

function runOrdering(): void {
  const store = ctx.store;
  const flat = store.distanceSpace;
  if (!allocation || !flat) return;
  const ids = allocation.selected.map((c) => c.id);
  const vectors = ids.map((i) => Float32Array.from(flat.subarray(i * FEATURE_COUNT, (i + 1) * FEATURE_COUNT)));
  const cats = ids.map((i) => store.categoryOf(i)!).filter(Boolean) as Category[];
  const augmented = withCategoryAxis(vectors, cats, categoryAxisWeight);
  const ends = chooseEndpoints(augmented, cats);
  const result = seriate(augmented, ends);
  ordered = result.order.map((k) => ids[k]);
  buildFiles();
  render();
}

function buildFiles(): void {
  banks = [];
  bankNames = [];
  verification = [];
  if (ordered.length === 0) {
    verification.push('nothing selected yet');
    return;
  }
  const patches = ordered.map((i) => ctx.store.voices[i].unpacked);
  try {
    const built = buildBanksPadded(patches, { maxBanks: Math.max(1, Math.ceil(total / 32)) });
    banks = built.banks;
    bankNames = [...built.names];
    for (let b = 0; b < banks.length; b++) {
      const expected = patches.slice(b * 32, b * 32 + 32);
      const v = verifyBank(banks[b], expected.length === 32 ? expected : undefined);
      const filled = Math.min(32, Math.max(0, patches.length - b * 32));
      verification.push(v.ok
        ? `bank ${bankNames[b]}: 4104 bytes, checksum 0x${banks[b][4102].toString(16).padStart(2, '0')}` +
          (filled < 32
            ? `, ${filled} voices and ${32 - filled} empty slots`
            : ', all 32 voices round-trip byte for byte')
        : `bank ${bankNames[b]}: FAILED - ${v.problems.slice(0, 2).join('; ')}`);
    }
    if (built.placeholders > 0) {
      verification.push(`${built.placeholders} slots written as silent "-- EMPTY --" voices, safe to overwrite later`);
    }
  } catch (err) {
    verification.push(`could not build banks: ${(err as Error).message}`);
  }
}

function limitsPanel(): HTMLElement {
  const table = el('table', { class: 'data' });
  table.appendChild(el('thead', {}, el('tr', {},
    el('th', {}, 'category'),
    el('th', { class: 'num' }, 'floor'),
    el('th', { class: 'num' }, 'ceiling'),
    el('th', { class: 'num' }, 'available'),
    el('th', { class: 'num' }, 'weight'),
    el('th', { class: 'num' }, 'allocated'),
  )));
  const body = el('tbody');
  const outcome = new Map(allocation?.byCategory.map((o) => [o.category, o]) ?? []);
  for (const c of CATEGORIES) {
    const o = outcome.get(c);
    body.appendChild(el('tr', {},
      el('td', {}, el('span', { class: 'slot-cat', style: { background: CATEGORY_COLOURS[c] } }), CATEGORY_LABELS[c]),
      el('td', { class: 'num' }, el('input', {
        type: 'number', min: 0, max: 128, value: floors[c],
        style: { width: '58px' },
        onchange: (e: Event) => { floors[c] = Number((e.target as HTMLInputElement).value); },
      })),
      el('td', { class: 'num' }, el('input', {
        type: 'number', min: 0, max: 128, value: ceilings[c],
        style: { width: '58px' },
        onchange: (e: Event) => { ceilings[c] = Number((e.target as HTMLInputElement).value); },
      })),
      el('td', { class: 'num muted' }, o ? fmtInt(o.available) : '—'),
      el('td', { class: 'num muted' }, o ? o.weight.toFixed(2) : '—'),
      el('td', { class: 'num' }, o ? fmtInt(o.allocated) : '—'),
    ));
  }
  table.appendChild(body);
  return table;
}

function banksPanel(): HTMLElement {
  const grid = el('div', { class: 'bank-grid' });
  const bankCount = Math.max(1, Math.ceil(ordered.length / 32));
  for (let b = 0; b < bankCount; b++) {
    const list = el('ol', { start: String(b * 32 + 1) });
    for (let s = 0; s < 32; s++) {
      const i = ordered[b * 32 + s];
      if (i === undefined) continue;
      const v = ctx.store.voices[i];
      const cat = ctx.store.categoryOf(i);
      list.appendChild(el('li', {},
        el('span', {
          class: 'slot-cat',
          style: { background: cat ? CATEGORY_COLOURS[cat] : '#555' },
        }),
        el('a', {
          href: '#',
          style: { color: 'inherit', textDecoration: 'none' },
          onclick: (e: Event) => {
            e.preventDefault();
            void ctx.player.audition(v.id, v.unpacked, DEMO_PHRASE);
          },
        }, v.name || '(unnamed)'),
      ));
    }
    const filled = Math.min(32, Math.max(0, ordered.length - b * 32));
    grid.appendChild(el('div', { class: 'bank' },
      el('h4', {}, `bank ${BANK_NAMES[b]}`, filled < 32 ? el('span', { class: 'warn' }, ` ${filled}/32`) : null),
      list));
  }
  return grid;
}

async function connectMidi(): Promise<void> {
  const state = await requestMidi();
  midiPorts = state.outputs;
  midiOutputId = midiPorts[0]?.id ?? '';
  midiMessage = state.error ?? (midiPorts.length ? '' : 'No MIDI outputs found. Connect the FM-1 and try again.');
  render();
}

function midiPanel(): HTMLElement {
  const panel = el('div', { class: 'panel' }, el('h3', { style: { marginTop: 0 } }, 'Send to the device'));
  if (!midiSupported()) {
    panel.appendChild(el('p', { class: 'warn' },
      'This browser has no WebMIDI. Use Chrome, or export the four files and load them through DXcompanion.uk or dx7-to-fm1.dev.'));
    return panel;
  }
  panel.appendChild(el('p', { class: 'hint' },
    'A 32-voice bulk dump carries no slot address, so the receiving end decides where each bank lands. ',
    'Put the FM-1 into receive for the right bank between sends.'));

  panel.appendChild(el('div', { class: 'row' },
    el('button', { class: 'btn', onclick: () => void connectMidi() }, midiPorts.length ? 'Rescan outputs' : 'Connect MIDI'),
    midiPorts.length
      ? el('select', {
        onchange: (e: Event) => { midiOutputId = (e.target as HTMLSelectElement).value; },
      }, ...midiPorts.map((p) => el('option', { value: p.id, selected: p.id === midiOutputId }, `${p.name} ${p.manufacturer}`.trim())))
      : null,
    el('button', {
      class: 'btn',
      disabled: !midiOutputId,
      onclick: () => {
        try {
          sendTestNote(midiOutputId);
          midiMessage = 'sent a middle C';
        } catch (err) {
          midiMessage = (err as Error).message;
        }
        render();
      },
    }, 'Test note'),
    el('button', {
      class: 'btn primary',
      disabled: !midiOutputId || banks.length === 0,
      onclick: async () => {
        try {
          await sendBanks(midiOutputId, banks, bankNames.map((n) => `bank ${n}`), {
            onProgress: (sent, all, label) => {
              midiMessage = sent >= all ? 'all four banks sent' : `sending ${label} (${sent + 1} of ${all})`;
              render();
            },
          });
        } catch (err) {
          midiMessage = (err as Error).message;
          render();
        }
      },
    }, `Send ${banks.length || 'all'} bank${banks.length === 1 ? '' : 's'}`),
  ));

  panel.appendChild(el('h3', {}, 'Check the far end'));
  panel.appendChild(el('p', { class: 'hint' },
    'Accounts differ on whether all four groups are reachable from the FM-1 front panel. Load an unmistakable patch into ',
    'the last slot of bank D, then try to reach it two ways: by scrolling, and with program change 127.'));
  panel.appendChild(el('div', { class: 'row' },
    el('button', {
      class: 'btn',
      disabled: !midiOutputId,
      onclick: () => {
        try {
          sendProgramChange(midiOutputId, 127);
          midiMessage = 'sent program change 127';
        } catch (err) {
          midiMessage = (err as Error).message;
        }
        render();
      },
    }, 'Program change 127'),
    el('button', {
      class: 'btn',
      disabled: !midiOutputId,
      onclick: () => {
        try {
          sendProgramChange(midiOutputId, 0);
          midiMessage = 'sent program change 0';
        } catch (err) {
          midiMessage = (err as Error).message;
        }
        render();
      },
    }, 'Program change 0'),
  ));

  if (midiMessage) panel.appendChild(el('p', { class: 'muted', style: { marginBottom: 0 } }, midiMessage));
  return panel;
}

function render(): void {
  clear(root);
  const store = ctx.store;
  const page = el('div', { class: 'stack' });

  page.appendChild(el('div', { class: 'panel' },
    el('h2', {}, 'Build'),
    el('p', { class: 'hint' },
      'Pinned voices are seated first. Each category then gets a floor, so a minority category survives even if you rated it ',
      'lukewarm, and a ceiling, so no one category eats the bank. What is left is split in proportion to how highly you rated ',
      'each category’s best patches. Inside a category, filling is purely by rating rank.'),
    el('div', { class: 'row' },
      el('label', { class: 'field' }, 'total slots',
        el('input', {
          type: 'number', min: 32, max: 128, step: 32, value: total,
          onchange: (e: Event) => { total = Number((e.target as HTMLInputElement).value); },
        })),
      el('label', { class: 'field' }, 'minimum rating',
        el('input', {
          type: 'number', min: 1, max: 5, value: minRating,
          onchange: (e: Event) => { minRating = Number((e.target as HTMLInputElement).value); },
        })),
      el('label', { class: 'field', title: 'Fill leftover slots with lower-rated patches rather than leaving them empty' },
        el('input', {
          type: 'checkbox', checked: backfill,
          onchange: (e: Event) => { backfill = (e.target as HTMLInputElement).checked; },
        }), 'backfill gaps'),
      el('button', { class: 'btn primary', onclick: () => runAllocation() }, 'Allocate'),
    ),
    el('p', { class: 'hint', style: { marginBottom: 0, marginTop: '10px' } },
      '128 is a lot to fill from one rating pass. If there are not enough keepers the leftover slots are taken by the ',
      'next-best patches, marked as backfill, and anything still empty is written as a silent placeholder so the banks ',
      'stay valid. Dropping the total to 96 or 64 builds fewer, better banks instead.'),
  ));

  page.appendChild(el('div', { class: 'panel' },
    el('h3', { style: { marginTop: 0 } }, 'Category limits'),
    limitsPanel(),
  ));

  if (allocation) {
    const summary = el('div', { class: 'panel' },
      el('h3', { style: { marginTop: 0 } }, 'Selection'),
      el('div', { class: 'stats' },
        el('div', { class: 'stat' }, el('div', { class: 'k' }, 'selected'), el('div', { class: 'v' }, fmtInt(allocation.selected.length))),
        el('div', { class: 'stat' }, el('div', { class: 'k' }, `on merit (${minRating}+)`), el('div', { class: 'v' }, fmtInt(allocation.onMerit))),
        el('div', { class: 'stat' }, el('div', { class: 'k' }, 'backfilled'), el('div', { class: 'v' }, fmtInt(allocation.backfilled))),
        el('div', { class: 'stat' }, el('div', { class: 'k' }, 'empty slots'), el('div', { class: 'v' }, fmtInt(allocation.unfilled))),
        el('div', { class: 'stat' }, el('div', { class: 'k' }, 'pinned'), el('div', { class: 'v' }, fmtInt(allocation.selected.filter((c) => c.pinned).length))),
        el('div', { class: 'stat' }, el('div', { class: 'k' }, 'candidates'), el('div', { class: 'v' }, fmtInt(candidates().length))),
      ),
    );
    for (const w of allocation.warnings) summary.appendChild(el('p', { class: 'warn', style: { marginBottom: 0 } }, w));
    summary.appendChild(el('div', { class: 'row', style: { marginTop: '14px' } },
      el('label', { class: 'field' }, 'category ordering strength',
        el('input', {
          type: 'number', min: 0, max: 40, step: 1, value: categoryAxisWeight,
          onchange: (e: Event) => { categoryAxisWeight = Number((e.target as HTMLInputElement).value); },
        })),
      el('button', {
        class: 'btn primary',
        disabled: allocation.selected.length === 0,
        onclick: () => runOrdering(),
      }, 'Order and build'),
      el('span', { class: 'muted' }, '0 follows the sound alone; higher marches through the categories in order'),
    ));
    page.appendChild(summary);
  }

  if (ordered.length) {
    page.appendChild(el('div', { class: 'panel' },
      el('h3', { style: { marginTop: 0 } }, 'The 128, in order'),
      el('p', { class: 'hint' },
        'Split at 32/64/96 with no regard for category boundaries — the point is that neighbouring slots sound adjacent ',
        'wherever you land while scrolling. Click a name to hear it.'),
      banksPanel(),
    ));

    const verifyPanel = el('div', { class: 'panel' }, el('h3', { style: { marginTop: 0 } }, 'Files'));
    for (const line of verification) {
      verifyPanel.appendChild(el('div', { class: line.includes('FAILED') || line.includes('could not') ? 'bad mono' : 'good mono' }, line));
    }
    if (banks.length === 4) {
      verifyPanel.appendChild(el('div', { class: 'row', style: { marginTop: '12px' } },
        ...banks.map((bytes, b) => el('button', {
          class: 'btn',
          onclick: () => downloadBytes(bytes, `dx7-curated-${bankNames[b]}.syx`),
        }, `Download bank ${bankNames[b]}`)),
        el('button', {
          class: 'btn',
          onclick: () => {
            const all = new Uint8Array(banks.reduce((n, b) => n + b.length, 0));
            let at = 0;
            for (const b of banks) {
              all.set(b, at);
              at += b.length;
            }
            downloadBytes(all, 'dx7-curated-all.syx');
          },
        }, 'Download all four in one file'),
      ));
    }
    page.appendChild(verifyPanel);
    page.appendChild(midiPanel());
  }

  if (!store.clusters) {
    page.appendChild(el('p', { class: 'warn' },
      'Near-duplicate clustering has not run, so every voice is being treated as its own family.'));
  }

  root.appendChild(page);
}

export const view: View = {
  mount(container, c) {
    ctx = c;
    root = container;
    midiPorts = listOutputs();
    midiOutputId = midiPorts[0]?.id ?? '';
    runAllocation();
  },
  unmount() {
    ctx?.player.stop();
  },
};
