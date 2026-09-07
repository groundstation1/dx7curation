/*
 * Ingest: turn arbitrary dropped files into a flat list of 128-byte packed
 * voices with provenance.
 *
 * The archives in scope are messy. Files may be a clean 4104-byte bulk dump, a
 * headerless 4096-byte block, several banks concatenated, single-voice dumps,
 * DX7II banks with ACED/AMEM/PMEM sections interleaved, or a raw stream of
 * packed voices (dx7pytorch's collection.bin). Everything is handled by
 * scanning for F0..F7 messages first and falling back to raw block shapes.
 */
import { PACKED_SIZE, packVoice, unpackVoice } from './voice.ts';

export type Container = 'bulk32' | 'single' | 'raw' | 'salvaged';

export interface RawVoice {
  /** 128 packed bytes. */
  packed: Uint8Array;
  sourceFile: string;
  /** Bank label: file name, plus an index when a file holds several banks. */
  bank: string;
  /** Slot within its bank, 0-31. */
  slot: number;
  container: Container;
  /** null when the container carries no checksum. */
  checksumOk: boolean | null;
}

export interface ParseReport {
  voices: RawVoice[];
  banks: number;
  singles: number;
  skipped: Array<{ reason: string; count: number }>;
  bytesRead: number;
}

const YAMAHA = 0x43;

export function bulkChecksum(data: Uint8Array, start: number, length: number): number {
  let sum = 0;
  for (let i = 0; i < length; i++) sum += data[start + i];
  return (-sum) & 0x7f;
}

interface SysexMessage {
  start: number; // index of F0
  end: number; // index of F7
}

function* scanSysex(buf: Uint8Array): Generator<SysexMessage> {
  let i = 0;
  const n = buf.length;
  while (i < n) {
    if (buf[i] !== 0xf0) {
      i++;
      continue;
    }
    let j = i + 1;
    while (j < n && buf[j] !== 0xf7) {
      // A second F0 before F7 means the first message was truncated.
      if (buf[j] === 0xf0) break;
      j++;
    }
    if (j < n && buf[j] === 0xf7) {
      yield { start: i, end: j };
      i = j + 1;
    } else {
      i = j;
    }
  }
}

function addBank(
  out: RawVoice[], data: Uint8Array, start: number, sourceFile: string,
  bank: string, container: Container, checksumOk: boolean | null,
): void {
  for (let slot = 0; slot < 32; slot++) {
    out.push({
      packed: data.slice(start + slot * PACKED_SIZE, start + (slot + 1) * PACKED_SIZE),
      sourceFile,
      bank,
      slot,
      container,
      checksumOk,
    });
  }
}

/** Parse one dropped file into packed voices. */
export function parseSysexFile(bytes: Uint8Array, sourceFile: string): ParseReport {
  const voices: RawVoice[] = [];
  const skipped = new Map<string, number>();
  const skip = (reason: string) => skipped.set(reason, (skipped.get(reason) ?? 0) + 1);
  let banks = 0;
  let singles = 0;
  let sawSysex = false;

  for (const msg of scanSysex(bytes)) {
    const len = msg.end - msg.start + 1;
    if (len < 6) {
      skip('sysex message too short');
      continue;
    }
    if (bytes[msg.start + 1] !== YAMAHA) {
      skip('not a Yamaha sysex message');
      continue;
    }
    sawSysex = true;
    const substatus = (bytes[msg.start + 2] >> 4) & 7;
    const format = bytes[msg.start + 3];
    const declared = ((bytes[msg.start + 4] & 0x7f) << 7) | (bytes[msg.start + 5] & 0x7f);
    const dataStart = msg.start + 6;
    const available = msg.end - dataStart; // excludes the checksum byte

    if (substatus !== 0) {
      skip('parameter change message');
      continue;
    }

    if (format === 9) {
      if (available < 4096) {
        skip('truncated 32-voice bank');
        continue;
      }
      const sum = bulkChecksum(bytes, dataStart, 4096);
      const ok = sum === bytes[dataStart + 4096];
      const label = banks === 0 ? sourceFile : `${sourceFile} #${banks + 1}`;
      addBank(voices, bytes, dataStart, sourceFile, label, 'bulk32', ok);
      banks++;
    } else if (format === 0) {
      if (available < 155) {
        skip('truncated single voice');
        continue;
      }
      const sum = bulkChecksum(bytes, dataStart, 155);
      const ok = sum === bytes[dataStart + 155];
      const unpacked = bytes.slice(dataStart, dataStart + 155);
      voices.push({
        packed: packVoice(unpacked),
        sourceFile,
        bank: sourceFile,
        slot: singles % 32,
        container: 'single',
        checksumOk: ok,
      });
      singles++;
    } else if (format === 6 || format === 7) {
      skip('DX7II supplement (ACED/AMEM) - ignored by the FM-1');
    } else if (format === 4 || format === 5) {
      skip('performance data (PCED/PMEM)');
    } else if (declared === 4096) {
      // Unknown format byte but bank-shaped: salvage it.
      if (available >= 4096) {
        const label = banks === 0 ? sourceFile : `${sourceFile} #${banks + 1}`;
        addBank(voices, bytes, dataStart, sourceFile, label, 'salvaged', null);
        banks++;
      } else {
        skip(`unknown format ${format}`);
      }
    } else {
      skip(`unknown format ${format}`);
    }
  }

  if (voices.length === 0 && !sawSysex) {
    // Headerless data. Two shapes are common: a 4104-byte file whose header was
    // stripped or corrupted, and a raw stream of packed voices.
    if (bytes.length === 4104 && bytes[bytes.length - 1] === 0xf7) {
      addBank(voices, bytes, 6, sourceFile, sourceFile, 'salvaged', null);
      banks = 1;
    } else if (bytes.length >= PACKED_SIZE && bytes.length % PACKED_SIZE === 0) {
      const count = bytes.length / PACKED_SIZE;
      for (let i = 0; i < count; i++) {
        const bankIndex = Math.floor(i / 32);
        voices.push({
          packed: bytes.slice(i * PACKED_SIZE, (i + 1) * PACKED_SIZE),
          sourceFile,
          bank: count > 32 ? `${sourceFile} #${bankIndex + 1}` : sourceFile,
          slot: i % 32,
          container: 'raw',
          checksumOk: null,
        });
      }
      banks = Math.ceil(count / 32);
    } else {
      skip('unrecognised file shape');
    }
  }

  return {
    voices,
    banks,
    singles,
    skipped: [...skipped].map(([reason, count]) => ({ reason, count })),
    bytesRead: bytes.length,
  };
}

/** Convenience: parse and unpack in one step. */
export function parseToUnpacked(bytes: Uint8Array, sourceFile: string): Array<RawVoice & { unpacked: Uint8Array }> {
  return parseSysexFile(bytes, sourceFile).voices.map((v) => ({ ...v, unpacked: unpackVoice(v.packed) }));
}
