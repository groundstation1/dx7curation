/*
 * A draggable edge for the sidebars.
 *
 * The sidebar holds an algorithm diagram, an envelope per operator and a list
 * of every file a patch came from, and how much room that deserves depends
 * entirely on what you are doing - reading paths wants width, sweeping the map
 * wants the plot. A fixed 300 pixels was always wrong for one of those.
 *
 * The handle is positioned against the layout rather than inserted into the
 * grid, so nothing about the columns changes and a scrolling sidebar cannot
 * carry it away.
 */
import { getSetting, setSetting } from './settings.ts';

export interface SplitterOptions {
  /** Setting key the width is remembered under. */
  key: string;
  defaultWidth?: number;
  min?: number;
  max?: number;
  /**
   * Called on every move, not only on release.
   *
   * A canvas does not re-render when its box changes: the bitmap is simply
   * scaled to the new size, so dragging this handle squeezed the plot like a
   * photograph and only redrew when something else happened to call `draw`.
   * Anything that paints its own pixels has to be told.
   */
  onResize?: () => void;
}

/**
 * Give `layout` a resizable right-hand column.
 *
 * The layout's grid must size that column from `--side-w`; this sets the
 * variable, restores it on mount, and returns the handle to append.
 */
export function sidebarSplitter(layout: HTMLElement, opts: SplitterOptions): HTMLElement {
  const def = opts.defaultWidth ?? 300;
  const min = opts.min ?? 220;
  // Never more than two thirds of the window: a sidebar that can eat the whole
  // screen is a sidebar you can lose the app behind.
  const maxOf = () => Math.min(opts.max ?? 900, Math.max(min, window.innerWidth * 0.66));

  const clamp = (w: number) => Math.round(Math.max(min, Math.min(maxOf(), w)));
  const apply = (w: number) => layout.style.setProperty('--side-w', `${clamp(w)}px`);
  apply(getSetting(opts.key, def));

  const handle = document.createElement('div');
  handle.className = 'side-handle';
  handle.title = 'Drag to resize. Double-click to reset.';

  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    handle.classList.add('dragging');
    const right = layout.getBoundingClientRect().right;

    const move = (ev: PointerEvent) => {
      apply(right - ev.clientX);
      opts.onResize?.();
    };
    const up = (ev: PointerEvent) => {
      handle.releasePointerCapture(ev.pointerId);
      handle.classList.remove('dragging');
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      const current = layout.style.getPropertyValue('--side-w');
      setSetting(opts.key, parseInt(current, 10) || def);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
  });

  handle.addEventListener('dblclick', () => {
    apply(def);
    setSetting(opts.key, def);
    opts.onResize?.();
  });

  return handle;
}
