/* Application shell: tab chrome, view mounting, and the shared status line. */
import { clear, el, fmtInt } from './dom.ts';
import { store } from './state.ts';
import { Player } from '../audio/player.ts';
import { keyboard } from '../audio/keyboard.ts';
import { midiSupported } from '../midi/webmidi.ts';

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

export type ViewId = 'corpus' | 'map' | 'rate' | 'faceoff' | 'build';

interface TabSpec {
  id: ViewId;
  label: string;
  load: () => Promise<View>;
  enabled: () => boolean;
  hint: string;
}

const TABS: TabSpec[] = [
  {
    id: 'corpus',
    label: 'Corpus',
    load: async () => (await import('./views/corpus.ts')).view,
    enabled: () => true,
    hint: '',
  },
  {
    id: 'map',
    label: 'Map',
    load: async () => (await import('./views/map.ts')).view,
    enabled: () => store.projection !== null,
    hint: 'run the analysis pass first',
  },
  {
    id: 'rate',
    label: 'Rate',
    load: async () => (await import('./views/rate.ts')).view,
    enabled: () => store.clusters !== null,
    hint: 'find near-duplicates first',
  },
  {
    id: 'faceoff',
    label: 'Face-off',
    load: async () => (await import('./views/faceoff.ts')).view,
    enabled: () => store.clusters !== null && store.ratings.size > 0,
    hint: 'rate some representatives first',
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
  private transportEl: HTMLElement;
  private current: View | null = null;
  private currentId: ViewId = 'corpus';
  private player = new Player();

  constructor(root: HTMLElement) {
    this.root = root;
    this.tabsEl = el('nav', { class: 'tabs' });
    this.statusEl = el('div', { class: 'status' });
    this.transportEl = el('div', { class: 'transport' });
    this.main = el('main', { class: 'view' });

    const header = el(
      'header',
      { class: 'topbar' },
      el('div', { class: 'brand' }, 'DX7 curation', el('small', {}, '128 voices, four banks')),
      this.tabsEl,
      el('div', { class: 'spacer' }),
      this.statusEl,
      this.transportEl,
    );
    clear(this.root);
    this.root.append(header, this.main);

    store.subscribe(() => {
      this.renderTabs();
      this.renderStatus();
    });
    keyboard.subscribe(() => this.renderTransport());
  }

  async start(): Promise<void> {
    this.renderTabs();
    this.renderStatus();
    this.renderTransport();
    await store.load();
    // Land on the map when there is something to look at. Corpus is the right
    // first screen exactly once, when the corpus is empty.
    const startAt: ViewId = TABS.find((t) => t.id === 'map')!.enabled() ? 'map' : 'corpus';
    await this.go(startAt);

    // If MIDI was granted on a previous visit, be ready without being asked.
    void keyboard.autoConnect(this.player).then((ok) => {
      if (ok) this.renderTransport();
    });

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
    if (store.busy) {
      this.statusEl.appendChild(el('span', {}, store.busy, '…'));
      return;
    }
    const parts: Node[] = [];
    const push = (label: string, value: string) => {
      if (parts.length) parts.push(document.createTextNode('  ·  '));
      parts.push(el('span', {}, el('b', {}, value), ' ', label));
    };
    push('voices', fmtInt(store.voices.length));
    if (store.voices.length && !store.analysisComplete) {
      push('analysed', fmtInt(store.analysedCount));
    }
    if (store.clusters) push('clusters', fmtInt(store.clusters.clusterCount));
    if (store.ratings.size) push('rated', fmtInt(store.ratings.size));
    for (const p of parts) this.statusEl.appendChild(p);
  }

  /**
   * Volume and the MIDI keyboard live in the top bar rather than inside a view:
   * the keyboard plays whatever is under the cursor on the map, whatever is up
   * for rating, and whichever side of a face-off is sounding, so its controls
   * have to be reachable from all three.
   */
  private renderTransport(): void {
    clear(this.transportEl);
    this.transportEl.appendChild(el('label', { class: 'field', title: 'output volume' },
      el('input', {
        type: 'range', min: 0, max: 100, value: Math.round(this.player.getVolume() * 100),
        style: { width: '90px' },
        oninput: (e: Event) => this.player.setVolume(Number((e.target as HTMLInputElement).value) / 100),
      })));

    if (!midiSupported()) return;

    this.transportEl.appendChild(el('button', {
      class: keyboard.connected ? 'btn' : 'btn',
      style: { padding: '4px 10px' },
      onclick: async () => {
        if (keyboard.connected) keyboard.disconnect();
        else await keyboard.connect(this.player);
        this.renderTransport();
      },
    }, keyboard.connected ? `MIDI: ${keyboard.inputs.length} in` : 'Connect MIDI'));

    if (!keyboard.connected) {
      if (keyboard.error) this.transportEl.appendChild(el('span', { class: 'warn' }, keyboard.error));
      return;
    }

    this.transportEl.appendChild(el('label', {
      class: 'field',
      title: 'Mod wheel values below this read as fully off, so a wheel that does not quite rest at zero cannot colour everything you audition. CC 1 and CC 74.',
    }, 'mod dead',
      el('input', {
        type: 'number', min: 0, max: 50, step: 1,
        value: Math.round(keyboard.modDeadzone * 100),
        style: { width: '52px' },
        onchange: (e: Event) => keyboard.setModDeadzone(Number((e.target as HTMLInputElement).value) / 100),
      }), '%'));

    this.transportEl.appendChild(el('span', {
      class: keyboard.modWheel > 0 ? 'warn mono' : 'muted mono',
      title: `raw CC ${Math.round(keyboard.modWheelRaw * 127)} of 127`,
    }, `mod ${String(Math.round(keyboard.modWheel * 100)).padStart(3)}%`));
  }

  async go(id: ViewId): Promise<void> {
    const tab = TABS.find((t) => t.id === id) ?? TABS[0];
    if (!tab.enabled()) return;
    this.current?.unmount?.();
    this.currentId = tab.id;
    this.renderTabs();
    clear(this.main);
    this.main.appendChild(el('div', { class: 'empty-state' }, 'loading…'));
    const view = await tab.load();
    clear(this.main);
    this.main.className = view.flush ? 'view flush' : 'view';
    this.current = view;
    view.mount(this.main, { store, player: this.player, go: (next) => void this.go(next) });
  }
}
