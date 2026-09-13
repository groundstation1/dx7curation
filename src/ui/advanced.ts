/*
 * One switch, and a lot less on screen.
 *
 * This app accumulated a control for every decision it makes, because every one
 * of those decisions was interesting while it was being built. Sixteen of them
 * sat in the map's control bar; the build page asked six questions before it
 * would produce anything. All of them have a defensible default, and almost
 * none of them get touched twice.
 *
 * So there are two audiences - the one who wants the thing to work, and the one
 * who wants to know why it chose 0.03 - and they want different screens. This
 * decides which screen you get. It is not a beginner mode: nothing is removed,
 * and everything hidden here keeps working on its stored value.
 *
 * The other half of the same idea is `disclosure`, for things that should be
 * one click away rather than behind a mode: a click is cheaper than a setting
 * for anything you might plausibly want *right now*.
 */
import { el } from './dom.ts';
import { getSetting, setSetting } from './settings.ts';

let advanced = getSetting('ui.advanced', false);
const listeners = new Set<() => void>();

export function isAdvanced(): boolean {
  return advanced;
}

export function setAdvanced(on: boolean): void {
  if (advanced === on) return;
  advanced = on;
  setSetting('ui.advanced', on);
  for (const fn of listeners) fn();
}

export function subscribeAdvanced(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * `node` when advanced is on, nothing otherwise.
 *
 * Written to be used inline in an element list, where the alternative is an
 * `if` around every second control and a builder that no longer reads like the
 * thing it builds.
 */
export function adv<T extends Node>(node: T | null): T | null {
  return advanced ? node : null;
}

/** The switch itself, for the top bar. */
export function advancedSwitch(): HTMLElement {
  const label = el('label', {
    class: 'adv-switch',
    title: 'Show every threshold, axis and weight the app decides for you, plus the screens and tools that are still being worked out.',
  },
    el('input', {
      type: 'checkbox',
      checked: advanced,
      onchange: (e: Event) => setAdvanced((e.target as HTMLInputElement).checked),
    }),
    el('span', { class: 'adv-track' }),
    'advanced and experimental');
  return label;
}

/**
 * A titled section that is closed until asked for.
 *
 * The body is built the first time it opens and kept after that, so a panel
 * nobody expands costs one line of DOM - which matters here, because the things
 * worth hiding are also the expensive ones to draw.
 */
export function disclosure(
  title: string,
  build: () => Node,
  opts: { open?: boolean; note?: string; key?: string } = {},
): HTMLElement {
  const stored = opts.key ? getSetting(`ui.open.${opts.key}`, opts.open ?? false) : opts.open ?? false;
  const body = el('div', { class: 'disc-body' });
  let built = false;

  const fill = () => {
    if (built) return;
    built = true;
    body.appendChild(build());
  };

  const details = el('details', { class: 'disc', open: stored },
    el('summary', {}, title, opts.note ? el('span', { class: 'muted disc-note' }, opts.note) : null),
    body);

  details.addEventListener('toggle', () => {
    if (details.open) fill();
    if (opts.key) setSetting(`ui.open.${opts.key}`, details.open);
  });
  if (stored) fill();
  return details;
}
