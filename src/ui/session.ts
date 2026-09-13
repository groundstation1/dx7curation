/*
 * Reading and writing a whole session as one file.
 *
 * A session used to carry the patches and what you decided about them, and
 * nothing else, on the reasoning that everything derived is a pure function of
 * the patch bytes and so costs a download rather than a recomputation. That
 * reasoning was wrong about the cost. On thirty-five thousand voices the
 * recomputation is eight minutes of analysis, a near-duplicate pass, and a
 * layout - so restoring a session meant opening the app and waiting, which is
 * not what anybody means by restoring a session.
 *
 * So the derived work travels too, and because it does, the file needs
 * compressing: the vectors are the bulk of it and base64 floats gzip well.
 *
 * Two rules govern everything here.
 *
 * A file that was written before any of this must still load. Version 1 files
 * are plain JSON with no features, and they open exactly as they did - every
 * addition is optional and its absence means "recompute that part", which is
 * the old behaviour.
 *
 * And nothing carried in may be trusted to match this build. Features are
 * stamped with the analysis version they were measured under and dropped if it
 * has moved on; the graph and the layout are tied to the number of voices.
 * Being slow is recoverable. Silently using numbers that mean something else
 * is not.
 */
import { ANALYSIS_VERSION } from '../features/vector.ts';
import type { NearDupeGraph } from '../cluster/nearDupe.ts';
import type { VoiceSource } from '../db/store.ts';

export const SESSION_FORMAT = 'dx7curation-session';
/** 1: patches and judgements. 2: adds features, the graph and the layout. */
export const SESSION_VERSION = 2;

export interface SessionVoice {
  p: string;
  n: string;
  s: VoiceSource[];
  pin?: boolean;
  us?: boolean;
}

export interface SessionFeatures {
  analysisVersion: number;
  /** One base64 Float32Array per voice, in voice order. */
  vectors: string[];
  /*
   * The measurements the vector was built from, kept whole.
   *
   * Tempting to leave out - the vector is what the model and the map use, and
   * these are several times its size. But the sidebar reads attack and release
   * and brightness straight off the acoustic record, the axes read the
   * structural one, and the categoriser needs both to re-label anything. A
   * corpus restored without them loads and then throws the moment a patch is
   * selected, which is how this was found.
   */
  acoustic: unknown[];
  structural: unknown[];
  categories: string[];
  subcategories: string[];
  confidence: number[];
  /** 1 where the voice renders to nothing. One byte each, base64. */
  silent: string;
}

export interface SessionFile {
  format: string;
  version: number;
  savedAt: string;
  threshold: number;
  mergeThreshold: number;
  voices: SessionVoice[];
  judgements?: unknown;
  features?: SessionFeatures;
  graph?: {
    n: number;
    a: string;
    b: string;
    d: string;
    featureScale: number;
    paramScale: number;
    featureWeight: number;
    paramWeight: number;
    blocks: number;
    truncated: boolean;
  };
  embedding?: { n: number; coords: string };
  /**
   * A name for where these patches came from, stamped on every source that
   * has none of its own. Set when a prepared collection is shipped with the
   * app, so those voices can be told from the ones you brought yourself.
   */
  bundle?: string;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let s = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(s);
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * A typed array as base64, and back.
 *
 * Through the byte view rather than through JSON numbers: an array of thirty
 * thousand floats written as text is several times its own size and parses
 * slowly, and this is the bulk of the file.
 */
export const f32ToBase64 = (a: Float32Array): string =>
  bytesToBase64(new Uint8Array(a.buffer, a.byteOffset, a.byteLength));
export const i32ToBase64 = (a: Int32Array): string =>
  bytesToBase64(new Uint8Array(a.buffer, a.byteOffset, a.byteLength));

export function base64ToF32(b64: string): Float32Array {
  const bytes = base64ToBytes(b64);
  // Copied rather than viewed: atob's output has no alignment guarantee, and
  // a Float32Array view onto an odd offset throws.
  return new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}

export function base64ToI32(b64: string): Int32Array {
  const bytes = base64ToBytes(b64);
  return new Int32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}

const GZIP_MAGIC = [0x1f, 0x8b];

export function looksGzipped(bytes: Uint8Array): boolean {
  return bytes.length > 2 && bytes[0] === GZIP_MAGIC[0] && bytes[1] === GZIP_MAGIC[1];
}

/** Compress, if the browser can; otherwise hand back the bytes unchanged. */
export async function gzip(text: string): Promise<Uint8Array> {
  const raw = new TextEncoder().encode(text);
  if (typeof CompressionStream === 'undefined') return raw;
  const stream = new Blob([raw as BlobPart]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Decompress if it is compressed, decode either way. */
export async function readSessionBytes(bytes: Uint8Array): Promise<string> {
  if (!looksGzipped(bytes)) return new TextDecoder().decode(bytes);
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('that file is compressed and this browser cannot decompress it');
  }
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).text();
}

/** True when `json` is a whole session rather than judgements alone. */
export function isSessionJson(json: string): boolean {
  try {
    return (JSON.parse(json) as { format?: string }).format === SESSION_FORMAT;
  } catch {
    return false;
  }
}

/**
 * Whether features carried in a file can be believed.
 *
 * They are a measurement, and a measurement is only comparable with others
 * taken the same way. The version moves whenever a feature would come out
 * differently today, so a mismatch means re-measuring - slower, and right.
 */
export function featuresUsable(f: SessionFeatures | undefined, voices: number): f is SessionFeatures {
  return !!f
    && f.analysisVersion === ANALYSIS_VERSION
    && f.vectors.length === voices
    // Written before the acoustic detail travelled: the vectors alone load and
    // then fail the moment a patch is selected, so they are not usable.
    && Array.isArray(f.acoustic) && f.acoustic.length === voices
    && Array.isArray(f.structural) && f.structural.length === voices;
}

export function graphUsable(g: SessionFile['graph'], voices: number): g is NonNullable<SessionFile['graph']> {
  return !!g && g.n === voices;
}
