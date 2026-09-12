/*
 * Round three: putting the top band in order.
 *
 * Five stars saturate. Rate a few thousand patches and the top band holds
 * several hundred - more than a bank can take, and completely unordered, since
 * the star says "I would keep this" and nothing at all about which of two
 * keepers you would rather have. Rating harder does not help: the scale has run
 * out of room at exactly the point where the decision gets difficult.
 *
 * So the band is ordered by comparison instead. Two patches, one question,
 * which is a much easier judgement than "is this a four or a five" and a much
 * more reliable one. Elo turns those answers into an order without ever
 * needing every pair - three hundred patches is forty-five thousand pairs, and
 * around eight comparisons each is enough to sort out the top of the band.
 *
 * This is not the face-off. That one compares near-duplicates inside a family,
 * where the whole difficulty is that they sound almost the same. This compares
 * patches that have nothing to do with each other except that you liked both,
 * which is the comparison that actually decides what goes in the bank.
 *
 * The result is a sub-rating: it moves a patch within its star and can never
 * push it out of one. The stars are your judgement about quality and this is
 * only your judgement about order - it should not be able to overrule the first
 * one, so a five that loses everything still outranks every four.
 */
import { clear, el, fmtInt, pageHead } from '../dom.ts';
import type { View, ViewContext } from '../app.ts';
import { AbPlayer } from '../../audio/player.ts';
import { DEMO_PHRASE, singleNotePhrase } from '../../engine/phrase.ts';
import { keyboard } from '../../audio/keyboard.ts';
import { voiceDetails } from '../voicePanel.ts';
import { sidebarSplitter } from '../splitter.ts';
import { categoryColour } from '../colour.ts';
import { getSetting, setSetting } from '../settings.ts';
import { usePhrase } from '../soundBar.ts';
import { isAdvanced } from '../advanced.ts';

let ctx: ViewContext;
let root: HTMLElement;
let sideEl: HTMLElement | null = null;
let ab: AbPlayer | null = null;
let keyHandler: ((e: KeyboardEvent) => void) | null = null;
let unsubKeyboard: (() => void) | null = null;

/** Which star band is being ordered. */
let band = getSetting('rank.band', 5);
let pair: [number, number] | null = null;
let loading = false;
let comparisons = 0;
/** Pairs already put to the user this session, so they are not asked twice. */
const asked = new Set<string>();

/** Comparisons per patch beyond which the order is about as good as it gets. */
const ENOUGH_GAMES = 8;

function pairKey(a: number, b: number): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

/**
 * Choose the next two to compare.
 *
 * Two rules, in order. Ask about the patch with the fewest comparisons, because
 * an unplaced patch is where the ordering is worst; then pick its opponent from
 * those with the closest score, because a comparison between two patches you
 * already rank far apart tells you nothing you did not know.
 *
 * The randomness among equals matters: without it the same few pairs come up
 * again and again, since the closest opponent stays the closest opponent until
 * one of them moves.
 */
function choosePair(): [number, number] | null {
  const store = ctx.store;
  const members = store.rankedBand(band);
  if (members.length < 2) return null;

  const games = (i: number) => store.rankOf(i).games;
  const fewest = Math.min(...members.map(games));
  const needy = members.filter((i) => games(i) === fewest);
  const a = needy[Math.floor(Math.random() * needy.length)];

  const scoreA = store.rankOf(a).score;
  const others = members
    .filter((i) => i !== a && !asked.has(pairKey(a, i)))
    .sort((x, y) => Math.abs(store.rankOf(x).score - scoreA) - Math.abs(store.rankOf(y).score - scoreA));
  if (others.length === 0) {
    // Everything close by has already been asked this session. Start over
    // rather than stopping: a second opinion on a pair is still evidence.
    asked.clear();
    const any = members.filter((i) => i !== a);
    if (any.length === 0) return null;
    return [a, any[Math.floor(Math.random() * any.length)]];
  }
  // Among the six nearest, at random, for the same reason as above.
  const near = others.slice(0, Math.min(6, others.length));
  return [a, near[Math.floor(Math.random() * near.length)]];
}

async function loadPair(): Promise<void> {
  const next = choosePair();
  pair = next;
  if (!next) {
    render();
    return;
  }
  asked.add(pairKey(next[0], next[1]));
  const store = ctx.store;
  loading = true;
  render();

  ab = new AbPlayer(ctx.player);
  await ab.load(
    store.voices[next[0]].id, store.voices[next[0]].unpacked,
    store.voices[next[1]].id, store.voices[next[1]].unpacked,
    usePhrase() ? DEMO_PHRASE : singleNotePhrase(60, 100, 1.4, 1.4),
  );
  keyboard.setPatch(store.voices[next[0]].unpacked);
  loading = false;
  render();
  if (ctx.player.mayPlay('click')) ab.start('a', 0);
}

function switchSides(): void {
  if (!ab || !pair) return;
  const side = ab.toggle();
  keyboard.setPatch(ctx.store.voices[side === 'a' ? pair[0] : pair[1]].unpacked);
  render();
}

async function choose(winner: 'a' | 'b' | 'skip'): Promise<void> {
  if (!pair) return;
  const [a, b] = pair;
  ab?.stop();
  if (winner === 'a') await ctx.store.recordWin(a, b);
  else if (winner === 'b') await ctx.store.recordWin(b, a);
  if (winner !== 'skip') comparisons++;
  await loadPair();
}

function sideCard(index: number, tag: string, live: boolean): HTMLElement {
  const store = ctx.store;
  const v = store.voices[index];
  const rank = store.rankOf(index);
  const cat = store.categoryOf(index);
  return el('div', {
    class: live ? 'side live' : 'side',
    onclick: () => {
      if (!ab) return;
      const want = tag.startsWith('A') ? 'a' : 'b';
      if (ab.currentSide !== want) switchSides();
    },
  },
    el('div', { class: 'tag' }, tag),
    el('div', { class: 'nm' }, v?.name || '(unnamed)'),
    el('div', { class: 'muted', style: { marginTop: '6px', fontSize: '11.5px' } },
      cat ? el('span', { class: 'dot', style: { background: categoryColour(cat) } }) : null,
      `${Math.round(rank.score)}  ·  ${rank.games} compared`),
  );
}

/** The band as it currently stands, best first. */
function standings(): HTMLElement {
  const store = ctx.store;
  const members = store.rankedBand(band);
  const box = el('div', {});
  box.appendChild(el('h3', { style: { marginTop: 0 } }, `The ${fmtInt(members.length)}, in order`));
  const list = el('ol', { class: 'rank-list' });
  for (const i of members.slice(0, 40)) {
    const rank = store.rankOf(i);
    const cat = store.categoryOf(i);
    list.appendChild(el('li', {
      class: pair && (i === pair[0] || i === pair[1]) ? 'on' : '',
      onclick: () => {
        if (!ab || !pair) return;
        if (i === pair[0] && ab.currentSide !== 'a') switchSides();
        if (i === pair[1] && ab.currentSide !== 'b') switchSides();
      },
    },
      cat ? el('span', { class: 'dot', style: { background: categoryColour(cat) } }) : null,
      el('span', { class: 'rank-nm' }, store.voices[i].name || '(unnamed)'),
      el('span', { class: 'muted rank-sc' }, rank.games ? String(Math.round(rank.score)) : '–'),
    ));
  }
  box.appendChild(list);
  if (members.length > 40) {
    box.appendChild(el('p', { class: 'muted', style: { fontSize: '11px', margin: '8px 0 0' } },
      `and ${fmtInt(members.length - 40)} more`));
  }
  return box;
}

function render(): void {
  clear(root);
  const store = ctx.store;
  const page = el('div', { class: 'stack page-narrow' });
  const members = store.rankedBand(band);
  const placed = members.filter((i) => store.rankOf(i).games >= ENOUGH_GAMES).length;

  page.appendChild(pageHead('Rank',
    `Order the ${'★'.repeat(band)} band by comparison, since the stars have run out of room.`));

  // How far along, in the only terms that matter: how much of the band has
  // been compared enough times for its position to mean anything.
  page.appendChild(el('div', { class: 'panel' },
    el('div', { class: 'row', style: { justifyContent: 'space-between' } },
      el('div', {},
        el('b', {}, fmtInt(placed)), ' of ', el('b', {}, fmtInt(members.length)), ' settled',
        el('span', { class: 'muted' }, `  ·  ${fmtInt(comparisons)} this session`)),
      el('div', { class: 'row' },
        el('label', { class: 'field' }, 'band',
          el('select', {
            onchange: (e: Event) => {
              band = Number((e.target as HTMLSelectElement).value);
              setSetting('rank.band', band);
              asked.clear();
              void loadPair();
            },
          }, ...([5, 4, 3, 2, 1] as const).map((r) => el('option', {
            value: r, selected: r === band,
          }, '★'.repeat(r))))),
        isAdvanced()
          ? el('button', {
            class: 'btn danger',
            onclick: async () => {
              if (!confirm('Forget every comparison? The stars themselves are kept.')) return;
              await store.resetRankings();
              asked.clear();
              comparisons = 0;
              await loadPair();
            },
          }, 'Reset order')
          : null,
      ),
    ),
    el('progress', { max: Math.max(1, members.length), value: placed, style: { width: '100%', marginTop: '10px' } }),
  ));

  if (members.length < 2) {
    page.appendChild(el('div', { class: 'panel' },
      el('div', { class: 'empty-state' },
        `Nothing to order: there are ${fmtInt(members.length)} patches at ${'★'.repeat(band)}. `,
        'Rate some more, or pick a different band.')));
  } else {
    const live = ab?.currentSide ?? 'a';
    page.appendChild(el('div', { class: 'panel' },
      loading || !pair
        ? el('div', { class: 'empty-state' }, 'rendering both…')
        : el('div', { class: 'ab' },
          sideCard(pair[0], 'A', live === 'a'),
          sideCard(pair[1], 'B', live === 'b')),
      el('div', { class: 'row', style: { justifyContent: 'center', marginTop: '16px' } },
        el('button', { class: 'btn', onclick: () => switchSides() }, 'Switch A/B'),
        el('button', { class: 'btn', onclick: () => ab?.restart() }, 'Replay'),
        el('button', { class: 'btn', onclick: () => void choose('a') }, 'A is better'),
        el('button', { class: 'btn', onclick: () => void choose('b') }, 'B is better'),
        el('button', { class: 'btn', onclick: () => void choose('skip') }, 'Too close'),
      ),
      el('div', { class: 'keyhelp' },
        el('span', {}, el('kbd', {}, 'space'), ' switch mid-note'),
        el('span', {}, el('kbd', {}, '1'), ' / ', el('kbd', {}, '2'), ' pick a winner'),
        el('span', {}, el('kbd', {}, 'r'), ' replay'),
        el('span', {}, el('kbd', {}, '3'), ' too close to call'),
      ),
    ));
    page.appendChild(el('div', { class: 'panel' }, standings()));
  }

  sideEl = el('aside', { class: 'detail-side' });
  const layout = el('div', { class: 'detail-layout' }, page, sideEl);
  layout.appendChild(sidebarSplitter(layout, { key: 'ui.detailSideWidth', defaultWidth: 300 }));
  root.appendChild(layout);
  renderSide();
}

function renderSide(): void {
  if (!sideEl) return;
  clear(sideEl);
  if (!pair) return;
  const index = (ab?.currentSide ?? 'a') === 'a' ? pair[0] : pair[1];
  sideEl.appendChild(voiceDetails(ctx.store, index, { onChange: () => render() }));
}

export const view: View = {
  mount(container, c) {
    ctx = c;
    root = container;
    comparisons = 0;
    asked.clear();
    pair = null;
    render();

    keyHandler = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
      const k = e.key.toLowerCase();
      // The three answers under the three fingers already resting on the
      // number row, in the order the two sides are drawn in. Rating uses
      // 1-5 elsewhere, but there is no rating to give here - only a choice
      // between two things and a way of declining it.
      if (e.key === '1') {
        e.preventDefault();
        void choose('a');
        return;
      }
      if (e.key === '2') {
        e.preventDefault();
        void choose('b');
        return;
      }
      if (e.key === '3') {
        e.preventDefault();
        void choose('skip');
        return;
      }
      if (k === 'x' || e.key === 'Tab') {
        e.preventDefault();
        switchSides();
      } else if (k === 'a') {
        e.preventDefault();
        void choose('a');
      } else if (k === 'b') {
        e.preventDefault();
        void choose('b');
      } else if (k === 's') {
        e.preventDefault();
        void choose('skip');
      } else if (e.key === ' ') {
        // Space is the switch, not the replay. Comparing two sounds means
        // going back and forth between them constantly and replaying one
        // hardly ever, so the biggest key on the keyboard should do the thing
        // you do most.
        e.preventDefault();
        switchSides();
      } else if (k === 'r') {
        e.preventDefault();
        ab?.restart();
      }
    };
    window.addEventListener('keydown', keyHandler);
    unsubKeyboard = keyboard.subscribe(() => renderSide());
    void ctx.player.unlock().then(() => void loadPair());
  },
  unmount() {
    if (keyHandler) window.removeEventListener('keydown', keyHandler);
    keyHandler = null;
    unsubKeyboard?.();
    unsubKeyboard = null;
    ab?.stop();
    ab = null;
    sideEl = null;
    ctx?.player.stop();
    keyboard.engine.allNotesOff();
  },
};
