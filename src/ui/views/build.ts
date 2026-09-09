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
import { kvGet, kvSet } from '../../db/store.ts';
import { keyboard } from '../../audio/keyboard.ts';
import { voiceDetails } from '../voicePanel.ts';

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
let sideEl: HTMLElement | null = null;
let keyHandler: ((e: KeyboardEvent) => void) | null = null;

const floors: Record<Category, number> = { ...DEFAULT_FLOORS };
const ceilings: Record<Category, number> = { ...DEFAULT_CEILINGS };
let minRating = 4;
let total = 128;
let backfill = true;
let categoryAxisWeight = 6;

let allocation: AllocationResult | null = null;
let ordered: number[] = [];
/** The slot the cursor is over, and the one clicked to keep. Indices into voices. */
let hovered = -1;
let selected = -1;
let builtAt = 0;
/** What the corpus looked like when this build was made. */
let builtFrom: BuildInputs | null = null;
let restored = false;
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
/**
 * A fingerprint of everything a build depends on.
 *
 * The point is not to detect any change at all - it is to answer "is what I am
 * looking at still what my ratings say?" A build is the end of a long process,
 * and coming back a day later to a list of 128 names with no idea whether it
 * predates the last forty ratings is the worst version of this screen.
 *
 * Ratings, pins, face-off winners and the two thresholds are the inputs that
 * change the answer; the allocation settings are here too because changing a
 * ceiling and not pressing Allocate leaves the same trap.
 */
interface BuildInputs {
  ratings: number;
  ratingHash: number;
  pinned: number;
  extras: number;
  overrides: number;
  threshold: number;
  mergeThreshold: number;
  total: number;
  minRating: number;
  backfill: boolean;
  categoryAxisWeight: number;
  limits: number;
}

interface StoredBuild {
  ordered: number[];
  builtAt: number;
  inputs: BuildInputs;
  settings: {
    total: number;
    minRating: number;
    backfill: boolean;
    categoryAxisWeight: number;
    floors: Record<string, number>;
    ceilings: Record<string, number>;
  };
}

const BUILD_KEY = 'lastBuild';

/** Order-independent, so it does not care which order the ratings arrived in. */
function mixHash(h: number, value: number): number {
  return (h + Math.imul(value | 0, 2654435761)) >>> 0;
}

function currentInputs(): BuildInputs {
  const store = ctx.store;
  let ratingHash = 0;
  for (const [id, r] of store.ratings) ratingHash = mixHash(ratingHash, id * 8 + r.rating);
  let pinned = 0;
  for (const v of store.voices) if (v.pinned) pinned++;
  let extras = 0;
  for (const [, list] of store.faceoffExtras) extras += list.length + 1;
  let limits = 0;
  for (const c of CATEGORIES) limits = mixHash(limits, floors[c] * 1000 + ceilings[c]);
  return {
    ratings: store.ratings.size,
    ratingHash,
    pinned,
    extras,
    overrides: store.categoryOverrides.size,
    threshold: store.threshold,
    mergeThreshold: store.mergeThreshold,
    total,
    minRating,
    backfill,
    categoryAxisWeight,
    limits,
  };
}

/** What changed since the stored build, in words rather than a boolean. */
function staleReasons(): string[] {
  if (!builtFrom) return [];
  const now = currentInputs();
  const out: string[] = [];
  if (now.ratings !== builtFrom.ratings) {
    const d = now.ratings - builtFrom.ratings;
    out.push(d > 0 ? `${fmtInt(d)} more ratings` : `${fmtInt(-d)} fewer ratings`);
  } else if (now.ratingHash !== builtFrom.ratingHash) {
    out.push('ratings changed');
  }
  if (now.pinned !== builtFrom.pinned) out.push('pins changed');
  if (now.extras !== builtFrom.extras) out.push('face-off results changed');
  if (now.overrides !== builtFrom.overrides) out.push('categories overridden');
  if (now.threshold !== builtFrom.threshold || now.mergeThreshold !== builtFrom.mergeThreshold) {
    out.push('duplicate thresholds changed');
  }
  if (now.total !== builtFrom.total) out.push(`total is now ${now.total}`);
  if (now.minRating !== builtFrom.minRating) out.push(`minimum rating is now ${now.minRating}`);
  if (now.backfill !== builtFrom.backfill) out.push(now.backfill ? 'backfill turned on' : 'backfill turned off');
  if (now.limits !== builtFrom.limits) out.push('category limits changed');
  if (now.categoryAxisWeight !== builtFrom.categoryAxisWeight) out.push('ordering strength changed');
  return out;
}

async function saveBuild(): Promise<void> {
  builtAt = Date.now();
  builtFrom = currentInputs();
  const record: StoredBuild = {
    ordered,
    builtAt,
    inputs: builtFrom,
    settings: { total, minRating, backfill, categoryAxisWeight, floors: { ...floors }, ceilings: { ...ceilings } },
  };
  await kvSet(BUILD_KEY, record);
}

/**
 * Bring back the last build rather than starting from nothing.
 *
 * A build takes a seriation over a hundred-odd voices and a set of decisions
 * the user made about floors and ceilings; throwing that away every time the
 * tab is opened means the screen never shows what was actually sent to the
 * device.
 */
async function restoreBuild(): Promise<void> {
  const record = await kvGet<StoredBuild>(BUILD_KEY);
  restored = true;
  if (!record || !Array.isArray(record.ordered)) {
    runAllocation();
    render();
    return;
  }
  const store = ctx.store;
  total = record.settings.total ?? total;
  minRating = record.settings.minRating ?? minRating;
  backfill = record.settings.backfill ?? backfill;
  categoryAxisWeight = record.settings.categoryAxisWeight ?? categoryAxisWeight;
  for (const c of CATEGORIES) {
    if (record.settings.floors?.[c] !== undefined) floors[c] = record.settings.floors[c];
    if (record.settings.ceilings?.[c] !== undefined) ceilings[c] = record.settings.ceilings[c];
  }
  // Voices can have been deleted since; a build that names one is still worth
  // showing, minus the missing slots.
  ordered = record.ordered.filter((i) => store.voices[i]);
  builtAt = record.builtAt;
  builtFrom = record.inputs;
  runAllocation({ keepOrder: true });
  if (ordered.length) buildFiles();
  render();
}

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

function runAllocation(opts: { keepOrder?: boolean } = {}): void {
  allocation = allocate(candidates(), { total, minRating, floors, ceilings, backfill });
  if (!opts.keepOrder) {
    ordered = [];
    banks = [];
    verification = [];
    hovered = -1;
    selected = -1;
  }
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
  void saveBuild();
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
      const target = selected >= 0 ? selected : hovered;
      list.appendChild(el('li', {
        class: `slot${i === target ? ' on' : ''}${i === selected ? ' held' : ''}`,
        'data-index': String(i),
        // Same rule as the map: the cursor arms the keyboard and fills the
        // sidebar, a click keeps it there. A list of 128 names is exactly where
        // you want to play a few of them yourself rather than take the demo
        // phrase's word for it.
        onpointerenter: () => {
          if (selected >= 0) return;
          hovered = i;
          armKeyboard();
          renderSide();
          highlight();
        },
        onclick: (e: Event) => {
          e.preventDefault();
          selected = selected === i ? -1 : i;
          hovered = i;
          armKeyboard();
          void ctx.player.audition(v.id, v.unpacked, DEMO_PHRASE);
          renderSide();
          highlight();
        },
      },
        el('span', {
          class: 'slot-cat',
          style: { background: cat ? CATEGORY_COLOURS[cat] : '#555' },
        }),
        el('span', { class: 'slot-name' }, v.name || '(unnamed)'),
      ));
    }
    const filled = Math.min(32, Math.max(0, ordered.length - b * 32));
    grid.appendChild(el('div', { class: 'bank' },
      el('h4', {}, `bank ${BANK_NAMES[b]}`, filled < 32 ? el('span', { class: 'warn' }, ` ${filled}/32`) : null),
      list));
  }
  return grid;
}

/** Whatever the MIDI keyboard should be playing right now. */
function armKeyboard(): void {
  const i = selected >= 0 ? selected : hovered;
  keyboard.setPatch(i >= 0 ? ctx.store.voices[i]?.unpacked ?? null : null);
}

/**
 * Repaint the highlight in place.
 *
 * Re-rendering the whole page on every pointerenter would rebuild a hundred and
 * twenty-eight list items and both canvases in the sidebar, which is visible as
 * a stutter when you sweep down a bank.
 */
function highlight(): void {
  const target = selected >= 0 ? selected : hovered;
  const items = root.querySelectorAll('li.slot');
  for (const item of Array.from(items)) {
    const at = Number((item as HTMLElement).dataset.index);
    item.classList.toggle('on', at === target);
    item.classList.toggle('held', at === selected);
  }
}

function renderSide(): void {
  if (!sideEl) return;
  clear(sideEl);
  const i = selected >= 0 ? selected : hovered;
  if (i < 0) {
    sideEl.appendChild(el('p', { class: 'muted' },
      'Hover a slot to arm the keyboard on it. Click to keep it, and to hear the demo phrase.'));
    return;
  }
  sideEl.appendChild(voiceDetails(ctx.store, i, {
    onPlay: (n) => {
      const v = ctx.store.voices[n];
      if (v) void ctx.player.audition(v.id, v.unpacked, DEMO_PHRASE);
    },
    onRate: (r) => void rateTarget(r),
    onChange: () => {
      renderSide();
      render();
    },
  }));
}

/** Rating from here too, so a slot that disappoints can be demoted in place. */
async function rateTarget(value: number): Promise<void> {
  const i = selected >= 0 ? selected : hovered;
  if (i < 0) return;
  const current = ctx.store.ratingOf(i);
  if (current === value) await ctx.store.clearRating(i);
  else await ctx.store.rate(i, value, 'round1');
  renderSide();
  render();
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

/** How long ago, in words. Anything older than a day only needs the day. */
function ago(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 90) return 'just now';
  const m = Math.round(s / 60);
  if (m < 90) return `${m} minute${m === 1 ? '' : 's'} ago`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h} hour${h === 1 ? '' : 's'} ago`;
  return `${Math.round(h / 24)} days ago`;
}

/**
 * What was built last, and whether it still matches the corpus.
 *
 * Without this the screen forgets: every visit started from an empty
 * allocation, so the four files last sent to the device existed nowhere in the
 * app and there was no way to tell whether they predated the last hour of
 * rating.
 */
function buildStatePanel(): HTMLElement | null {
  if (!builtAt || ordered.length === 0) return null;
  const reasons = staleReasons();
  const panel = el('div', { class: `panel build-state${reasons.length ? ' stale' : ''}` });
  panel.appendChild(el('div', { class: 'row', style: { justifyContent: 'space-between' } },
    el('div', {},
      el('b', {}, reasons.length ? 'This build is out of date' : 'Build is current'),
      el('span', { class: 'muted' }, `  ·  ${fmtInt(ordered.length)} voices, built ${ago(builtAt)}`),
    ),
    reasons.length
      ? el('button', {
        class: 'btn primary',
        onclick: () => {
          runAllocation();
          runOrdering();
        },
      }, 'Rebuild')
      : el('span', { class: 'good' }, 'matches your ratings'),
  ));
  if (reasons.length) {
    panel.appendChild(el('p', { class: 'hint', style: { margin: '8px 0 0' } },
      'Since it was built: ', el('b', {}, reasons.join(', ')),
      '. The list below is the old one until you rebuild.'));
  }
  return panel;
}

function render(): void {
  clear(root);
  const store = ctx.store;
  const page = el('div', { class: 'stack' });

  const state = buildStatePanel();
  if (state) page.appendChild(state);

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
      el('h3', { style: { marginTop: 0 } }, `The ${fmtInt(ordered.length)}, in order`),
      el('p', { class: 'hint' },
        'Split at 32/64/96 with no regard for category boundaries — the point is that neighbouring slots sound adjacent ',
        'wherever you land while scrolling. Hover a slot to play it on the keyboard; click to hear the demo phrase and ',
        'keep it in the sidebar.'),
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

  // Same shape as rating: the work on the left, what you are pointing at on
  // the right.
  sideEl = el('aside', { class: 'detail-side' });
  root.appendChild(el('div', { class: 'detail-layout' }, page, sideEl));
  renderSide();
}

export const view: View = {
  mount(container, c) {
    ctx = c;
    root = container;
    midiPorts = listOutputs();
    midiOutputId = midiPorts[0]?.id ?? '';
    hovered = -1;
    selected = -1;
    restored = false;
    runAllocation();
    void restoreBuild();

    keyHandler = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
      if (e.key >= '1' && e.key <= '5' && (selected >= 0 || hovered >= 0)) {
        e.preventDefault();
        void rateTarget(Number(e.key));
      } else if (e.key === 'Escape' && selected >= 0) {
        selected = -1;
        armKeyboard();
        renderSide();
        highlight();
      }
    };
    window.addEventListener('keydown', keyHandler);
  },
  unmount() {
    if (keyHandler) window.removeEventListener('keydown', keyHandler);
    keyHandler = null;
    sideEl = null;
    ctx?.player.stop();
    keyboard.engine.allNotesOff();
  },
};
