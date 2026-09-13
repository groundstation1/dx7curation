/*
 * Collections that ship with the app.
 *
 * A prepared session - patches, measurements, groupings and the map, already
 * computed - so the first run can be a corpus to listen to rather than a file
 * dialog and a quarter of an hour of waiting. It is the same format `Save and
 * load` writes, which is the point: preparing one is running the app once and
 * exporting.
 *
 * There may be none. The manifest is fetched and a missing file is not an
 * error - the app ships without a collection unless one has been put there,
 * because whether a given archive may be redistributed is a question about
 * that archive and not about this code. So the splash offers what it finds and
 * says nothing about what it does not.
 */

export interface BundleEntry {
  /** Stamped on every source the bundle brings, and shown in the filter. */
  name: string;
  /** Path under the site root, gzipped session. */
  file: string;
  /** For the button, so the size of the thing is known before it downloads. */
  voices?: number;
  bytes?: number;
  note?: string;
}

const MANIFEST = 'bundles/manifest.json';

/**
 * What is available, or nothing at all.
 *
 * Every failure is the same answer: a missing manifest, a malformed one, no
 * network. The splash simply does not offer a collection, which is a complete
 * and honest state rather than an error anybody can act on.
 */
/*
 * Fetched once per session.
 *
 * The manifest is a static file that cannot change while the app is open, and
 * the screens that ask for it re-render on every store change - so this was a
 * revalidating request per render, with the cards waiting on it each time.
 * The promise is kept, not the result, so simultaneous callers share one
 * request rather than racing.
 */
let pending: Promise<BundleEntry[]> | null = null;
/*
 * The answer, once it exists, for callers that cannot wait.
 *
 * Holding only the promise meant the collection card was always appended a
 * frame or two after the screen it belongs to, so the first thing anybody saw
 * was one card, and then two - a visible jolt on the one screen that is
 * nothing but those cards. Keeping the resolved list as well lets the second
 * and every later render draw both at once, and `prefetch` means even the
 * first usually can.
 */
let resolved: BundleEntry[] | null = null;

export function availableBundles(): Promise<BundleEntry[]> {
  if (!pending) {
    pending = loadManifest().then((list) => {
      resolved = list;
      return list;
    });
  }
  return pending;
}

/** What is already known, or null if the manifest has not landed yet. */
export function bundlesNow(): BundleEntry[] | null {
  return resolved;
}

/**
 * Ask for the manifest before anything needs it.
 *
 * It is a couple of hundred bytes next to a corpus that takes seconds to read
 * out of the database, so starting it at boot means it is always there by the
 * time a screen wants to draw it.
 */
export function prefetchBundles(): void {
  void availableBundles();
}

async function loadManifest(): Promise<BundleEntry[]> {
  try {
    const res = await fetch(MANIFEST);
    if (!res.ok) return [];
    const data: unknown = await res.json();
    const list = Array.isArray(data) ? data : (data as { bundles?: unknown[] }).bundles;
    if (!Array.isArray(list)) return [];
    return list.filter((b): b is BundleEntry =>
      !!b && typeof b === 'object'
      && typeof (b as BundleEntry).name === 'string'
      && typeof (b as BundleEntry).file === 'string');
  } catch {
    return [];
  }
}

/** Download one, reporting progress, since these are tens of megabytes. */
export async function fetchBundle(
  entry: BundleEntry, onProgress?: (done: number, total: number) => void,
): Promise<Uint8Array> {
  const res = await fetch(entry.file);
  if (!res.ok) throw new Error(`could not fetch ${entry.name} (${res.status})`);
  const total = Number(res.headers.get('content-length') ?? entry.bytes ?? 0);
  if (!res.body || !total) return new Uint8Array(await res.arrayBuffer());

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let done = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    chunks.push(next.value);
    done += next.value.length;
    onProgress?.(done, total);
  }
  const out = new Uint8Array(done);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}
