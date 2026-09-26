/*
 * Reading the current voice back out of an M-Vave FM-1.
 *
 * The FM-1 answers a vendor-specific read command with the sound it is
 * playing right now, as a 155-byte DX7 single voice - the same layout this
 * app keeps every patch in, so nothing needs translating on the way in.
 *
 * The protocol is Christian Zietz's work, reverse-engineered and published as
 * fm1-read-voice (https://github.com/czietz/fm1-read-voice, MIT licence), and
 * tested there against firmware V14 and V15. This is a TypeScript port of its
 * packing and command framing; see THIRD-PARTY-NOTICES.md. It is a read of the
 * synth's RAM and changes nothing on the device.
 *
 * The framing, for the next person to look at it:
 *
 *   00 59 <cmd> <len, 3 bytes LE> <payload> <checksum>
 *
 * where the checksum is the payload's byte sum, low 8 bits, inverted, and the
 * whole frame is then packed from 8-bit bytes into 7-bit sysex data as a
 * little-endian bit stream. The read command is 0x23 with a payload of
 * sub-command 5 (voice), a 4-byte offset of 0 and a 3-byte length of 155. The
 * reply comes back framed the same way; unpacked, the voice is everything
 * after the first fourteen bytes and before the final checksum.
 */
import { listenForSysex, listInputs, listOutputs, requestMidi, sendRaw, type MidiPort } from './webmidi.ts';

export const FM1_VOICE_LENGTH = 155;
const CMD_READ = 0x23;
const SUBCMD_VOICE = 5;
/** Vendor frame header, then the request's own eight-byte sub-header, echoed. */
const REPLY_HEADER = 14;

/** 8-bit bytes into 7-bit sysex data, as one little-endian bit stream. */
export function pack7(data: ArrayLike<number>): Uint8Array {
  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (let i = 0; i < data.length; i++) {
    buffer |= (data[i] & 0xff) << bits;
    bits += 8;
    while (bits >= 7) {
      out.push(buffer & 0x7f);
      buffer >>>= 7;
      bits -= 7;
    }
  }
  if (bits > 0) out.push(buffer & 0x7f);
  return Uint8Array.from(out);
}

/** The inverse. Trailing bits that do not make a whole byte are padding. */
export function unpack7(data: ArrayLike<number>): Uint8Array {
  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (let i = 0; i < data.length; i++) {
    buffer |= (data[i] & 0x7f) << bits;
    bits += 7;
    while (bits >= 8) {
      out.push(buffer & 0xff);
      buffer >>>= 8;
      bits -= 8;
    }
  }
  return Uint8Array.from(out);
}

function frame(cmd: number, payload: number[]): number[] {
  const n = payload.length;
  let sum = 0;
  for (const b of payload) sum = (sum + b) & 0xff;
  return [0x00, 0x59, cmd, n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, ...payload, sum ^ 0xff];
}

/** The complete sysex message asking for the current voice, F0 to F7. */
export function readVoiceRequest(): Uint8Array {
  const body = pack7(frame(CMD_READ, [SUBCMD_VOICE, 0, 0, 0, 0, FM1_VOICE_LENGTH, 0, 0]));
  return Uint8Array.from([0xf0, ...body, 0xf7]);
}

/**
 * The voice inside a reply, or null if this message is not one.
 *
 * Other sysex can arrive on the same port, so a reply is recognised by the
 * vendor header after unpacking and by being long enough to hold a voice.
 * The trailing checksum is not enforced: the reference reader ignores it, and
 * being stricter than the one implementation tested on hardware would risk
 * rejecting replies that are fine.
 */
export function parseReadVoiceReply(message: ArrayLike<number>): Uint8Array | null {
  let start = 0;
  let end = message.length;
  if (message[0] === 0xf0) start = 1;
  if (end > start && message[end - 1] === 0xf7) end -= 1;
  const body: number[] = [];
  for (let i = start; i < end; i++) body.push(message[i]);
  const data = unpack7(body);
  if (data.length < REPLY_HEADER + FM1_VOICE_LENGTH + 1) return null;
  if (data[0] !== 0x00 || data[1] !== 0x59) return null;
  return data.slice(REPLY_HEADER, REPLY_HEADER + FM1_VOICE_LENGTH);
}

const LOOKS_LIKE_FM1 = /fm-?1|m-?vave/i;

function fm1Port(ports: MidiPort[]): MidiPort | undefined {
  return ports.find((p) => LOOKS_LIKE_FM1.test(`${p.name} ${p.manufacturer}`));
}

/**
 * Ask the FM-1 for the sound it is playing and wait for the answer.
 *
 * Needs both directions - the question goes out and the voice comes back in -
 * so both ports are looked for by name. Gives up after a few seconds rather
 * than waiting forever: a synth on older firmware simply does not answer.
 */
export async function readFm1Voice(timeoutMs = 4000): Promise<Uint8Array> {
  let outs = listOutputs();
  if (outs.length === 0) {
    const state = await requestMidi();
    if (state.error) throw new Error(state.error);
    outs = state.outputs;
  }
  const out = fm1Port(outs);
  const input = fm1Port(listInputs());
  if (!out || !input) {
    throw new Error(!out && !input
      ? 'No FM-1 found. Connect it over USB and try again.'
      : `The FM-1 ${out ? 'input' : 'output'} port is missing - both directions are needed to read a voice.`);
  }

  return new Promise<Uint8Array>((resolve, reject) => {
    let done = false;
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      window.clearTimeout(timer);
      stop();
      fn();
    };
    const stop = listenForSysex(({ bytes, from }) => {
      // Only the FM-1's own replies; anything else on another port is ignored.
      if (!LOOKS_LIKE_FM1.test(from)) return;
      const voice = parseReadVoiceReply(bytes);
      if (voice) finish(() => resolve(voice));
    });
    const timer = window.setTimeout(() => finish(() => reject(new Error(
      'The FM-1 did not answer. Reading a voice is known to work on firmware V14 and V15.',
    ))), timeoutMs);
    try {
      sendRaw(out.id, readVoiceRequest());
    } catch (err) {
      finish(() => reject(err as Error));
    }
  });
}
