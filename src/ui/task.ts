/*
 * One progress bar, for every job that takes long enough to notice.
 *
 * Before this each long job grew its own reporting, or didn't: the analysis
 * pass had a bar with an ETA, the near-duplicate pass had a bar with an ETA
 * written separately, ingest had a text counter, and loading forty thousand
 * voices - the slowest thing the app does - had the word "projecting" and no
 * indication of whether it was halfway or stuck. A job with no progress is
 * indistinguishable from a crash, so reporting cannot be something each caller
 * remembers to add.
 *
 * A task is a label, a fraction, and optionally a way to stop it. The chrome
 * renders whichever one is on top; the work itself never touches the DOM.
 */

export interface TaskHandle {
  /** Fraction complete in 0..1, or null while it cannot be known. */
  set(fraction: number | null, detail?: string): void;
  /** Change what the task says it is doing, for multi-stage work. */
  stage(label: string): void;
}

export interface TaskView {
  label: string;
  detail: string;
  /** 0..1, or null for indeterminate. */
  fraction: number | null;
  startedAt: number;
  cancel: (() => void) | null;
}

const stack: TaskView[] = [];
const listeners = new Set<() => void>();

/** How often the chrome is told about a change, at most. */
const EMIT_MS = 80;
let lastEmit = 0;
let pending = 0;

function emit(force = false): void {
  const now = performance.now();
  if (!force && now - lastEmit < EMIT_MS) {
    // Coalesce: a worker can report thousands of times a second, and every one
    // of those would otherwise be a layout.
    if (!pending) pending = window.setTimeout(() => { pending = 0; emit(true); }, EMIT_MS);
    return;
  }
  if (pending) { clearTimeout(pending); pending = 0; }
  lastEmit = now;
  for (const fn of listeners) fn();
}

export function subscribeTasks(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** The task to show: the most recently started one still running. */
export function activeTask(): TaskView | null {
  return stack.length ? stack[stack.length - 1] : null;
}

export function anyTaskRunning(): boolean {
  return stack.length > 0;
}

/**
 * Run `work`, reporting its progress for as long as it takes.
 *
 * The task is removed whether the work resolves, throws or is cancelled, so a
 * failure cannot leave a bar on screen forever.
 */
export async function runTask<T>(
  label: string,
  work: (t: TaskHandle) => Promise<T>,
  opts: { cancel?: () => void } = {},
): Promise<T> {
  const view: TaskView = {
    label,
    detail: '',
    fraction: null,
    startedAt: performance.now(),
    cancel: opts.cancel ?? null,
  };
  stack.push(view);
  emit(true);

  const handle: TaskHandle = {
    set(fraction, detail) {
      view.fraction = fraction === null ? null : Math.max(0, Math.min(1, fraction));
      if (detail !== undefined) view.detail = detail;
      emit();
    },
    stage(next) {
      view.label = next;
      emit(true);
    },
  };

  try {
    return await work(handle);
  } finally {
    const at = stack.indexOf(view);
    if (at >= 0) stack.splice(at, 1);
    emit(true);
  }
}
