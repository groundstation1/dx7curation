/*
 * Round two: face-offs inside the near-duplicate families that survived.
 *
 * Only clusters whose representative scored 4 or 5 get here. Everything rated 3
 * or below died with its whole family in round one, which is where the saving
 * comes from.
 *
 * A and B are rendered up front and the toggle swaps them at the current
 * playback position, so the switch is mid-note. That is the only way the
 * release tails - which is where near-duplicates actually differ - can be
 * compared at all.
 *
 * There is no forced deduplication. Keeping two similar patches you love is a
 * supported outcome, and "keep both" is a first-class key.
 */
import { clear, el, fmtInt } from '../dom.ts';
import type { View, ViewContext } from '../app.ts';
import { AbPlayer } from '../../audio/player.ts';
import { P } from '../../sysex/voice.ts';
import { DEMO_PHRASE, singleNotePhrase } from '../../engine/phrase.ts';
import { keyboard } from '../../audio/keyboard.ts';
import { voiceDetails } from '../voicePanel.ts';
import { getSetting, setSetting } from '../settings.ts';

interface Bout {
  clusterId: number;
  members: number[];
}

let ctx: ViewContext;
let root: HTMLElement;
let bouts: Bout[] = [];
let boutIndex = 0;
let champion = -1;
let challengerIndex = 1;
let extras: number[] = [];
let ab: AbPlayer | null = null;
let keyHandler: ((e: KeyboardEvent) => void) | null = null;
let usePhrase = getSetting('audition.phrase', true);
let auditionNote = getSetting('audition.note', 60);
let auditionVel = getSetting('audition.velocity', 100);
let loading = false;
let unsubKeyboard: (() => void) | null = null;

const MIN_RATING = 4;

function buildBouts(): void {
  const store = ctx.store;
  bouts = [];
  if (!store.clusters) return;
  for (let id = 0; id < store.clusters.clusters.length; id++) {
    const rep = store.representatives[id];
    if (rep === undefined) continue;
    // Contenders, not raw members: anything below the merge threshold is
    // already treated as the same patch, and asking the user to pick between
    // two recordings of the same sound is a waste of their ears.
    const members = store.familyContenders(rep);
    if (members.length < 2) continue;
    const rating = store.ratingOf(rep);
    if (rating === null || rating < MIN_RATING) continue;
    bouts.push({ clusterId: id, members });
  }
  // Unfinished bouts first, largest families first inside that.
  bouts.sort((a, b) => {
    const doneA = store.faceoffExtras.has(a.clusterId) ? 1 : 0;
    const doneB = store.faceoffExtras.has(b.clusterId) ? 1 : 0;
    if (doneA !== doneB) return doneA - doneB;
    return b.members.length - a.members.length;
  });
  boutIndex = 0;
  startBout();
}

function startBout(): void {
  const bout = bouts[boutIndex];
  if (!bout) return;
  champion = ctx.store.representatives[bout.clusterId];
  if (!bout.members.includes(champion)) champion = bout.members[0];
  challengerIndex = 0;
  extras = [];
  nextChallenger();
}

function challenger(): number {
  const bout = bouts[boutIndex];
  if (!bout) return -1;
  return bout.members[challengerIndex] ?? -1;
}

function nextChallenger(): void {
  const bout = bouts[boutIndex];
  if (!bout) return;
  while (challengerIndex < bout.members.length &&
    (bout.members[challengerIndex] === champion || extras.includes(bout.members[challengerIndex]))) {
    challengerIndex++;
  }
}

async function loadPair(): Promise<void> {
  const b = challenger();
  if (champion < 0 || b < 0) return;
  const store = ctx.store;
  loading = true;
  render();
  ab = new AbPlayer(ctx.player);
  await ab.load(
    store.voices[champion].id, store.voices[champion].unpacked,
    store.voices[b].id, store.voices[b].unpacked,
    usePhrase ? DEMO_PHRASE : singleNotePhrase(auditionNote, auditionVel, 1.4, 1.4),
  );
  keyboard.setPatch(store.voices[champion].unpacked);
  loading = false;
  render();
  if (ctx.player.autoPlay) ab.start('a', 0);
}

async function finishBout(): Promise<void> {
  const bout = bouts[boutIndex];
  if (bout) await ctx.store.setFaceoffExtras(bout.clusterId, [champion, ...extras]);
  ab?.stop();
  boutIndex++;
  if (boutIndex < bouts.length) {
    startBout();
    if (challenger() >= 0) {
      await loadPair();
      return;
    }
    // Cluster had nothing left to compare; record and move on.
    await finishBout();
    return;
  }
  render();
}

async function choose(winner: 'a' | 'b' | 'both' | 'skip'): Promise<void> {
  const bout = bouts[boutIndex];
  if (!bout) return;
  const b = challenger();
  if (winner === 'skip') {
    await finishBout();
    return;
  }
  if (winner === 'b' && b >= 0) champion = b;
  else if (winner === 'both' && b >= 0) extras.push(b);
  challengerIndex++;
  nextChallenger();
  if (challenger() < 0) {
    await finishBout();
  } else {
    await loadPair();
  }
}

/** Toggle A/B and point the MIDI keyboard at whichever side is now sounding. */
function switchSides(): void {
  if (!ab) return;
  const side = ab.toggle();
  const bout = bouts[boutIndex];
  if (bout) {
    const index = side === 'a' ? champion : challenger();
    const v = ctx.store.voices[index];
    if (v) keyboard.setPatch(v.unpacked);
  }
  render();
}

function sideCard(index: number, tag: string, live: boolean): HTMLElement {
  const v = ctx.store.voices[index];
  const card = el('div', { class: `side${live ? ' live' : ''}` },
    el('div', { class: 'tag' }, tag, live ? ' — sounding' : ''),
    el('div', { class: 'nm' }, v?.name || '(unnamed)'),
    el('div', { class: 'muted', style: { marginTop: '6px', fontSize: '11.5px' } },
      v ? `algorithm ${(v.unpacked[P.algorithm] & 31) + 1} · feedback ${v.unpacked[P.feedback] & 7}` : ''),
    el('div', { class: 'muted mono', style: { marginTop: '4px', fontSize: '11px' } },
      v ? v.sources.slice(0, 2).map((s) => s.file).join(', ') : ''),
  );
  // The map's detail panel, minus the parts that would only repeat what the
  // face-off already is: both sides are the same family, so their duplicate
  // counts and family lists are the same list twice. What earns its space is
  // the algorithm, side by side, and the measured character underneath it.
  if (v) {
    card.appendChild(voiceDetails(ctx.store, index, {
      heading: false,
      duplicates: false,
      related: false,
      sources: false,
      onChange: () => render(),
    }));
  }
  return card;
}

function render(): void {
  clear(root);
  const store = ctx.store;
  const wrap = el('div', { class: 'rate-wrap stack' });

  const done = bouts.filter((b) => store.faceoffExtras.has(b.clusterId)).length;
  wrap.appendChild(el('div', { class: 'row', style: { justifyContent: 'space-between' } },
    el('div', {}, el('b', {}, fmtInt(done)), ' of ', el('b', {}, fmtInt(bouts.length)), ' families settled'),
    el('div', { class: 'row' },
      el('label', { class: 'field' },
        el('input', {
          type: 'checkbox', checked: usePhrase,
          onchange: (e: Event) => { usePhrase = (e.target as HTMLInputElement).checked; setSetting('audition.phrase', usePhrase); void loadPair(); },
        }), 'demo phrase'),
      el('label', { class: 'field' }, 'note',
        el('input', {
          type: 'number', min: 24, max: 96, value: auditionNote, disabled: usePhrase,
          onchange: (e: Event) => { auditionNote = Number((e.target as HTMLInputElement).value); setSetting('audition.note', auditionNote); void loadPair(); },
        })),
    ),
  ));

  if (bouts.length === 0) {
    wrap.appendChild(el('div', { class: 'panel', style: { textAlign: 'center', padding: '40px' } },
      el('h2', {}, 'Nothing to compare'),
      el('p', { class: 'hint', style: { margin: '8px auto 0' } },
        `No near-duplicate family has a representative rated ${MIN_RATING} or better yet. `,
        'Rate some more in round one, or lower the near-duplicate threshold so more families form.'),
    ));
    root.appendChild(wrap);
    return;
  }

  if (boutIndex >= bouts.length) {
    wrap.appendChild(el('div', { class: 'panel', style: { textAlign: 'center', padding: '40px' } },
      el('h2', {}, 'Every family is settled'),
      el('p', { class: 'hint', style: { margin: '8px auto 18px' } },
        'Each surviving family has a winner, plus any extras you chose to keep.'),
      el('button', { class: 'btn primary', onclick: () => ctx.go('build') }, 'Build the banks'),
    ));
    root.appendChild(wrap);
    return;
  }

  const bout = bouts[boutIndex];
  const b = challenger();
  const live = ab?.currentSide ?? 'a';

  wrap.appendChild(el('div', { class: 'panel' },
    el('div', { class: 'row', style: { justifyContent: 'space-between' } },
      el('div', {}, el('b', {}, `family of ${bout.members.length}`),
        el('span', { class: 'muted' }, `  ·  challenger ${challengerIndex + 1} of ${bout.members.length}`)),
      el('div', { class: 'muted' }, extras.length ? `${extras.length} extra kept` : 'no extras yet'),
    ),
    loading
      ? el('div', { class: 'empty-state' }, 'rendering both sides…')
      : el('div', { class: 'ab' },
        sideCard(champion, 'A — current keeper', live === 'a'),
        sideCard(b, 'B — challenger', live === 'b'),
      ),
    el('div', { class: 'row', style: { justifyContent: 'center', marginTop: '16px' } },
      el('button', { class: 'btn', onclick: () => { switchSides(); } }, 'Switch A/B'),
      el('button', { class: 'btn', onclick: () => ab?.restart() }, 'Replay'),
      el('button', { class: 'btn primary', onclick: () => void choose('a') }, 'Keep A'),
      el('button', { class: 'btn primary', onclick: () => void choose('b') }, 'Keep B'),
      el('button', { class: 'btn', onclick: () => void choose('both') }, 'Keep both'),
      el('button', { class: 'btn', onclick: () => void choose('skip') }, 'Skip family'),
    ),
    el('div', { class: 'keyhelp' },
      el('span', {}, el('kbd', {}, 'x'), ' switch mid-note'),
      el('span', {}, el('kbd', {}, 'a'), ' / ', el('kbd', {}, 'b'), ' pick a keeper'),
      el('span', {}, el('kbd', {}, 'k'), ' keep both'),
      el('span', {}, el('kbd', {}, 'space'), ' replay'),
      el('span', {}, el('kbd', {}, 's'), ' skip this family'),
    ),
  ));

  root.appendChild(wrap);
}

export const view: View = {
  mount(container, c) {
    ctx = c;
    root = container;
    buildBouts();
    render();
    keyHandler = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return;
      const k = e.key.toLowerCase();
      if (k === 'x' || e.key === 'Tab') {
        e.preventDefault();
        switchSides();
      } else if (k === 'a') {
        e.preventDefault();
        void choose('a');
      } else if (k === 'b') {
        e.preventDefault();
        void choose('b');
      } else if (k === 'k') {
        e.preventDefault();
        void choose('both');
      } else if (k === 's') {
        e.preventDefault();
        void choose('skip');
      } else if (e.key === ' ') {
        e.preventDefault();
        ab?.restart();
      }
    };
    window.addEventListener('keydown', keyHandler);
    unsubKeyboard = keyboard.subscribe(() => render());
    void ctx.player.unlock().then(() => {
      if (bouts.length && boutIndex < bouts.length) void loadPair();
    });
  },
  unmount() {
    if (keyHandler) window.removeEventListener('keydown', keyHandler);
    keyHandler = null;
    unsubKeyboard?.();
    unsubKeyboard = null;
    ab?.stop();
    ab = null;
    keyboard.engine.allNotesOff();
  },
};
