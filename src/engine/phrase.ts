/*
 * Polyphonic phrase rendering.
 *
 * A single held note tells you less about a patch than a few seconds of it
 * being played: repeated strikes show the retrigger behaviour, low and high
 * notes show the keyboard scaling, two velocities show the velocity response, a
 * chord shows how it stacks, and a long held note with the mod wheel swept
 * shows what the LFO is set up to do. The demo phrase below walks through all
 * of those in under eight seconds.
 *
 * Voices are independent Dx7Note instances mixed into one bus, the way Dexed
 * does it, sharing a single LFO.
 */
import { Dx7Note } from './dx7note.ts';
import { Lfo } from './lfo.ts';
import { N, initEngine } from './tables.ts';
import { P } from '../sysex/voice.ts';

export interface PhraseNote {
  /** Seconds from the start of the phrase. */
  at: number;
  note: number;
  velocity: number;
  /** Seconds the key is held. */
  dur: number;
}

export interface ModPoint {
  at: number;
  /** Mod wheel position, 0..1. */
  value: number;
}

export interface Phrase {
  id: string;
  label: string;
  notes: PhraseNote[];
  mod: ModPoint[];
  /** Total rendered length including the tail after the last key-up. */
  totalSec: number;
}

const C2 = 36;
const A3 = 57;
const C4 = 60;
const E4 = 64;
const G4 = 67;
const C5 = 72;
const C6 = 84;

/**
 * The velocity everything not demonstrating velocity is played at.
 *
 * 45, not 64, and definitely not 70. The DX7 runs velocity through a lookup
 * that is heavily compressed at the top: velocity 70 already sits 73% of the
 * way up its response and 100 sits at 91%, so anything in that region gives a
 * bright, hard impression of every patch in the corpus. The actual midpoint of
 * the curve is 42.
 */
const MID = 45;

/**
 * The audition phrase.
 *
 * The opening note is held longer than the rest and followed by a clear gap,
 * because the most common way this gets used is swiping across the map: the cut
 * comes almost immediately, and what you want to have heard in that moment is
 * one clean note, not the front half of a triplet. Nothing else starts until
 * 0.7 s, so even a slow sweep still gives one note per patch.
 */
export const DEMO_PHRASE: Phrase = {
  id: 'demo-v7',
  label: 'demo phrase',
  notes: [
    // Everything that is not explicitly demonstrating velocity sits at a mid
    // velocity. This matters more than it looks: on FM, velocity does not just
    // set the level, it drives the modulators, so a note at 127 has audibly
    // more sidebands than the same note at 70. A phrase played flat out gives
    // a bright, hard, resonant impression of every patch in the corpus - which
    // is not what any of them sound like when you actually play them.
    { at: 0.0, note: C4, velocity: MID, dur: 0.35 },
    // Repeated strikes: how the patch retriggers.
    { at: 0.7, note: C4, velocity: MID, dur: 0.11 },
    { at: 0.85, note: C4, velocity: MID, dur: 0.14 },
    // Bottom and top of the keyboard: level and brightness scaling.
    { at: 1.05, note: C2, velocity: MID, dur: 0.24 },
    { at: 1.34, note: C6, velocity: MID, dur: 0.24 },
    // A velocity ramp on short notes, which shows the whole response curve
    // rather than just its two ends.
    { at: 1.63, note: C4, velocity: 20, dur: 0.13 },
    { at: 1.79, note: C4, velocity: 45, dur: 0.13 },
    { at: 1.95, note: C4, velocity: 70, dur: 0.13 },
    { at: 2.11, note: C4, velocity: 95, dur: 0.13 },
    { at: 2.27, note: C4, velocity: 120, dur: 0.13 },
    // A triad: how it stacks. Three notes rather than four, because the DX7's
    // own output stage clips on a loud four-note chord for about one patch in
    // seven, and that distortion is baked into the render.
    { at: 2.5, note: C4, velocity: MID, dur: 1.3 },
    { at: 2.5, note: E4, velocity: MID, dur: 1.3 },
    { at: 2.5, note: G4, velocity: MID, dur: 1.3 },
    // A long held note under a mod wheel sweep: what the LFO is set up to do.
    { at: 3.95, note: A3, velocity: MID, dur: 2.2 },
  ],
  mod: [
    { at: 0.0, value: 0 },
    { at: 3.9, value: 0 },
    { at: 5.7, value: 1 },
    { at: 6.4, value: 0.1 },
  ],
  totalSec: 7.7,
};

/**
 * The opening of the demo phrase, for hovering.
 *
 * Byte-identical to the first 2.0 seconds of DEMO_PHRASE, so brushing a point
 * and then clicking it gives the same attack twice rather than two different
 * impressions of the patch. It renders in a fifth of the time, which is what
 * keeps a sweep across the map ahead of the mouse.
 */
export const HOVER_PHRASE: Phrase = {
  id: 'hover-v5',
  label: 'hover taste',
  notes: [
    { at: 0.0, note: C4, velocity: MID, dur: 0.35 },
    { at: 0.7, note: C4, velocity: MID, dur: 0.11 },
    { at: 0.85, note: C4, velocity: MID, dur: 0.4 },
  ],
  mod: [{ at: 0, value: 0 }],
  totalSec: 2.0,
};

/** Just the opening strike, for a fast single-shot audition. */
export const SINGLE_NOTE_PHRASE: Phrase = {
  id: 'single-v1',
  label: 'one note',
  notes: [{ at: 0, note: C4, velocity: 100, dur: 1.0 }],
  mod: [{ at: 0, value: 0 }],
  totalSec: 2.0,
};

export function singleNotePhrase(note: number, velocity: number, holdSec = 1, tailSec = 1): Phrase {
  return {
    id: `note-${note}-${velocity}-${holdSec}-${tailSec}`,
    label: `note ${note}`,
    notes: [{ at: 0, note, velocity, dur: holdSec }],
    mod: [{ at: 0, value: 0 }],
    totalSec: holdSec + tailSec,
  };
}

function modAt(mod: ModPoint[], t: number): number {
  if (mod.length === 0) return 0;
  if (t <= mod[0].at) return mod[0].value;
  for (let i = 1; i < mod.length; i++) {
    if (t <= mod[i].at) {
      const a = mod[i - 1];
      const b = mod[i];
      const span = b.at - a.at;
      const k = span > 0 ? (t - a.at) / span : 1;
      return a.value + (b.value - a.value) * k;
    }
  }
  return mod[mod.length - 1].value;
}

export interface PhraseRenderOptions {
  sampleRate?: number;
  gain?: number;
  /** Cap on simultaneous voices; the oldest is dropped past this. */
  maxVoices?: number;
}

export interface PhraseRenderResult {
  samples: Float32Array;
  sampleRate: number;
  peak: number;
}

interface ActiveVoice {
  note: Dx7Note;
  offBlock: number;
  released: boolean;
  startedBlock: number;
}

export function renderPhrase(
  patch: Uint8Array, phrase: Phrase, opts: PhraseRenderOptions = {},
): PhraseRenderResult {
  const sampleRate = opts.sampleRate ?? 44100;
  const gain = opts.gain ?? 1;
  const maxVoices = opts.maxVoices ?? 8;
  initEngine(sampleRate);

  const blocks = Math.max(1, Math.ceil((phrase.totalSec * sampleRate) / N));
  const out = new Float32Array(blocks * N);
  const buf = new Int32Array(N);
  const blockSec = N / sampleRate;

  const lfo = new Lfo();
  lfo.reset(patch.subarray(137, 143));
  lfo.keydown();

  const transpose = patch[P.transpose] - 24;
  const pending = [...phrase.notes]
    .map((n) => ({ ...n, onBlock: Math.round((n.at * sampleRate) / N), offBlock: Math.round(((n.at + n.dur) * sampleRate) / N) }))
    .sort((a, b) => a.onBlock - b.onBlock);
  let nextNote = 0;
  const active: ActiveVoice[] = [];

  let peak = 0;

  for (let b = 0; b < blocks; b++) {
    // ---- note ons ----
    while (nextNote < pending.length && pending[nextNote].onBlock <= b) {
      const spec = pending[nextNote++];
      const midi = Math.max(0, Math.min(127, spec.note + transpose));
      const voice = new Dx7Note();
      voice.init(patch, midi, spec.velocity);
      active.push({ note: voice, offBlock: spec.offBlock, released: false, startedBlock: b });
      lfo.keydown();
      while (active.length > maxVoices) active.shift();
    }

    // ---- note offs ----
    for (const v of active) {
      if (!v.released && b >= v.offBlock) {
        v.note.keyup();
        v.released = true;
      }
    }

    // ---- mod wheel ----
    const mod = modAt(phrase.mod, b * blockSec);
    for (const v of active) v.note.setModWheel(mod);

    // ---- render ----
    buf.fill(0);
    const lfoVal = lfo.getsample();
    const lfoDelay = lfo.getdelay();
    for (const v of active) v.note.compute(buf, lfoVal, lfoDelay);

    const at = b * N;
    for (let j = 0; j < N; j++) {
      const val = buf[j] >> 4;
      const clip = val < -(1 << 24) ? -32768 : val >= 1 << 24 ? 32767 : val >> 9;
      let f = (clip / 32768) * gain;
      if (f > 1) f = 1;
      else if (f < -1) f = -1;
      out[at + j] = f;
      const a = f < 0 ? -f : f;
      if (a > peak) peak = a;
    }

    // ---- retire finished voices ----
    for (let i = active.length - 1; i >= 0; i--) {
      if (active[i].released && !active[i].note.isPlaying()) active.splice(i, 1);
    }
  }

  return { samples: out, sampleRate, peak };
}
