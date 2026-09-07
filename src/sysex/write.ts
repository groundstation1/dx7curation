/*
 * Writing 32-voice bulk dumps, and reading them straight back to prove the
 * round trip before anything is sent to hardware.
 */
import { INIT_VOICE_PARAMS, PACKED_SIZE, UNPACKED_SIZE, packVoice, setVoiceName, unpackVoice } from './voice.ts';
import { bulkChecksum } from './parse.ts';

export const BANK_FILE_SIZE = 4104;
export const SINGLE_FILE_SIZE = 163;

/**
 * Build a 4104-byte 32-voice bulk dump.
 * Header F0 43 0n 09 20 00, 4096 data bytes, checksum, F7.
 */
export function buildBank(unpackedVoices: Uint8Array[], channel = 0): Uint8Array {
  if (unpackedVoices.length !== 32) {
    throw new Error(`a bank needs exactly 32 voices, got ${unpackedVoices.length}`);
  }
  const out = new Uint8Array(BANK_FILE_SIZE);
  out[0] = 0xf0;
  out[1] = 0x43;
  out[2] = channel & 0x0f;
  out[3] = 0x09;
  out[4] = 0x20; // 4096 >> 7
  out[5] = 0x00; // 4096 & 0x7f
  for (let i = 0; i < 32; i++) {
    const v = unpackedVoices[i];
    if (v.length !== UNPACKED_SIZE) {
      throw new Error(`voice ${i} is ${v.length} bytes, expected ${UNPACKED_SIZE}`);
    }
    packVoice(v, out, 6 + i * PACKED_SIZE);
  }
  out[4102] = bulkChecksum(out, 6, 4096);
  out[4103] = 0xf7;
  return out;
}

/** Build a 163-byte single-voice dump from a 155-byte unpacked voice. */
export function buildSingleVoice(unpacked: Uint8Array, channel = 0): Uint8Array {
  const out = new Uint8Array(SINGLE_FILE_SIZE);
  out[0] = 0xf0;
  out[1] = 0x43;
  out[2] = channel & 0x0f;
  out[3] = 0x00;
  out[4] = 0x01; // 155 >> 7
  out[5] = 0x1b; // 155 & 0x7f
  out.set(unpacked, 6);
  out[161] = bulkChecksum(out, 6, UNPACKED_SIZE);
  out[162] = 0xf7;
  return out;
}

export interface BankVerification {
  ok: boolean;
  problems: string[];
  /** The 32 voices as read back out of the file. */
  voices: Uint8Array[];
}

/**
 * Parse a bank file back and check it against the voices it was built from.
 * Compares packed bytes, since packing is the lossy step.
 */
export function verifyBank(file: Uint8Array, expected?: Uint8Array[]): BankVerification {
  const problems: string[] = [];
  if (file.length !== BANK_FILE_SIZE) {
    problems.push(`file is ${file.length} bytes, expected ${BANK_FILE_SIZE}`);
    return { ok: false, problems, voices: [] };
  }
  if (file[0] !== 0xf0 || file[1] !== 0x43 || file[3] !== 0x09) problems.push('bad header');
  if (file[4] !== 0x20 || file[5] !== 0x00) problems.push('bad byte count');
  if (file[4103] !== 0xf7) problems.push('missing terminator');
  const sum = bulkChecksum(file, 6, 4096);
  if (sum !== file[4102]) {
    problems.push(`checksum is 0x${file[4102].toString(16)}, computed 0x${sum.toString(16)}`);
  }

  const voices: Uint8Array[] = [];
  for (let i = 0; i < 32; i++) voices.push(unpackVoice(file, 6 + i * PACKED_SIZE));

  if (expected) {
    if (expected.length !== 32) problems.push(`expected list has ${expected.length} voices`);
    for (let i = 0; i < Math.min(32, expected.length); i++) {
      const want = packVoice(expected[i]);
      const got = file.subarray(6 + i * PACKED_SIZE, 6 + (i + 1) * PACKED_SIZE);
      for (let b = 0; b < PACKED_SIZE; b++) {
        if (want[b] !== got[b]) {
          problems.push(`slot ${i} differs at packed byte ${b}: ${want[b]} != ${got[b]}`);
          break;
        }
      }
    }
  }

  return { ok: problems.length === 0, problems, voices };
}

/**
 * A silent, obviously-named voice for slots there is nothing to put in.
 *
 * A bulk dump is always exactly 32 voices, so a partial set has to be padded
 * with something. An init voice with every operator silenced is the honest
 * choice: it makes no sound, it is unmistakable on the device display, and it
 * is safe to overwrite later.
 */
export function placeholderVoice(label = '-- EMPTY --'): Uint8Array {
  const v = Uint8Array.from(INIT_VOICE_PARAMS);
  for (let op = 0; op < 6; op++) v[op * 21 + 16] = 0; // output level
  setVoiceName(v, label);
  return v;
}

export const BANK_NAMES = ['A', 'B', 'C', 'D'] as const;

export interface PaddedBanks {
  banks: Uint8Array[];
  /** Slots filled with a placeholder rather than a real voice. */
  placeholders: number;
  /** Bank letters actually produced. */
  names: string[];
}

/**
 * Build as many banks as the voices need, padding the last one.
 *
 * 128 is a lot to fill from a first rating pass, so a short set produces fewer
 * banks rather than refusing to build at all - two banks of keepers you like
 * beats four banks where half are filler.
 */
export function buildBanksPadded(
  voices: Uint8Array[], opts: { channel?: number; maxBanks?: number; padLabel?: string } = {},
): PaddedBanks {
  const maxBanks = opts.maxBanks ?? 4;
  const bankCount = Math.max(1, Math.min(maxBanks, Math.ceil(voices.length / 32)));
  const banks: Uint8Array[] = [];
  const names: string[] = [];
  let placeholders = 0;
  for (let b = 0; b < bankCount; b++) {
    const slice: Uint8Array[] = [];
    for (let s = 0; s < 32; s++) {
      const v = voices[b * 32 + s];
      if (v) {
        slice.push(v);
      } else {
        slice.push(placeholderVoice(opts.padLabel));
        placeholders++;
      }
    }
    banks.push(buildBank(slice, opts.channel ?? 0));
    names.push(BANK_NAMES[b] ?? String(b + 1));
  }
  return { banks, placeholders, names };
}

/** Split 128 ordered voices into four bank files, A-D. */
export function buildBanks(voices128: Uint8Array[], channel = 0): Uint8Array[] {
  if (voices128.length !== 128) {
    throw new Error(`need exactly 128 voices, got ${voices128.length}`);
  }
  return [0, 1, 2, 3].map((b) => buildBank(voices128.slice(b * 32, b * 32 + 32), channel));
}
