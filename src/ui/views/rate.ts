/*
 * Round one: one representative per near-duplicate family, rated fast.
 *
 * Keyboard only. 1-5 rates and advances, space replays, arrows move without
 * rating, P pins. Every rating is written to IndexedDB the moment the key goes
 * down, so closing the tab mid-session loses nothing.
 *
 * The default order is farthest-point rather than density order: each next
 * patch is the one furthest from everything already rated, in the same space
 * the map is drawn in. Working through the corpus in file order would mean
 * rating four hundred electric pianos before hearing a single bell, and the
 * ratings would end up describing the archive's biases rather than yours.
 */
import { clear, el, fmtInt } from '../dom.ts';
import type { View, ViewContext } from '../app.ts';
import { CATEGORY_LABELS, type Category } from '../../cluster/category.ts';
import { P } from '../../sysex/voice.ts';
import { DEMO_PHRASE, HOVER_PHRASE, singleNotePhrase } from '../../engine/phrase.ts';
import { keyboard } from '../../audio/keyboard.ts';
import { voiceDetails } from '../voicePanel.ts';
import { sidebarSplitter } from '../splitter.ts';
import { getSetting, setSetting } from '../settings.ts';
import { runTask } from '../task.ts';
import { loadBlock, type LoadBlock } from '../loading.ts';
import { adv, disclosure } from '../advanced.ts';
import { topTerms } from '../../cluster/taste.ts';
import { categoryColour } from '../colour.ts';
import { FEATURE_DEFS } from '../../features/vector.ts';
import { loopPhrase, usePhrase } from '../soundBar.ts';
import { sourcePanel, useSourceContext } from '../sourcePanel.ts';

type Ordering = 'coverage' | 'predicted' | 'families' | 'given';

let ctx: ViewContext;
let root: HTMLElement;
let queue: number[] = [];
let position = 0;
let keyHandler: ((e: KeyboardEvent) => void) | null = null;
let unsubKeyboard: (() => void) | null = null;
/**
 * Where families you have already judged go, rather than whether you see them.
 *
 * This used to skip them: the queue jumped over anything whose family had a
 * rating, so the arrow keys walked backwards into patches the forward key
 * would not stop on, and "review from the start" had to switch the setting off
 * to work at all. Putting them last does the same job - you work through
 * everything untouched before you meet anything you have decided on - without
 * making a third of the corpus unreachable in the direction you are travelling.
 */
let ratedLast = getSetting('rate.ratedLast', getSetting('rate.skipRated', true));
let ordering: Ordering = getSetting<Ordering>('rate.ordering', 'coverage');
let auditionNote = getSetting('audition.note', 60);
let auditionVel = getSetting('audition.velocity', 100);

/**
 * Work out what to rate, and in what order.
 *
 * Slow enough on a large corpus to need saying so: coverage ordering walks the
 * whole set picking the point furthest from everything chosen so far, and
 * ordering by prediction fills the model's cache for every representative on
 * the first comparison. Both used to happen inside `mount`, synchronously,
 * which meant the Rate tab simply did not appear for several seconds with no
 * indication that anything was happening.
 */
/** True while the queue is being worked out, so the screen can say so. */
let building = false;

async function buildQueue(): Promise<void> {
  const store = ctx.store;
  building = true;
  const fromLasso = sessionStorage.getItem('rateQueue');
  let base: number[];
  if (fromLasso) {
    sessionStorage.removeItem('rateQueue');
    try {
      base = (JSON.parse(fromLasso) as number[]).filter((i) => store.voices[i]);
      ordering = 'given'; setSetting('rate.ordering', ordering);
    } catch {
      base = store.representatives.slice();
    }
  } else {
    base = store.representatives.slice();
  }

  await runTask('preparing the rating queue', async (task) => {
    /*
     * Let the page draw between slices.
     *
     * A `setTimeout(0)` before the work is not enough and was the bug: the bar
     * gets set, one frame paints, and then the thread is gone for the whole of
     * a quadratic loop. Yielding has to happen *inside* the work, which is why
     * the store's long passes take a callback and await it.
     */
    const slice = async (done: number, total: number) => {
      task.set(total ? done / total : null, `${fmtInt(done)} of ${fmtInt(total)}`);
      await new Promise((r) => setTimeout(r, 0));
    };

    if (ordering === 'coverage') {
      queue = await store.coverageOrder(base, slice);
    } else if (ordering === 'predicted') {
      // Straight down the model's guesses. Coverage is the right default
      // because it spreads the ratings over the whole corpus, but once the
      // model has something to say, hearing its best guesses first is both the
      // fastest way to fill a bank and the fastest way to find out it is wrong.
      //
      // The predictions are filled first, in slices; the sort afterwards is
      // then reading a cache and takes no time worth reporting.
      task.stage('predicting');
      await store.fillPredictions(base, slice);
      queue = base.slice().sort((a, b) => (store.predictedRating(b) ?? -Infinity) - (store.predictedRating(a) ?? -Infinity));
    } else if (ordering === 'families') {
      queue = base.slice().sort((a, b) => store.clusterMembers(b).length - store.clusterMembers(a).length);
    } else {
      queue = base;
    }

    /*
     * Families nobody has touched come first.
     *
     * A stable partition, so whichever order was chosen still holds inside
     * each half - coverage still spreads, the model's guesses are still in
     * order. It only decides which half you work through first, and an
     * untouched family is worth more than another look at one you have already
     * formed a view on.
     *
     * Not a filter: the rest stay in the queue, behind.
     */
    if (ratedLast) {
      const fresh: number[] = [];
      const known: number[] = [];
      for (const i of queue) (store.familyHasRating(i) ? known : fresh).push(i);
      queue = fresh.concat(known);
    }

    position = 0;
  });
  building = false;
}

function phrase() {
  return usePhrase() ? DEMO_PHRASE : singleNotePhrase(auditionNote, auditionVel);
}

/** @param auto set when advancing did this rather than the user asking. */
async function play(auto?: 'click' | 'hover'): Promise<void> {
  const i = queue[position];
  if (i === undefined) return;
  const v = ctx.store.voices[i];
  keyboard.setPatch(v.unpacked);
  if (keyboard.playing) return;
  if (auto && !ctx.player.mayPlay(auto)) return;
  await ctx.player.audition(v.id, v.unpacked, phrase(), { loop: loopPhrase() });
}

/**
 * What the last rating was, so it can be taken back.
 *
 * Rating is meant to be fast - a key press and gone - and the cost of that is
 * that a slip is gone too, several patches back, with no way to find it again
 * except by scrolling the queue and remembering. One step is enough: mistakes
 * are noticed immediately or not at all.
 */
let lastRating: { index: number; previous: number | null } | null = null;

/**
 * Long enough to see the stars land, short enough not to slow you down.
 *
 * Rating advanced the instant the key went down, so the card you had just
 * judged was replaced in the same frame and the stars you filled in were never
 * drawn. With a few hundred patches to get through that is not a cosmetic
 * problem: with no acknowledgement at all, the only way to know a keystroke
 * registered is that the patch changed, and a keystroke that misses looks
 * exactly like one that landed.
 */
const ADVANCE_DELAY_MS = 240;
let advanceTimer: number | null = null;

function cancelAdvance(): void {
  if (advanceTimer === null) return;
  window.clearTimeout(advanceTimer);
  advanceTimer = null;
}

async function rate(value: number): Promise<void> {
  const i = queue[position];
  if (i === undefined) return;
  lastRating = { index: i, previous: ctx.store.ratingOf(i) };
  await ctx.store.rate(i, value, 'round1');
  // Draw the rating on the card that earned it, then move on.
  render();
  // Changing your mind inside the delay re-rates this patch rather than
  // rating this one and then the next.
  cancelAdvance();
  advanceTimer = window.setTimeout(() => {
    advanceTimer = null;
    next();
  }, ADVANCE_DELAY_MS);
}

/** Put the last rating back the way it was, and return to that patch. */
async function undoRating(): Promise<void> {
  const last = lastRating;
  if (!last) return;
  // Undoing during the pause keeps you on the patch you just rated.
  cancelAdvance();
  lastRating = null;
  if (last.previous === null) await ctx.store.clearRating(last.index);
  else await ctx.store.rate(last.index, last.previous, 'round1');
  const at = queue.indexOf(last.index);
  if (at >= 0) position = at;
  render();
  void play('click');
}

function next(): void {
  cancelAdvance();
  position = Math.min(queue.length, position + 1);
  render();
  void play('click');
}

function prev(): void {
  cancelAdvance();
  position = Math.max(0, position - 1);
  render();
  void play('click');
}

function stat(k: string, v: string): HTMLElement {
  return el('div', { class: 'stat' }, el('div', { class: 'k' }, k), el('div', { class: 'v' }, v));
}

/**
 * What the ratings have in common, on the screen where they are made.
 *
 * This lived on the import page, which is the one screen it has nothing to do
 * with: it is a report on your judgement, and the moment you want it is the
 * moment you have just given twenty more ratings and want to know whether the
 * model has worked anything out yet.
 */
function tastePanel(): HTMLElement {
  const store = ctx.store;
  const panel = el('div', {});
  const model = store.tasteModel;
  if (!model) {
    return el('p', { class: 'muted' }, `Needs at least 12 ratings; you have ${fmtInt(store.ratings.size)}.`);
  }

  const quality = model.r2 > 0.25 ? 'good' : model.r2 > 0.08 ? 'warn' : 'muted';
  const verdict = model.r2 > 0.25
    ? 'it has found real structure in your taste'
    : model.r2 > 0.08
      ? 'weak but not nothing'
      : 'no better than guessing the average — rate more';

  panel.appendChild(el('div', { class: 'stats', style: { marginBottom: '10px' } },
    stat('ratings used', fmtInt(model.samples)),
    el('div', { class: 'stat' },
      el('div', { class: 'k' }, 'cross-validated R²'),
      el('div', { class: `v ${quality}` }, model.r2.toFixed(2))),
    stat('mean rating', model.meanRating.toFixed(2)),
  ));
  panel.appendChild(el('p', { class: quality, style: { marginTop: 0 } }, verdict));

  // Where the predictive power actually comes from. Three numbers rather than
  // one, because "the line explains nothing but the neighbours explain a lot"
  // is a completely different situation from "nothing works yet".
  const share = (label: string, value: number, note: string) => el('tr', {},
    el('td', {}, label),
    el('td', { class: `num ${value > 0.15 ? 'good' : value > 0.05 ? 'warn' : 'muted'}` }, value.toFixed(2)),
    el('td', { class: 'muted', style: { fontSize: '11.5px' } }, note),
  );
  panel.appendChild(el('table', { class: 'data', style: { maxWidth: '560px', marginBottom: '14px' } },
    el('tbody', {},
      share('the line alone', model.linearR2, 'ridge regression on the features'),
      share('plus category offsets', model.categoryR2, 'whole families running above or below the line'),
      share('the neighbours alone', model.neighbourR2, `average of the ${model.neighbours?.k ?? 8} nearest rated patches`),
      share('as used', model.r2,
        model.neighbourWeight === 0
          ? 'neighbours did not help, so they are switched off'
          : `${Math.round(model.neighbourWeight * 100)}% neighbours, ${Math.round((1 - model.neighbourWeight) * 100)}% line and offsets`),
    ),
  ));

  if (model.categories.length) {
    const cats = el('div', { class: 'taste-cats' });
    for (const c of model.categories.slice(0, 6)) {
      const strong = Math.abs(c.offset) > 0.15;
      cats.appendChild(el('div', { class: 'taste-cat' },
        el('i', { style: { background: categoryColour(c.category) } }),
        el('b', {}, CATEGORY_LABELS[c.category as Category] ?? c.category),
        el('span', { class: c.offset >= 0 ? 'good' : 'bad' },
          `${c.offset >= 0 ? '+' : ''}${c.offset.toFixed(2)}`),
        el('span', { class: 'muted' }, `${c.count} rated, mean ${c.mean.toFixed(1)}`),
        strong ? null : el('span', { class: 'muted' }, '(barely)'),
      ));
    }
    panel.appendChild(el('h3', {}, 'Categories you like more than their features explain'));
    panel.appendChild(cats);
  }

  const { up, down } = topTerms(model, 6);
  const list = (title: string, terms: Array<{ index: number; coefficient: number }>, cls: string) => {
    const box = el('div', { style: { flex: '1', minWidth: '240px' } }, el('h3', {}, title));
    const body = el('tbody');
    for (const t of terms) {
      body.appendChild(el('tr', {},
        el('td', {}, FEATURE_DEFS[t.index]?.label ?? String(t.index)),
        el('td', { class: `num ${cls}` }, t.coefficient.toFixed(3)),
      ));
    }
    box.appendChild(el('table', { class: 'data' }, body));
    return box;
  };
  panel.appendChild(el('div', { class: 'row', style: { alignItems: 'flex-start', gap: '26px' } },
    list('pushes a rating up', up, 'good'),
    list('pushes a rating down', down, 'bad'),
  ));

  panel.appendChild(el('div', { class: 'row', style: { marginTop: '14px' } },
    el('button', {
      class: 'btn',
      onclick: async () => {
        await ctx.store.retrain();
        render();
      },
    }, 'Refit from current ratings'),
    el('label', { class: 'field' }, 'apply to distances',
      el('input', {
        type: 'range', min: 0, max: 100, value: Math.round(store.tasteStrength * 100),
        style: { width: '120px' },
        onchange: (e: Event) => {
          ctx.store.setTasteStrength(Number((e.target as HTMLInputElement).value) / 100);
          render();
        },
      })),
    el('span', { class: 'muted' }, `${Math.round(store.tasteStrength * 100)}%`),
  ));

  return panel;
}

/**
 * The real progress, in the middle of the screen it belongs to.
 *
 * Working out a coverage order over thirty thousand families takes long enough
 * to need reporting, and it already reports - through the same task stack
 * everything slow in this app reports through. What was on screen instead was
 * a static sentence in a panel, under a header and an empty progress bar,
 * while the actual numbers moved along a thin strip in the title bar.
 */
let loading: LoadBlock | null = null;

function queueLoading(): HTMLElement {
  loading?.stop();
  loading = loadBlock({ label: 'Preparing' });
  return el('div', { class: 'centre-load' }, loading.node);
}

function endQueueLoading(): void {
  loading?.stop();
  loading = null;
}

function render(): void {
  clear(root);
  const store = ctx.store;
  const wrap = el('div', { class: 'rate-wrap stack' });

  const rated = queue.filter((i) => store.ratingOf(i) !== null).length;
  wrap.appendChild(el('div', { class: 'row', style: { justifyContent: 'space-between' } },
    el('div', {}, el('b', {}, fmtInt(rated)), ' of ', el('b', {}, fmtInt(queue.length)), ' rated'),
    el('div', { class: 'row' },
      // Even coverage is the right order for anyone who has not yet formed an
      // opinion about the orders, which is everyone until they have rated a
      // few hundred. The other three are here under the switch.
      adv(el('label', { class: 'field' }, 'order',
        el('select', {
          onchange: (e: Event) => {
            ordering = (e.target as HTMLSelectElement).value as Ordering; setSetting('rate.ordering', ordering);
            void buildQueue().then(() => {
              render();
              void play('click');
            });
          },
        },
          el('option', { value: 'coverage', selected: ordering === 'coverage' }, 'even coverage'),
          el('option', {
            value: 'predicted',
            selected: ordering === 'predicted',
            disabled: !store.tasteModel,
          }, store.tasteModel ? 'highest predicted rating' : 'highest predicted (needs a model)'),
          el('option', { value: 'families', selected: ordering === 'families' }, 'biggest families first'),
          el('option', { value: 'given', selected: ordering === 'given' }, 'as listed'),
        ))),
      adv(el('label', { class: 'field' },
        el('input', {
          type: 'checkbox', checked: ratedLast,
          onchange: (e: Event) => {
            ratedLast = (e.target as HTMLInputElement).checked;
            setSetting('rate.ratedLast', ratedLast);
            void buildQueue().then(() => {
              render();
              void play('click');
            });
          },
        }), 'rated families last')),
    ),
  ));
  wrap.appendChild(el('progress', { max: Math.max(1, queue.length), value: rated, style: { width: '100%' } }));


  if (building) {
    // Nothing else on the screen while it builds: the counts are zero, the
    // progress bar is at zero and the order pulldown changes something that
    // does not exist yet, so all three were furniture around one sentence.
    clear(root);
    root.appendChild(queueLoading());
    return;
  }

  if (position >= queue.length) {
    wrap.appendChild(el('div', { class: 'panel', style: { textAlign: 'center', padding: '40px' } },
      el('h2', {}, 'Round one is done'),
      el('p', { class: 'hint', style: { margin: '8px auto 18px' } },
        'Families whose representative scored 4 or 5 can now be opened up in the face-off. Everything rated 3 or below ',
        'dies with its whole family, which is where the saving comes from.'),
      el('div', { class: 'row', style: { justifyContent: 'center' } },
        el('button', { class: 'btn primary', onclick: () => ctx.go('faceoff') }, 'Go to the face-off'),
        el('button', {
          class: 'btn',
          onclick: () => {
            position = 0;
            render();
            void play();
          },
        }, 'Review from the start'),
      ),
    ));
    root.appendChild(wrap);
    return;
  }

  const i = queue[position];
  const v = store.voices[i];
  /*
   * Whatever is on screen is what the keyboard plays.
   *
   * Arming used to happen only inside `play`, which returns early while you
   * are holding notes - the audition would be in the way - and also returns
   * early when the queue is empty. Between those two, arriving on this screen
   * mid-phrase left the keyboard pointed at the patch from the screen before,
   * so the first thing you played was the wrong sound. Doing it here ties the
   * armed patch to the drawn one, whatever route brought you to it.
   */
  keyboard.setPatch(v?.unpacked ?? null);
  const a = store.analysis[i];
  const cat = store.categoryOf(i) as Category | null;
  const family = store.clusterMembers(i);
  const merged = store.mergedMembers(i);
  const current = store.ratingOf(i);

  /*
   * The name, and the question.
   *
   * Everything else that was here - the category, the algorithm, the feedback,
   * the family counts, the file paths, four measurements - is in the sidebar
   * three inches to the right, laid out properly, on every one of these
   * screens. Printed again as four lines of centred grey run-on text it was
   * not a second chance to read it, it was four lines between the patch name
   * and the only control on the page.
   */
  const card = el('div', { class: 'rate-card' },
    el('div', { class: 'rate-name' }, v.name || '(unnamed)'),
  );
  void a; void cat; void merged; void family;

  // The same stars as the sidebar, at the size this screen deserves: one
  // control in one notation, wherever a rating is given. Five numbered buttons
  // here and five stars three inches to the right was two notations for one
  // thing, and the digits are still how it is actually done - which is what
  // the legend underneath says.
  const stars = el('div', { class: 'stars big' });
  for (let r = 1; r <= 5; r++) {
    stars.appendChild(el('button', {
      class: `star${current !== null && r <= current ? ' on' : ''}`,
      title: current === r ? 'Rated ' + r + '. Press again to clear.' : 'Rate ' + r,
      onclick: () => void rate(r),
    }, '\u2605'));
  }
  // Directly under the name: the patch, then the judgement, and nothing
  // between them.
  card.appendChild(el('div', { class: 'rate-stars' }, stars,
    el('button', {
      class: 'btn',
      disabled: !lastRating,
      title: lastRating ? 'Put the last rating back and return to that patch' : 'Nothing to undo yet',
      onclick: () => void undoRating(),
    }, '\u21b6 Undo')));

  card.appendChild(el('div', { class: 'keyhelp' },
    el('span', {}, el('kbd', {}, '1'), '–', el('kbd', {}, '5'), ' rate and advance'),
    el('span', {}, el('kbd', {}, 'space'), loopPhrase() ? ' play, stop' : ' replay'),
    el('span', {}, el('kbd', {}, '←'), ' ', el('kbd', {}, '→'), ' move without rating'),
    el('span', {}, el('kbd', {}, '6'), ' favourite'),
    el('span', {}, el('kbd', {}, 'u'), ' undo'),
    // No connect button. It is on the sound strip, on every screen, next to
    // everything else audible - and offering it again here put a control for
    // hardware most people do not own beside the five keys that are the whole
    // job.
    keyboard.connected ? el('span', { class: 'good' }, 'MIDI keyboard plays this patch') : null,
  ));

  wrap.appendChild(card);

  // Below the patch, and closed until asked for: something to check between
  // stretches of rating, not to read past on the way to every one of them.
  if (store.tasteModel || store.ratings.size > 0) {
    wrap.appendChild(el('div', { class: 'panel' },
      disclosure('What your ratings have in common', tastePanel, {
        key: 'taste',
        note: store.tasteModel ? `R² ${store.tasteModel.r2.toFixed(2)}` : 'not enough yet',
      })));
    // The other report on the same ratings, directly under it: what they have
    // in common, and then where they came from.
    wrap.appendChild(el('div', { class: 'panel' },
      disclosure('Where the good ones come from', sourcePanel, {
        key: 'sourceScores',
        note: `${fmtInt(store.ratings.size)} rated`,
      })));
  }

  // The same detail panel the map puts in its sidebar. Rating is the moment the
  // information matters most - the algorithm, what the classifier decided, how
  // many near-copies are riding on this one score - and until now it was the
  // one view that did not show it.
  const layout = el('div', { class: 'detail-layout' },
    wrap,
    el('aside', { class: 'detail-side' }, voiceDetails(store, i, {
      onPlay: () => void play(),
      autoPlay: ctx.player.autoPlay,
      onHover: (n) => {
        // Back to the patch being rated, sound included: it is the one the
        // screen is about, and you were only visiting the family.
        if (n < 0) {
          const back = store.voices[queue[position]];
          keyboard.setPatch(back?.unpacked ?? null);
          if (back && ctx.player.mayPlay('hover')) void play('hover');
          return;
        }
        const other = store.voices[n];
        if (!other) return;
        // Sounds and arms the keyboard even though a patch is up for rating:
        // comparing this one against its family is exactly what the list is
        // for, so it has to override what is on screen.
        keyboard.setPatch(other.unpacked);
        if (ctx.player.mayPlay('hover')) void ctx.player.audition(other.id, other.unpacked, HOVER_PHRASE);
      },
      onOpen: (n) => {
        const at = queue.indexOf(n);
        if (at < 0) return;
        position = at;
        render();
        void play();
      },
      onChange: () => render(),
    })),
  );
  layout.appendChild(sidebarSplitter(layout, { key: 'ui.detailSideWidth', defaultWidth: 380 }));
  root.appendChild(layout);
}

export const view: View = {
  mount(container, c) {
    ctx = c;
    useSourceContext(c);
    root = container;
    // Rendered empty first, so the screen exists while the queue is built -
    // then played once it exists. Unlocking and building used to race, and
    // whichever finished last decided whether the first patch ever sounded.
    render();
    void buildQueue().then(async () => {
      endQueueLoading();
      render();
      await ctx.player.unlock();
      void play('click');
    });

    keyHandler = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
      if (e.key >= '1' && e.key <= '5') {
        e.preventDefault();
        void rate(Number(e.key));
      } else if (e.key === ' ') {
        e.preventDefault();
        /*
         * Play and stop, while there is something to stop.
         *
         * With the phrase looping, "replay" meant the only way to get silence
         * was to mute the app or to leave the screen: the bar restarted from
         * the top and went round again. Without looping the phrase ends by
         * itself, nothing is running by the time you reach for the key, and
         * replay is exactly what it should do.
         */
        if (loopPhrase() && ctx.player.playingKey !== '') ctx.player.stop();
        else void play();
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        cancelAdvance();
        position = Math.min(queue.length, position + 1);
        render();
        void play('click');
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        prev();
      } else if (e.key.toLowerCase() === 'u') {
        e.preventDefault();
        void undoRating();
      } else if (e.key === '6' || e.code === 'Digit6' || e.key.toLowerCase() === 'p') {
        e.preventDefault();
        const i = queue[position];
        if (i !== undefined) {
          void ctx.store.togglePin(i);
          render();
        }
      }
    };
    window.addEventListener('keydown', keyHandler);
    unsubKeyboard = keyboard.subscribe(() => render());
  },
  unmount() {
    endQueueLoading();
    cancelAdvance();
    if (keyHandler) window.removeEventListener('keydown', keyHandler);
    keyHandler = null;
    unsubKeyboard?.();
    unsubKeyboard = null;
    ctx?.player.stop();
    keyboard.engine.allNotesOff();
  },
};
