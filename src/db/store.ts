/*
 * IndexedDB persistence.
 *
 * Everything the user cannot cheaply reproduce is stored: the voice table, the
 * features, the cluster assignments, and above all the ratings, which are
 * written the moment a key is pressed. Audio is never stored - rendering a
 * voice is effectively instant, so there is nothing to gain by caching it.
 */

const DB_NAME = 'dx7curation';
const DB_VERSION = 1;

export interface VoiceSource {
  file: string;
  bank: string;
  slot: number;
  /** The name this copy carried, which may differ from the survivor's. */
  name: string;
  container: string;
  checksumOk: boolean | null;
  /**
   * When the file this copy came from was last written, epoch millis, or
   * absent if unknown.
   *
   * Inside an archive this is the entry's own date, which patch collections
   * usually preserve from whenever the pack was assembled - often the only
   * chronology there is, since a voice carries no date of its own. For a loose
   * file it is the filesystem's modified time, which is frequently just the
   * day it was downloaded.
   */
  at?: number;
  /** Where `at` came from, since the two are worth very different amounts. */
  atFrom?: 'archive' | 'file';
}

export interface VoiceRecord {
  id: number;
  /** Packed bytes with the name field excluded; the exact-dedupe key. */
  packedKey: string;
  packed: Uint8Array;
  unpacked: Uint8Array;
  name: string;
  sources: VoiceSource[];
  /** User-supplied voices forced into the final 128 regardless of rating. */
  pinned: boolean;
  /** Out-of-range bytes that had to be clamped on ingest. */
  clampedBytes: number;
  /** Set when the voice came from a file the user supplied themselves. */
  userSupplied: boolean;
}

export interface FeatureRecord {
  voiceId: number;
  /** ANALYSIS_VERSION at the time these were measured. Absent means version 1. */
  analysisVersion?: number;
  acoustic: unknown;
  structural: unknown;
  vector: Float32Array;
  category: string;
  /** Subcategory id within `category`. */
  subcategory?: string;
  categoryConfidence: number;
  silent: boolean;
}

export interface RatingRecord {
  voiceId: number;
  rating: number;
  /** Epoch millis, so a session can be resumed in order. */
  at: number;
  /** Which pass produced it: the first sweep or a face-off. */
  pass: 'round1' | 'faceoff';
}

let dbPromise: Promise<IDBDatabase> | null = null;

export function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('voices')) {
        const s = db.createObjectStore('voices', { keyPath: 'id', autoIncrement: true });
        s.createIndex('packedKey', 'packedKey', { unique: true });
        s.createIndex('pinned', 'pinned', { unique: false });
      }
      if (!db.objectStoreNames.contains('features')) {
        db.createObjectStore('features', { keyPath: 'voiceId' });
      }
      if (!db.objectStoreNames.contains('ratings')) {
        db.createObjectStore('ratings', { keyPath: 'voiceId' });
      }
      if (!db.objectStoreNames.contains('kv')) {
        db.createObjectStore('kv', { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

// ------------------------------------------------------------------ voices

/**
 * Insert voices, collapsing exact duplicates onto whichever copy arrived first
 * and recording every alias so provenance survives.
 */
export async function addVoices(
  records: Array<Omit<VoiceRecord, 'id'>>,
  onProgress?: (done: number, total: number) => void,
): Promise<{ added: number; merged: number }> {
  const db = await openDb();
  let added = 0;
  let merged = 0;
  const CHUNK = 500;
  for (let start = 0; start < records.length; start += CHUNK) {
    const chunk = records.slice(start, start + CHUNK);
    const tx = db.transaction('voices', 'readwrite');
    const store = tx.objectStore('voices');
    const byKey = store.index('packedKey');
    for (const rec of chunk) {
      const existing = await req(byKey.get(rec.packedKey));
      if (existing) {
        const v = existing as VoiceRecord;
        const known = new Set(v.sources.map((s) => `${s.file}|${s.bank}|${s.slot}`));
        for (const s of rec.sources) {
          if (!known.has(`${s.file}|${s.bank}|${s.slot}`)) v.sources.push(s);
        }
        v.pinned = v.pinned || rec.pinned;
        v.userSupplied = v.userSupplied || rec.userSupplied;
        store.put(v);
        merged++;
      } else {
        store.add(rec as VoiceRecord);
        added++;
      }
    }
    await txDone(tx);
    onProgress?.(Math.min(start + CHUNK, records.length), records.length);
  }
  return { added, merged };
}

export async function getAllVoices(): Promise<VoiceRecord[]> {
  const db = await openDb();
  const tx = db.transaction('voices', 'readonly');
  return req(tx.objectStore('voices').getAll() as IDBRequest<VoiceRecord[]>);
}

export async function countVoices(): Promise<number> {
  const db = await openDb();
  const tx = db.transaction('voices', 'readonly');
  return req(tx.objectStore('voices').count());
}

export async function getVoice(id: number): Promise<VoiceRecord | undefined> {
  const db = await openDb();
  const tx = db.transaction('voices', 'readonly');
  return req(tx.objectStore('voices').get(id) as IDBRequest<VoiceRecord | undefined>);
}

export async function setPinned(id: number, pinned: boolean): Promise<void> {
  const db = await openDb();
  const tx = db.transaction('voices', 'readwrite');
  const store = tx.objectStore('voices');
  const v = (await req(store.get(id) as IDBRequest<VoiceRecord | undefined>));
  if (v) {
    v.pinned = pinned;
    store.put(v);
  }
  await txDone(tx);
}

// ---------------------------------------------------------------- features

export async function putFeatures(records: FeatureRecord[]): Promise<void> {
  const db = await openDb();
  const CHUNK = 1000;
  for (let start = 0; start < records.length; start += CHUNK) {
    const tx = db.transaction('features', 'readwrite');
    const store = tx.objectStore('features');
    for (const r of records.slice(start, start + CHUNK)) store.put(r);
    await txDone(tx);
  }
}

export async function getAllFeatures(): Promise<FeatureRecord[]> {
  const db = await openDb();
  const tx = db.transaction('features', 'readonly');
  return req(tx.objectStore('features').getAll() as IDBRequest<FeatureRecord[]>);
}

export async function countFeatures(): Promise<number> {
  const db = await openDb();
  const tx = db.transaction('features', 'readonly');
  return req(tx.objectStore('features').count());
}

// ----------------------------------------------------------------- ratings

/** Written immediately on every keypress, so a session is always resumable. */
export async function putRating(r: RatingRecord): Promise<void> {
  const db = await openDb();
  const tx = db.transaction('ratings', 'readwrite');
  tx.objectStore('ratings').put(r);
  await txDone(tx);
}

export async function getAllRatings(): Promise<RatingRecord[]> {
  const db = await openDb();
  const tx = db.transaction('ratings', 'readonly');
  return req(tx.objectStore('ratings').getAll() as IDBRequest<RatingRecord[]>);
}

export async function deleteRating(voiceId: number): Promise<void> {
  const db = await openDb();
  const tx = db.transaction('ratings', 'readwrite');
  tx.objectStore('ratings').delete(voiceId);
  await txDone(tx);
}

// ---------------------------------------------------------- key/value state

export async function kvGet<T>(key: string): Promise<T | undefined> {
  const db = await openDb();
  const tx = db.transaction('kv', 'readonly');
  const row = await req(tx.objectStore('kv').get(key) as IDBRequest<{ key: string; value: T } | undefined>);
  return row?.value;
}

export async function kvSet<T>(key: string, value: T): Promise<void> {
  const db = await openDb();
  const tx = db.transaction('kv', 'readwrite');
  tx.objectStore('kv').put({ key, value });
  await txDone(tx);
}

export async function kvDelete(key: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction('kv', 'readwrite');
  tx.objectStore('kv').delete(key);
  await txDone(tx);
}

/** Clear every rating, keeping the corpus and its features. */
export async function clearRatings(): Promise<void> {
  const db = await openDb();
  const tx = db.transaction('ratings', 'readwrite');
  tx.objectStore('ratings').clear();
  await txDone(tx);
}

/** Wipe everything. Used by the "start over" control on the ingest screen. */
export async function clearAll(): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(['voices', 'features', 'ratings', 'kv'], 'readwrite');
  for (const name of ['voices', 'features', 'ratings', 'kv']) tx.objectStore(name).clear();
  await txDone(tx);
}
