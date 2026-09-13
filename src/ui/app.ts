/* Application shell: tab chrome, view mounting, the progress bar and the counts. */
import { append, clear, el, fmtDuration, fmtInt } from './dom.ts';
import { store } from './state.ts';
import { Player } from '../audio/player.ts';
import { getSetting } from './settings.ts';
import { mountPianoRoll } from './pianoRoll.ts';
import { mountSoundBar } from './soundBar.ts';
import { advancedSwitch, isAdvanced, subscribeAdvanced } from './advanced.ts';
import { activeTask, subscribeTasks } from './task.ts';
import type { AutoPlay } from '../audio/player.ts';
import { keyboard } from '../audio/keyboard.ts';

export interface ViewContext {
  store: typeof store;
  player: Player;
  go: (id: ViewId) => void;
}

export interface View {
  mount(container: HTMLElement, ctx: ViewContext): void;
  unmount?(): void;
  /** Set when the view manages its own scrolling and wants no padding. */
  flush?: boolean;
}

export type ViewId = 'corpus' | 'map' | 'rate' | 'rank' | 'faceoff' | 'build' | 'about';

interface TabSpec {
  id: ViewId;
  label: string;
  load: () => Promise<View>;
  enabled: () => boolean;
  hint: string;
  /** Tabs that are only worth the room when you have asked for everything. */
  advancedOnly?: boolean;
  /** Reachable by name, but never drawn in the row. */
  hidden?: boolean;
}

/**
 * The credits, reachable but not in the tab row.
 *
 * Kept in the same table so that `go` has one way to find a view, and marked
 * hidden so `renderTabs` leaves it out.
 */
const TABS: TabSpec[] = [
  {
    id: 'about',
    label: 'About',
    load: async () => (await import('./views/about.ts')).view,
    enabled: () => true,
    hint: '',
    hidden: true,
  },
  {
    id: 'corpus',
    label: 'Sources',
    load: async () => (await import('./views/corpus.ts')).view,
    enabled: () => true,
    hint: '',
  },
  {
    id: 'map',
    label: 'Browse',
    load: async () => (await import('./views/map.ts')).view,
    enabled: () => store.projection !== null,
    hint: 'import some patches first',
  },
  {
    id: 'rate',
    label: 'Rate',
    load: async () => (await import('./views/rate.ts')).view,
    enabled: () => store.clusters !== null,
    hint: 'import some patches first',
  },
  {
    /*
     * Ordering the top band, which is a different job from rating it.
     *
     * Enabled once there are two patches sharing the highest rating anyone has
     * given - which is the moment the star scale stops separating them, and
     * therefore the moment this becomes worth doing.
     */
    id: 'rank',
    label: 'Rank',
    load: async () => (await import('./views/rank.ts')).view,
    enabled: () => store.rankableCount() >= 2,
    hint: 'rate a few patches the same to have something to order',
  },
  {
    // Behind the advanced switch: at the merge threshold the app picks, the
    // members of a family are close enough that hearing them side by side is
    // rarely decisive. It earns its place once you have widened the family
    // threshold by hand, which is an advanced move in the first place.
    id: 'faceoff',
    label: 'Face-off',
    load: async () => (await import('./views/faceoff.ts')).view,
    enabled: () => store.clusters !== null && store.ratings.size > 0,
    hint: 'rate some representatives first',
    advancedOnly: true,
  },
  {
    id: 'build',
    label: 'Build',
    load: async () => (await import('./views/build.ts')).view,
    enabled: () => store.ratings.size > 0 || store.voices.some((v) => v.pinned),
    hint: 'rate some voices first',
  },
];

export class App {
  private root: HTMLElement;
  private main: HTMLElement;
  private tabsEl: HTMLElement;
  private statusEl: HTMLElement;
  private taskEl: HTMLElement;
  private current: View | null = null;
  private currentId: ViewId = 'corpus';
  private player = new Player();

  constructor(root: HTMLElement) {
    this.root = root;
    this.tabsEl = el('nav', { class: 'tabs' });
    this.statusEl = el('div', { class: 'status' });
    this.taskEl = el('div', { class: 'taskbar', hidden: true });
    this.main = el('main', { class: 'view' });

    const header = el(
      'header',
      { class: 'topbar' },
      // The name is one flex item, not three: a flex container puts its gap
      // between every child, bare text nodes included, so spelling the name out
      // at this level made the word space the same size as the gap after the
      // mark.
      /*
       * The wordmark goes home, which here means the first screen.
       *
       * That screen holds the two ways in - your own files, or a prepared
       * collection - and it used to exist only while the library was empty, so
       * having imported anything there was no route back to it. A logo that
       * returns you to the start is the convention every other app has trained
       * people on, and it costs no room in a bar that has none.
       */
      el('button', {
        class: 'brand',
        title: 'Back to the start',
        onclick: async () => {
          const corpus = await import('./views/corpus.ts');
          corpus.openSplash();
          await this.go('corpus');
        },
      }, el('span', { class: 'brand-name' }, 'DX7', el('span', { class: 'brand-sp' }), 'curator')),
      this.tabsEl,
      el('div', { class: 'spacer' }),
      this.taskEl,
      this.statusEl,
      /*
       * A link rather than a tab.
       *
       * The tab row is the sequence of the work - sources, browse, rate, rank,
       * build - and reads as one because nothing else is in it. Credits are
       * not a step in that, and putting them there would cost the row its
       * meaning to save one click on a page most people open once.
       */
      el('button', {
        class: 'about-link',
        title: 'What this is built on',
        onclick: () => void this.go('about'),
      }, 'about'),
      advancedSwitch(),
    );
    clear(this.root);
    this.root.append(header, this.main);

    store.subscribe(() => {
      this.renderTabs();
      this.renderStatus();
    });
    subscribeTasks(() => this.renderTask());
    // A view builds a different screen depending on the switch, so the only
    // honest way to apply it is to build the screen again.
    subscribeAdvanced(() => {
      this.renderTabs();
      void this.go(this.currentId);
    });
  }

  async start(): Promise<void> {
    // Preferences the user set last time, applied before anything renders so
    // no control ever shows a default it is not actually using.
    this.player.setVolume(getSetting('audio.volume', this.player.getVolume()));
    this.player.setMuted(getSetting('audio.muted', false));
    this.player.autoPlay = getSetting<AutoPlay>('audio.autoPlay', 'hover');
    keyboard.setModDeadzone(getSetting('midi.modDeadzone', keyboard.modDeadzone));
    keyboard.setBendRange(getSetting('midi.bendRange', keyboard.bendRange));

    this.renderTabs();
    this.renderStatus();
    mountSoundBar(this.player);

    await store.load();
    // Land on the map when there is something to look at. Sources is the right
    // first screen exactly once, when the corpus is empty.
    const startAt: ViewId = TABS.find((t) => t.id === 'map')!.enabled() ? 'map' : 'corpus';
    await this.go(startAt);

    mountPianoRoll();

    // If MIDI was granted on a previous visit, be ready without being asked.
    void keyboard.autoConnect(this.player);

    // The AudioContext cannot start until the page has been interacted with, so
    // take the first click wherever it lands.
    const unlock = () => {
      void this.player.unlock();
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
  }

  private renderTabs(): void {
    clear(this.tabsEl);
    for (const tab of TABS) {
      if (tab.hidden) continue;
      if (tab.advancedOnly && !isAdvanced()) continue;
      const enabled = tab.enabled();
      this.tabsEl.appendChild(
        el('button', {
          class: tab.id === this.currentId ? 'active' : '',
          disabled: !enabled,
          title: enabled ? '' : tab.hint,
          onclick: () => void this.go(tab.id),
        }, tab.label),
      );
    }
  }

  private renderStatus(): void {
    clear(this.statusEl);
    const parts: Node[] = [];
    const push = (label: string, value: string) => {
      if (parts.length) parts.push(document.createTextNode('  ·  '));
      parts.push(el('span', {}, el('b', {}, value), ' ', label));
    };
    if (store.voices.length) push('voices', fmtInt(store.voices.length));
    if (store.voices.length && !store.analysisComplete) push('analysed', fmtInt(store.analysedCount));
    if (store.ratings.size) push('rated', fmtInt(store.ratings.size));
    for (const p of parts) this.statusEl.appendChild(p);
  }

  /**
   * The one progress bar.
   *
   * Everything slow reports through `task.ts`, so this is the only place in the
   * app that draws a bar - and anything that forgets to report is visibly
   * missing rather than quietly silent.
   */
  private renderTask(): void {
    const task = activeTask();
    this.taskEl.hidden = !task;
    clear(this.taskEl);
    if (!task) return;

    const elapsed = performance.now() - task.startedAt;
    // Under a fiftieth there is not enough of a sample for an ETA that will not
    // immediately be contradicted.
    const eta = task.fraction !== null && task.fraction > 0.02
      ? (elapsed / task.fraction) * (1 - task.fraction)
      : NaN;

    append(this.taskEl, [
      el('span', { class: 'task-label' }, task.label),
      task.fraction === null
        ? el('span', { class: 'task-bar indeterminate' }, el('i'))
        : el('span', { class: 'task-bar' }, el('i', { style: { width: `${(task.fraction * 100).toFixed(1)}%` } })),
      el('span', { class: 'task-detail muted' },
        task.fraction === null ? task.detail : `${Math.round(task.fraction * 100)}%`,
        task.detail && task.fraction !== null ? `  ·  ${task.detail}` : '',
        Number.isFinite(eta) ? `  ·  ${fmtDuration(eta)} left` : ''),
      task.cancel
        ? el('button', { class: 'task-stop', title: 'Stop', onclick: () => task.cancel?.() }, '×')
        : null,
    ]);
  }

  /**
   * Show a view, and make sure exactly one is ever mounted.
   *
   * The await in the middle is a dynamic import, and two calls either side of
   * it interleave: the second reads `this.current` before the first has set
   * it, so the first mounts a view that nobody ever unmounts. Its key handler
   * stays on the window for the rest of the session, which is how pressing 1
   * on the Browse tab redrew the whole screen as the ranking page while the
   * tab bar went on claiming you were still browsing.
   *
   * A generation counter settles it: whoever started last owns the screen, and
   * an older transition that comes back from its import finds it has been
   * overtaken and stops before mounting anything.
   */
  private generation = 0;

  async go(id: ViewId): Promise<void> {
    let tab = TABS.find((t) => t.id === id) ?? TABS[0];
    /*
     * A disabled destination falls back to Sources rather than refusing.
     *
     * Refusing is right for a click on a greyed-out tab, which cannot happen
     * anyway - the button is disabled. It is wrong for everything else that
     * calls this, and the case that bites is deleting the corpus while some
     * other screen is open: every tab but Sources switches off, the call to
     * move goes nowhere, and you are left looking at a view of a library that
     * no longer exists with no indication of what happened.
     */
    if (!tab.enabled()) tab = TABS.find((t) => t.id === 'corpus') ?? tab;
    if (!tab.enabled()) return;
    const mine = ++this.generation;

    this.current?.unmount?.();
    // Cleared before the await, so an overlapping call cannot unmount it twice.
    this.current = null;
    this.currentId = tab.id;
    this.renderTabs();
    clear(this.main);

    const view = await tab.load();
    if (mine !== this.generation) return;

    clear(this.main);
    this.main.className = view.flush ? 'view flush' : 'view';
    this.current = view;
    view.mount(this.main, { store, player: this.player, go: (next) => void this.go(next) });
  }
}
