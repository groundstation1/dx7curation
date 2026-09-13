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
export async function availableBundles(): Promise<BundleEntry[]> {
  try {
    const res = await fetch(MANIFEST, { cache: 'no-cache' });
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
