/*
 * Small persistent preferences: the knobs you set once and expect to stay set.
 *
 * Everything about the corpus - voices, features, ratings, thresholds - lives in
 * IndexedDB, because it is large and written in bulk. These are the opposite:
 * a handful of scalars read while a view is being built, so they use
 * localStorage and stay synchronous. A view can ask for its setting inline in
 * the same expression that renders the control, with no await and no loading
 * state to get wrong.
 *
 * Reads and writes are both defensive. localStorage throws outright in some
 * privacy modes, and a stale or hand-edited value must never be able to stop
 * the app from starting - a bad setting falls back to its default.
 */

const KEY = 'dx7.settings';

let cache: Record<string, unknown> | null = null;

function all(): Record<string, unknown> {
  if (cache) return cache;
  try {
    const raw = localStorage.getItem(KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    cache = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    cache = {};
  }
  return cache;
}

/** The stored value for `key`, or `fallback` if there is none of the right type. */
export function getSetting<T>(key: string, fallback: T): T {
  const value = all()[key];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== typeof fallback) return fallback;
  return value as T;
}

export function setSetting(key: string, value: unknown): void {
  all()[key] = value;
  try {
    localStorage.setItem(KEY, JSON.stringify(cache));
  } catch {
    // Full, or storage is denied. The setting still applies to this session.
  }
}

/**
 * Read a setting and hand back a setter that stores every change.
 *
 * Most call sites want exactly this pair, and writing them separately is how a
 * control ends up reading its stored value but never writing it back.
 */
export function setting<T>(key: string, fallback: T): [T, (value: T) => void] {
  return [getSetting(key, fallback), (value: T) => setSetting(key, value)];
}

export function clearSettings(): void {
  cache = {};
  try {
    localStorage.removeItem(KEY);
  } catch {
    // Nothing to do.
  }
}
