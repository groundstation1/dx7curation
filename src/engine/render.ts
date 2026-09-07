/*
 * Offline rendering of a single DX7 voice.
 *
 * The engine is a direct integer-DSP port, so rendering does not need Web Audio
 * at all: this runs identically in a worker, in the main thread and in Node.
 * For live auditioning the caller renders here and hands the Float32Array to an
 * AudioBufferSourceNode, which keeps preview and analysis bit-identical.
 */
import { Dx7Note } from './dx7note.ts';
import { Lfo } from './lfo.ts';
import { N, initEngine } from './tables.ts';

export interface RenderOptions {
  /** MIDI note before the voice transpose parameter is applied. */
  note: number;
  velocity: number;
  /** Seconds the key is held. */
  holdSec: number;
  /** Seconds captured after key-up. */
  releaseSec: number;
  sampleRate?: number;
  /** Linear gain applied to the engine output. 1 leaves Dexed unity levels. */
  gain?: number;
  /** Stop early once all carrier envelopes are finished. */
  earlyExit?: boolean;
  /** Mod wheel position, 0..1. Held constant for the whole render. */
  modWheel?: number;
}

export interface RenderResult {
  samples: Float32Array;
  sampleRate: number;
  /** Sample index of key-up. */
  releaseAt: number;
  peak: number;
}

/**
 * Convert one block of the engine's fixed-point bus to floats, the way Dexed
 * does: >> 4, hard clip at +/-2^24, >> 9 to 16 bits, then /0x8000. Dexed's
 * negative clip constant is +0x8000 (a sign bug that only shows up on extreme
 * overdrive); this clips symmetrically instead.
 */
function blockToFloat(buf: Int32Array, out: Float32Array, at: number, count: number, gain: number): number {
  let peak = 0;
  for (let j = 0; j < count; j++) {
    const val = buf[j] >> 4;
    const clip = val < -(1 << 24) ? -32768 : val >= 1 << 24 ? 32767 : val >> 9;
    let f = (clip / 32768) * gain;
    if (f > 1) f = 1;
    else if (f < -1) f = -1;
    out[at + j] = f;
    const a = f < 0 ? -f : f;
    if (a > peak) peak = a;
  }
  return peak;
}

export function renderVoice(patch: Uint8Array, opts: RenderOptions): RenderResult {
  const sampleRate = opts.sampleRate ?? 44100;
  const gain = opts.gain ?? 1;
  initEngine(sampleRate);

  const holdBlocks = Math.max(1, Math.round((opts.holdSec * sampleRate) / N));
  const relBlocks = Math.max(1, Math.round((opts.releaseSec * sampleRate) / N));
  const totalBlocks = holdBlocks + relBlocks;
  const out = new Float32Array(totalBlocks * N);

  const transposed = Math.max(0, Math.min(127, opts.note + patch[144] - 24));

  const lfo = new Lfo();
  lfo.reset(patch.subarray(137, 143));
  lfo.keydown();

  const note = new Dx7Note();
  note.init(patch, transposed, opts.velocity);
  if (opts.modWheel) note.setModWheel(opts.modWheel);

  const buf = new Int32Array(N);
  let peak = 0;
  let released = false;
  let quietBlocks = 0;

  for (let b = 0; b < totalBlocks; b++) {
    if (b === holdBlocks) {
      note.keyup();
      released = true;
    }
    buf.fill(0);
    const lfoVal = lfo.getsample();
    const lfoDelay = lfo.getdelay();
    note.compute(buf, lfoVal, lfoDelay);
    const p = blockToFloat(buf, out, b * N, N, gain);
    if (p > peak) peak = p;

    if (opts.earlyExit && released) {
      // Two consecutive near-silent blocks after the carriers report done.
      if (p < 1e-5) {
        quietBlocks++;
        if (quietBlocks >= 2 && !note.isPlaying()) break;
      } else {
        quietBlocks = 0;
      }
    }
  }

  return { samples: out, sampleRate, releaseAt: holdBlocks * N, peak };
}

/** Minimal 16-bit mono WAV encoder, for eyeballing renders outside the app. */
export function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array {
  const bytes = new Uint8Array(44 + samples.length * 2);
  const dv = new DataView(bytes.buffer);
  const ascii = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) bytes[off + i] = s.charCodeAt(i);
  };
  ascii(0, 'RIFF');
  dv.setUint32(4, 36 + samples.length * 2, true);
  ascii(8, 'WAVEfmt ');
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);
  dv.setUint16(22, 1, true);
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate * 2, true);
  dv.setUint16(32, 2, true);
  dv.setUint16(34, 16, true);
  ascii(36, 'data');
  dv.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    dv.setInt16(44 + i * 2, Math.round(s * 32767), true);
  }
  return bytes;
}
