/*
 * Build: allocate the 128, order them, write the four banks, and get them onto
 * the device.
 *
 * The allocation controls are all here rather than buried in a config file,
 * because the floors and ceilings are the main thing the user will want to
 * argue with after seeing the first result.
 */
import { clear, downloadBytes, el, fmtInt, pageHead, patchFile } from '../dom.ts';
import type { View, ViewContext } from '../app.ts';
import { CATEGORIES, CATEGORY_LABELS, type Category } from '../../cluster/category.ts';
import { allocate, DEFAULT_CEILINGS, DEFAULT_FLOORS, type Candidate, type AllocationResult } from '../../alloc/allocate.ts';
import { chooseEndpoints, seriate, withCategoryAxis } from '../../order/seriate.ts';
import { buildBanksPadded, verifyBank, BANK_NAMES } from '../../sysex/write.ts';
import { listOutputs, midiSupported, requestMidi, sendBanks, sendProgramChange, sendRaw, sendTestNote, type MidiPort } from '../../midi/webmidi.ts';
import { P } from '../../sysex/voice.ts';
import { FEATURE_COUNT } from '../../features/vector.ts';
import { DEMO_PHRASE } from '../../engine/phrase.ts';
import { kvGet, kvSet } from '../../db/store.ts';
import { getSetting, setSetting } from '../settings.ts';
import { keyboard } from '../../audio/keyboard.ts';
import { voiceDetails } from '../voicePanel.ts';
import { sidebarSplitter } from '../splitter.ts';
import { adv, disclosure, isAdvanced } from '../advanced.ts';

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
/** Optional ordering rules; see runOrdering. */
let pinnedFirst = getSetting('build.pinnedFirst', false);
let weakestLast = getSetting('build.weakestLast', false);
/**
 * One slot per family, filled by its best member. See `candidates`.
 *
 * Off by default because it overrides the face-off: choosing to keep two
 * members of a family is a decision the user made by hand, and this would
 * quietly discard it.
 */
let bestOfFamily = getSetting('build.bestOfFamily', false);

/** Voices per bulk dump, which is what "the last bank" means. */
const BANK_SIZE = 32;

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
/** Bank letter to when it was last sent, so a four-step manual job is trackable. */
const sentBanks = new Map<string, number>();

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
  pinnedFirst: boolean;
  weakestLast: boolean;
  /** Absent in builds stored before this rule existed. */
  bestOfFamily?: boolean;
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
    pinnedFirst?: boolean;
    weakestLast?: boolean;
    bestOfFamily?: boolean;
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
    pinnedFirst,
    weakestLast,
    bestOfFamily,
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
  if (now.pinned !== builtFrom.pinned) out.push('favourites changed');
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
  if (now.pinnedFirst !== builtFrom.pinnedFirst) out.push(now.pinnedFirst ? 'favourites now go first' : 'favourites no longer go first');
  if (now.weakestLast !== builtFrom.weakestLast) {
    out.push(now.weakestLast ? 'weakest now go in the last bank' : 'weakest no longer grouped');
  }
  // Defaulted on both sides: a build stored before this rule existed has no
  // opinion about it, and reporting that as a change would tell everyone with
  // an older build that something they never touched had been turned off.
  if ((now.bestOfFamily ?? false) !== (builtFrom.bestOfFamily ?? false)) {
    out.push(now.bestOfFamily ? 'now taking the best of each family' : 'no longer taking the best of each family');
  }
  return out;
}

async function saveBuild(): Promise<void> {
  builtAt = Date.now();
  builtFrom = currentInputs();
  const record: StoredBuild = {
    ordered,
    builtAt,
    inputs: builtFrom,
    settings: {
      total, minRating, backfill, categoryAxisWeight, pinnedFirst, weakestLast, bestOfFamily,
      floors: { ...floors }, ceilings: { ...ceilings },
    },
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
  pinnedFirst = record.settings.pinnedFirst ?? pinnedFirst;
  weakestLast = record.settings.weakestLast ?? weakestLast;
  bestOfFamily = record.settings.bestOfFamily ?? bestOfFamily;
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
      const members = store.clusters.clusters[id];
      const familySize = members.length;

      if (bestOfFamily) {
        /*
         * One per family, and the best one rather than the appointed one.
         *
         * The representative is chosen by position in feature space - it is
         * the most typical member, which is the right thing to *rate*, since
         * rating the typical one tells you most about the rest. It is not
         * necessarily the one you liked best: rate the representative three,
         * find a cousin on the map and give it five, and the bank would still
         * take the three, because that is the one the family nominated.
         *
         * This takes the family's best instead, and takes exactly one, which
         * is also the honest reading of "one slot per distinct sound".
         */
        let best = rep;
        let bestRating = store.effectiveRating(rep) ?? 0;
        for (const m of members) {
          const r = store.effectiveRating(m);
          if (r !== null && r > bestRating) {
            best = m;
            bestRating = r;
          }
        }
        push(best, bestRating, store.voices[best]?.pinned ?? false, familySize);
        continue;
      }

      // The refined rating, so an order settled in the ranking pass decides
      // which of two five-star patches gets the last slot. It never crosses a
      // star boundary, so every threshold downstream still means what it says.
      const rating = store.effectiveRating(rep) ?? 0;
      const chosen = store.faceoffExtras.get(id) ?? [rep];
      for (const index of chosen) push(index, rating, store.voices[index]?.pinned ?? false, familySize);
    }
  }
  for (let i = 0; i < store.voices.length; i++) {
    if (store.voices[i].pinned) push(i, store.effectiveRating(i) ?? 5, true, 1);
  }
  return out;
}

function runAllocation(opts: { keepOrder?: boolean; quiet?: boolean } = {}): void {
  allocation = allocate(candidates(), { total, minRating, floors, ceilings, backfill });
  if (!opts.keepOrder) {
    ordered = [];
    banks = [];
    verification = [];
    hovered = -1;
    selected = -1;
  }
  if (!opts.quiet) render();
}

/**
 * The whole build, from one button.
 *
 * Allocation and ordering were two buttons with a table of category floors and
 * ceilings between them, and the first one produced nothing you could hear or
 * send - you had to know that a second press was required. They are one action:
 * choose the 128, put them in an order, write the files.
 */
function buildAll(): void {
  runAllocation({ quiet: true });
  runOrdering();
}

/**
 * Order one group of voices so that neighbours sound adjacent.
 *
 * Two or fewer is already in order, and seriating a handful is not worth the
 * endpoint search.
 */
function orderGroup(ids: number[]): number[] {
  const store = ctx.store;
  const flat = store.distanceSpace;
  if (!flat || ids.length < 3) return ids;
  const vectors = ids.map((i) => Float32Array.from(flat.subarray(i * FEATURE_COUNT, (i + 1) * FEATURE_COUNT)));
  const cats = ids.map((i) => store.categoryOf(i)!).filter(Boolean) as Category[];
  const augmented = withCategoryAxis(vectors, cats, categoryAxisWeight);
  const ends = chooseEndpoints(augmented, cats);
  return seriate(augmented, ends).order.map((k) => ids[k]);
}

/**
 * Lay the selection out, in up to three runs.
 *
 * The default is one continuum across all four banks: neighbouring slots sound
 * adjacent wherever you land while scrolling, which is the whole argument for
 * seriating in the first place. The two optional rules break that deliberately,
 * and both are about what happens on the device rather than what sounds good:
 *
 *   pinned first    the patches you chose by hand sit at the top of bank A,
 *                   where they are two button presses away
 *   weakest last    everything that got in on backfill, or on the lowest
 *                   ratings, is concentrated in the final bank - which you can
 *                   then skip, or overwrite, without losing anything you meant
 *                   to keep
 *
 * Each run is seriated on its own, so the ordering still holds inside them.
 */
function runOrdering(): void {
  if (!allocation || !ctx.store.distanceSpace) return;
  const store = ctx.store;
  const all = allocation.selected.slice();

  const pinnedRun = pinnedFirst ? all.filter((c) => store.voices[c.id]?.pinned) : [];
  const taken = new Set(pinnedRun.map((c) => c.id));
  let rest = all.filter((c) => !taken.has(c.id));

  let weakRun: typeof all = [];
  if (weakestLast && rest.length > BANK_SIZE) {
    // Backfilled before merely low-rated, lowest rating first, and the
    // family-size tie-break the allocator used kept as the last word.
    const ranked = rest.slice().sort((a, b) => {
      if (a.backfilled !== b.backfilled) return a.backfilled ? -1 : 1;
      if (a.rating !== b.rating) return a.rating - b.rating;
      return (a.tieBreak ?? 0) - (b.tieBreak ?? 0);
    });
    // Only things that are actually worse than the best of the selection, and
    // at most a bank of them. Padding the last bank out to thirty-two with
    // five-star patches would defeat the point: the bank is meant to be the one
    // you can overwrite without losing anything you wanted.
    const best = rest.reduce((top, c) => Math.max(top, c.rating), 0);
    weakRun = ranked.filter((c) => c.backfilled || c.rating < best).slice(0, BANK_SIZE);
    const weak = new Set(weakRun.map((c) => c.id));
    rest = rest.filter((c) => !weak.has(c.id));
  }

  ordered = [
    ...orderGroup(pinnedRun.map((c) => c.id)),
    ...orderGroup(rest.map((c) => c.id)),
    ...orderGroup(weakRun.map((c) => c.id)),
  ];
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
          if (ctx.player.mayPlay('click')) void ctx.player.audition(v.id, v.unpacked, DEMO_PHRASE);
          renderSide();
          highlight();
        },
      },
        el('span', {
          class: 'slot-cat',
          style: { background: cat ? CATEGORY_COLOURS[cat] : '#555' },
        }),
        el('span', { class: 'slot-name' }, v.name || '(unnamed)'),
        // The same mark the table uses. With "pinned first" on, the run at the
        // top of bank A is there because it was pinned rather than because it
        // rated highest, and nothing on this screen said so - which makes the
        // ordering look broken exactly when it is doing what you asked.
        v.pinned ? el('span', { class: 'slot-pin', title: 'favourite' }, ' ●') : null,
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
    autoPlay: ctx.player.autoPlay,
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
    // Behind the switch: it proves the cable, which is worth doing once and is
    // not part of sending a bank.
    adv(el('button', {
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
    }, 'Test note')),
  ));

  /*
   * Every output listed, not one of them behind a pulldown.
   *
   * Which port the synth is on is the decision this whole panel turns on, and
   * getting it wrong means pressing Send and hearing nothing - with no error,
   * because the message went somewhere. A closed select shows one name and
   * hides the fact that there are four others, so it has to be opened before
   * you can even find out whether the choice was made for you correctly. There
   * are rarely more than a handful, so they all fit.
   */
  if (midiPorts.length) {
    const ports = el('div', { class: 'port-list' });
    for (const port of midiPorts) {
      const name = `${port.name} ${port.manufacturer}`.trim();
      ports.appendChild(el('label', { class: port.id === midiOutputId ? 'port on' : 'port' },
        el('input', {
          type: 'radio', name: 'midi-out', value: port.id, checked: port.id === midiOutputId,
          onchange: () => {
            midiOutputId = port.id;
            render();
          },
        }),
        el('span', {}, name)));
    }
    panel.appendChild(ports);
  }

  // One bank at a time, because the receiving end decides where a dump lands:
  // the unit has to be put into receive for the right bank between sends, and
  // that is a manual step on its front panel. Sending all four back to back
  // only works if it advances by itself, which is not something to assume - so
  // the per-bank buttons are the main path and "all four" is the shortcut.
  panel.appendChild(el('h3', {}, 'Send'));
  const row = el('div', { class: 'row' });
  for (let b = 0; b < banks.length; b++) {
    const label = bankNames[b] ?? BANK_NAMES[b] ?? String(b + 1);
    const filled = Math.min(32, Math.max(0, ordered.length - b * 32));
    const sent = sentBanks.get(label);
    row.appendChild(el('button', {
      class: sent ? 'btn on' : 'btn',
      disabled: !midiOutputId,
      title: `${filled} voices, ${fmtInt(banks[b].length)} bytes${sent ? `. Sent ${ago(sent)}.` : ''}`,
      onclick: () => {
        try {
          sendRaw(midiOutputId, banks[b]);
          sentBanks.set(label, Date.now());
          midiMessage = `sent bank ${label} — ${filled} voices, ${fmtInt(banks[b].length)} bytes. Arm the unit for the next bank before sending it.`;
        } catch (err) {
          midiMessage = (err as Error).message;
        }
        render();
      },
    }, `Bank ${label}`, sent ? el('span', { class: 'muted' }, ' ✓') : null));
  }
  const allFour = adv(el('button', {
    class: buildIsCurrent() ? 'btn primary' : 'btn',
    disabled: !midiOutputId || banks.length === 0,
    title: 'Only useful if the unit advances to the next bank by itself.',
    onclick: async () => {
      try {
        await sendBanks(midiOutputId, banks, bankNames.map((n) => `bank ${n}`), {
          onProgress: (sentCount, all, label) => {
            midiMessage = sentCount >= all ? 'all banks sent' : `sending ${label} (${sentCount + 1} of ${all})`;
            if (sentCount < all) sentBanks.set(bankNames[sentCount] ?? String(sentCount + 1), Date.now());
            render();
          },
        });
      } catch (err) {
        midiMessage = (err as Error).message;
        render();
      }
    },
  }, `All ${banks.length} back to back`));
  // Behind the switch, because it only works on a unit that advances its own
  // receive slot - and the comment above this loop is the reason to doubt that
  // yours does.
  if (allFour) row.appendChild(allFour);
  panel.appendChild(row);
  panel.appendChild(el('p', { class: 'hint', style: { marginTop: '8px', marginBottom: 0 } },
    'A tick marks a bank sent in this session. It says nothing about where the unit put it - there is no slot address ',
    'in a bulk dump, so that is between you and its front panel.'));

  const farEnd = el('div', {},
    el('h3', {}, 'Check the far end'),
    el('p', { class: 'hint' },
      'Accounts differ on whether all four groups are reachable from the FM-1 front panel. Load an unmistakable patch into ',
      'the last slot of bank D, then try to reach it two ways: by scrolling, and with program change 127.'),
    el('div', { class: 'row' },
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
  // Behind the switch: it answers a question about one device, once, and the
  // answer is not needed again.
  const fold = adv(farEnd);
  if (fold) panel.appendChild(fold);

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
    /*
     * The rebuild button, where the reason to press it is.
     *
     * It was the loud button at the top of the panel below, which meant the
     * page said "out of date" in one box and offered the cure in the next one
     * down, under a heading about something else. Nothing else on this screen
     * is a reason to build again - a build that matches your ratings has
     * nothing to recompute - so this sentence and this button are one control.
     */
    reasons.length
      ? el('button', { class: 'btn primary', onclick: () => buildAll() }, 'Build again')
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
  const page = el('div', { class: 'stack page-narrow' });
  page.appendChild(pageHead('Build'));

  const state = buildStatePanel();
  if (state) page.appendChild(state);

  page.appendChild(heroPanel());

  if (ordered.length) {
    page.appendChild(el('div', { class: 'panel' },
      el('h3', { style: { marginTop: 0 } }, `The ${fmtInt(ordered.length)}, in order`),
      el('p', { class: 'hint' },
        'Neighbouring slots sound adjacent. Hover to play from the keyboard, click to hear the demo phrase.'),
      banksPanel(),
    ));
    page.appendChild(filesPanel());
    page.appendChild(midiPanel());
  }

  if (!store.clusters) {
    page.appendChild(el('p', { class: 'warn' },
      'Near-duplicate grouping has not run, so every voice counts as its own family.'));
  }

  // Same shape as rating: the work on the left, what you are pointing at on
  // the right.
  sideEl = el('aside', { class: 'detail-side' });
  const layout = el('div', { class: 'detail-layout' }, page, sideEl);
  layout.appendChild(sidebarSplitter(layout, { key: 'ui.detailSideWidth', defaultWidth: 380 }));
  root.appendChild(layout);
  renderSide();
}

/**
 * Whether the four banks on screen match the corpus as it stands.
 *
 * Decides which button on the page is the loud one: while there is building to
 * do, that is Build; once the banks are current, the thing you came here to do
 * is send them.
 */
function buildIsCurrent(): boolean {
  return ordered.length > 0 && staleReasons().length === 0;
}

/**
 * One button, and what it is about to do.
 *
 * Everything that used to be asked before it - how many slots, the minimum
 * rating, whether to backfill, how hard to march through the categories, and a
 * nine-row table of per-category floors and ceilings - has a default that is
 * right nearly always, and is now a sentence you can read rather than six
 * controls you have to answer.
 */
function heroPanel(): HTMLElement {
  const store = ctx.store;
  const ready = candidates().length;
  const panel = el('div', { class: 'panel' });

  /*
   * One line of numbers, in one voice.
   *
   * This was a button, a sentence of counts, two orange paragraphs of advice
   * and a fourth line listing the settings - four typographic registers on a
   * panel whose whole content is "here is what the build will contain". The
   * counts are counts, so they are set as counts: a row of figures with their
   * labels under them, in one colour, with the ones that mean something is
   * wrong picked out. The advice is gone; the numbers say the same thing and
   * anybody reading them knows what to do about it.
   */
  const figure = (value: string, label: string, tone = '') =>
    el('div', { class: 'build-fig' },
      el('div', { class: `v ${tone}` }, value),
      el('div', { class: 'k' }, label));

  panel.appendChild(el('div', { class: 'build-hero' },
    // Only while there is nothing built. Once there is, the one reason to
    // build again is that it has gone out of date, and the card that says so
    // carries the button.
    ordered.length === 0
      ? el('button', {
        class: 'btn primary big',
        disabled: ready === 0,
        onclick: () => buildAll(),
      }, `Build ${total}`)
      : null,
    el('div', { class: 'build-figs' },
      figure(fmtInt(ready), 'to choose from'),
      allocation ? figure(fmtInt(allocation.onMerit), `rated ${minRating}+`) : null,
      allocation && allocation.backfilled > 0
        ? figure(fmtInt(allocation.backfilled), 'backfilled', 'warn') : null,
      allocation && allocation.unfilled > 0
        ? figure(fmtInt(allocation.unfilled), 'empty', 'bad') : null,
    ),
  ));

  if (ready === 0) {
    panel.appendChild(el('p', { class: 'hint', style: { margin: '10px 0 0' } },
      `Nothing is rated ${minRating} or better yet. Rate some patches first.`));
  }

  // A plain-language account of the settings, so hiding them is not the same
  // as hiding what they did.
  const rules: string[] = [`${total} slots`, `rated ${minRating}+`];
  if (backfill) rules.push('gaps filled with the next best');
  if (pinnedFirst) rules.push('favourites first');
  if (bestOfFamily) rules.push('best of each family');
  if (weakestLast) rules.push('weakest in the last bank');
  for (const w of allocation?.warnings ?? []) rules.push(w.replace(/\.$/, ''));
  panel.appendChild(el('p', { class: 'hint', style: { margin: '12px 0 0' } }, rules.join('  \u00b7  ')));

  if (isAdvanced()) {
    panel.appendChild(disclosure('Selection rules', settingsControls, { key: 'buildRules' }));
    panel.appendChild(disclosure('Category floors and ceilings', limitsPanel, { key: 'buildLimits' }));
    if (allocation) panel.appendChild(disclosure('Where the 128 came from', allocationStats, { key: 'buildStats' }));
  }
  void store;
  return panel;
}

/** The knobs, for when the sentence above is not what you wanted. */
function settingsControls(): HTMLElement {
  return el('div', { class: 'row' },
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
    el('label', { class: 'field', title: 'Fill leftover slots with lower-rated patches rather than leaving them empty.' },
      el('input', {
        type: 'checkbox', checked: backfill,
        onchange: (e: Event) => { backfill = (e.target as HTMLInputElement).checked; },
      }), 'backfill gaps'),
    el('label', {
      class: 'field',
      title: 'Put your favourites at the top of bank A, ordered among themselves.',
    },
      el('input', {
        type: 'checkbox', checked: pinnedFirst,
        onchange: (e: Event) => {
          pinnedFirst = (e.target as HTMLInputElement).checked;
          setSetting('build.pinnedFirst', pinnedFirst);
        },
      }), 'favourites first'),
    el('label', {
      class: 'field',
      title: 'One slot per family, taken by whichever member you rated highest - rather than by the family’s representative, which is the most typical member and not necessarily the best. Overrides face-off keepers.',
    },
      el('input', {
        type: 'checkbox', checked: bestOfFamily,
        onchange: (e: Event) => {
          bestOfFamily = (e.target as HTMLInputElement).checked;
          setSetting('build.bestOfFamily', bestOfFamily);
        },
      }), 'best of each family'),
    el('label', {
      class: 'field',
      title: 'Gather the backfilled and lowest-rated patches at the end - up to a bank of them - so the last bank can be skipped or overwritten. Never demotes a top-rated patch to fill the quota.',
    },
      el('input', {
        type: 'checkbox', checked: weakestLast,
        onchange: (e: Event) => {
          weakestLast = (e.target as HTMLInputElement).checked;
          setSetting('build.weakestLast', weakestLast);
        },
      }), 'weakest in the last bank'),
    el('label', {
      class: 'field',
      title: '0 follows the sound alone; higher marches through the categories in order.',
    }, 'category ordering strength',
      el('input', {
        type: 'number', min: 0, max: 40, step: 1, value: categoryAxisWeight,
        onchange: (e: Event) => { categoryAxisWeight = Number((e.target as HTMLInputElement).value); },
      })),
  );
}

function allocationStats(): HTMLElement {
  const a = allocation;
  if (!a) return el('div', {});
  const stat = (k: string, v: string) => el('div', { class: 'stat' },
    el('div', { class: 'k' }, k), el('div', { class: 'v' }, v));
  return el('div', { class: 'stats' },
    stat('selected', fmtInt(a.selected.length)),
    stat(`on merit (${minRating}+)`, fmtInt(a.onMerit)),
    stat('backfilled', fmtInt(a.backfilled)),
    stat('empty slots', fmtInt(a.unfilled)),
    stat('favourites', fmtInt(a.selected.filter((c) => c.pinned).length)),
    stat('candidates', fmtInt(candidates().length)),
  );
}

/** The four files, and whether they came out valid. */
function filesPanel(): HTMLElement {
  const panel = el('div', { class: 'panel' });
  const bad = verification.some((line) => line.includes('FAILED') || line.includes('could not'));

  if (banks.length === 4) {
    panel.appendChild(el('div', { class: 'row' },
      el('button', {
        class: 'btn',
        onclick: () => {
          const all = new Uint8Array(banks.reduce((n, b) => n + b.length, 0));
          let at = 0;
          for (const b of banks) {
            all.set(b, at);
            at += b.length;
          }
          downloadBytes(all, patchFile('DX7 banks A-D'));
        },
      }, 'Download all four banks'),
      ...banks.map((bytes, b) => el('button', {
        class: 'btn',
        style: { padding: '6px 10px' },
        onclick: () => downloadBytes(bytes, patchFile(`DX7 bank ${bankNames[b]}`)),
      }, bankNames[b])),
      // Only when something is wrong. "All four verify" is the app reporting
      // that it can do arithmetic, in the same weight as the buttons beside
      // it; a bank that did not verify is worth every bit of that attention.
      bad ? el('span', { class: 'bad' }, 'a bank did not verify') : null,
    ));
  }

  const detail = adv(el('div', {},
    ...verification.map((line) => el('div', {
      class: line.includes('FAILED') || line.includes('could not') ? 'bad mono' : 'good mono',
      style: { fontSize: '11.5px' },
    }, line)),
  ));
  if (detail) panel.appendChild(el('div', { style: { marginTop: '10px' } }, detail));
  return panel;
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
    runAllocation({ quiet: true });
    // Restore what was built last; if there was nothing, build it now rather
    // than showing an empty page with a button on it.
    void restoreBuild().then(() => {
      if (!restored && candidates().length > 0) buildAll();
      else render();
    });

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
