/*
 * Minimal ZIP reader.
 *
 * Bobby Blues ships the whole "All The Web Collection" as one zip, and several
 * other sources are zipped too, so making the user unpack thousands of files by
 * hand first would be a needless step. Only the two methods that actually occur
 * in these archives are supported: stored and deflate, the latter via the
 * platform's own DecompressionStream.
 */

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;

export interface ZipEntry {
  name: string;
  compressedSize: number;
  uncompressedSize: number;
  method: number;
  offset: number;
  isDirectory: boolean;
}

export function isZip(bytes: Uint8Array): boolean {
  return bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b &&
    (bytes[2] === 0x03 || bytes[2] === 0x05 || bytes[2] === 0x07);
}

function findEocd(dv: DataView, bytes: Uint8Array): number {
  // The comment field means the EOCD is not necessarily at the very end.
  const limit = Math.max(0, bytes.length - 0xffff - 22);
  for (let i = bytes.length - 22; i >= limit; i--) {
    if (dv.getUint32(i, true) === EOCD_SIGNATURE) return i;
  }
  return -1;
}

export function readZipDirectory(bytes: Uint8Array): ZipEntry[] {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = findEocd(dv, bytes);
  if (eocd < 0) throw new Error('not a zip file, or the central directory is missing');

  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const entries: ZipEntry[] = [];
  const decoder = new TextDecoder();

  for (let i = 0; i < count; i++) {
    if (p + 46 > bytes.length || dv.getUint32(p, true) !== CENTRAL_SIGNATURE) break;
    const method = dv.getUint16(p + 10, true);
    const compressedSize = dv.getUint32(p + 20, true);
    const uncompressedSize = dv.getUint32(p + 24, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const offset = dv.getUint32(p + 42, true);
    const name = decoder.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    entries.push({
      name,
      method,
      compressedSize,
      uncompressedSize,
      offset,
      isDirectory: name.endsWith('/'),
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('this browser cannot inflate deflate-compressed zip entries');
  }
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function readZipEntry(bytes: Uint8Array, entry: ZipEntry): Promise<Uint8Array> {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // The local header repeats the name and extra field with its own lengths.
  const nameLen = dv.getUint16(entry.offset + 26, true);
  const extraLen = dv.getUint16(entry.offset + 28, true);
  const start = entry.offset + 30 + nameLen + extraLen;
  const raw = bytes.subarray(start, start + entry.compressedSize);
  if (entry.method === 0) return raw.slice();
  if (entry.method === 8) return inflateRaw(raw);
  throw new Error(`unsupported zip compression method ${entry.method} for ${entry.name}`);
}

export interface ExtractedFile {
  name: string;
  bytes: Uint8Array;
}

/** Extract every entry that could plausibly hold voice data. */
export async function extractZip(
  bytes: Uint8Array,
  accept: (name: string, size: number) => boolean,
  onProgress?: (done: number, total: number) => void,
): Promise<{ files: ExtractedFile[]; skipped: number; failed: Array<{ name: string; error: string }> }> {
  const entries = readZipDirectory(bytes).filter((e) => !e.isDirectory);
  const files: ExtractedFile[] = [];
  const failed: Array<{ name: string; error: string }> = [];
  let skipped = 0;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (!accept(e.name, e.uncompressedSize)) {
      skipped++;
    } else {
      try {
        files.push({ name: e.name, bytes: await readZipEntry(bytes, e) });
      } catch (err) {
        failed.push({ name: e.name, error: (err as Error).message });
      }
    }
    if ((i & 63) === 0) onProgress?.(i, entries.length);
  }
  onProgress?.(entries.length, entries.length);
  return { files, skipped, failed };
}
