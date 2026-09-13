/*
 * Waiting, in the middle of the screen that is waiting.
 *
 * Three places in this app block on something slow enough to need a bar: the
 * first screen while a collection downloads, the rating screen while its queue
 * is worked out, and the whole app while the corpus is read back out of the
 * database on a revisit. All three had the same problem in a different form -
 * the progress was reported into the thin strip in the title bar, which is the
 * right place for work you set going and then carry on around, and the wrong
 * place for work that is the only thing happening.
 *
 * So they share this. It is not the layout - each caller wraps it in whatever
 * its screen needs - only the three lines that move, and the one rule about
 * how they move: the bar never goes backwards.
 */
import { el } from './dom.ts';
import { activeTask, claimTaskDisplay, subscribeTasks } from './task.ts';

/**
 * Where each stage sits on the one bar, for a job made of several tasks.
 *
 * Substeps are separate tasks and each counts its own work from zero, so shown
 * raw the bar fills and resets once per step - which reads as several failures
 * rather than as one job. A band per stage keeps it monotonic. The widths do
 * not have to be exact, only in order: what ruins a progress bar is going
 * backwards, not being slightly wrong about the middle.
 *
 * Anything unrecognised holds the bar where it is rather than moving it
 * somewhere arbitrary - a stage nobody predicted is not a reason to lie.
 */
export type LoadBands = ReadonlyArray<readonly [RegExp, number, number]>;

export interface LoadBlock {
  node: HTMLElement;
  /** Release the task display and stop painting. Safe to call twice. */
  stop(): void;
}

export function loadBlock(opts: { bands?: LoadBands; label?: string } = {}): LoadBlock {
  const label = el('div', { class: 'splash-load-label' }, opts.label ?? 'Starting up');
  const bar = el('div', { class: 'splash-load-bar indeterminate' }, el('i', { style: { width: '100%' } }));
  const detail = el('div', { class: 'splash-load-detail muted' }, '');
  const node = el('div', { class: 'splash-load' }, label, bar, detail);

  let shown = 0;
  const paint = () => {
    const task = activeTask();
    if (!task) return;
    label.textContent = task.label;
    const fill = bar.firstElementChild as HTMLElement;

    if (opts.bands) {
      const band = opts.bands.find(([re]) => re.test(task.label));
      if (band) {
        const [, from, to] = band;
        const within = task.fraction ?? 0;
        // Never backwards: a stage that starts lower than the last one finished
        // is still further through the job than the last one was.
        shown = Math.max(shown, from + (to - from) * within);
        bar.classList.remove('indeterminate');
        fill.style.width = `${(shown * 100).toFixed(1)}%`;
      } else if (shown === 0) {
        bar.classList.add('indeterminate');
        fill.style.width = '100%';
      }
      detail.textContent = task.detail || (shown > 0 ? `${Math.round(shown * 100)}%` : '');
      return;
    }

    if (task.fraction === null) {
      bar.classList.add('indeterminate');
      fill.style.width = '100%';
    } else {
      bar.classList.remove('indeterminate');
      fill.style.width = `${(task.fraction * 100).toFixed(1)}%`;
    }
    detail.textContent = task.detail || '';
  };

  const unsub = subscribeTasks(paint);
  claimTaskDisplay(true);
  paint();

  let stopped = false;
  return {
    node,
    stop() {
      if (stopped) return;
      stopped = true;
      unsub();
      claimTaskDisplay(false);
    },
  };
}

/** The wordmark, for the two screens that show it while they wait. */
export function loadingBrand(): HTMLElement {
  return el('div', { class: 'splash-brand' },
    el('span', { class: 'brand-name' }, 'DX7', el('span', { class: 'brand-sp' }), 'curator'));
}
