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

const F2 = 41;
const D3 = 50;
const F3 = 53;
const A3 = 57;
const C4 = 60;
const D4 = 62;
const E4 = 64;
const F4 = 65;
const G4 = 67;
const A4 = 69;
const C5 = 72;
const D5 = 74;
const C6 = 84;
const F6 = 89;

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
 * Everything here has to earn its place twice: once as a measurement, and once
 * as music. The measurement half is fixed - you cannot judge an FM patch
 * without hearing it low and high, alone and stacked, soft and hard, and with
 * the mod wheel up - and an earlier version of this satisfied that list
 * literally: one note, a low note, a high note, a triad, the same note five
 * times getting louder, a long note. It covered everything and sounded like a
 * hearing test, which matters more than it looks. You are going to hear this
 * several thousand times, and a phrase you cannot stand is a phrase you stop
 * listening to properly.
 *
 * So it is now an actual eight-second phrase in D minor, and the diagnostics
 * are carried by the music rather than laid out beside it:
 *
 *   the opening note      one clean strike, alone, because a sweep across the
 *                         map cuts within half a second
 *   a rising line         C-D-E up to F, which is the keyboard scaling you
 *                         would hear while playing rather than a step function
 *   F2 under the arrival  the low register, landing with the phrase rather
 *                         than sitting on its own like a test tone
 *   two high notes        the top of the keyboard, as a flick rather than a beep
 *   a spread Dm triad     how it stacks, and - because it is spread over 30 ms
 *                         like a hand - whether a slow attack smears it
 *   a Dm7 arpeggio        the velocity ramp. Rising pitch and rising velocity
 *                         together, which is what a crescendo actually is; the
 *                         dynamic range is still the full 24 to 120
 *   a held F4             the release tail, and the mod wheel sweep under it
 *
 * Nothing is played at the same pitch twice in a row, no two adjacent notes are
 * the same length, and the whole thing resolves. It is still a measurement.
 */
export const DEMO_PHRASE: Phrase = {
  id: 'demo-v10',
  label: 'demo phrase',
  notes: [
    // One note, alone, with a gap after it: brushing across the map cuts the
    // phrase almost immediately, and what you want to have heard in that
    // moment is one clean note.
    { at: 0.0, note: F4, velocity: MID, dur: 0.42 },
    // The line in. Short, short, longer - a shape rather than a pulse.
    { at: 0.54, note: C4, velocity: 62, dur: 0.2 },
    { at: 0.76, note: D4, velocity: 68, dur: 0.2 },
    { at: 0.98, note: E4, velocity: 76, dur: 0.28 },
    // The arrival, accented, with the bottom of the keyboard underneath it.
    // Level and brightness scaling at both extremes, in a phrase rather than
    // as two isolated notes.
    { at: 1.3, note: F4, velocity: 92, dur: 0.46 },
    { at: 1.3, note: F2, velocity: 84, dur: 0.82 },
    { at: 1.82, note: A4, velocity: 70, dur: 0.18 },
    { at: 2.04, note: G4, velocity: 64, dur: 0.22 },
    // The top of the keyboard, as a flick.
    { at: 2.32, note: F6, velocity: 58, dur: 0.14 },
    { at: 2.5, note: C6, velocity: 72, dur: 0.16 },
    // A triad: how it stacks. Three notes rather than four, because the DX7's
    // own output stage clips on a loud four-note chord for about one patch in
    // seven, and that distortion is baked into the render. Spread over thirty
    // milliseconds like a hand rather than a MIDI file, which is also
    // diagnostic: a slow attack smears the three into one swell.
    { at: 2.78, note: D3, velocity: MID, dur: 0.95 },
    { at: 2.81, note: F3, velocity: MID, dur: 0.92 },
    { at: 2.84, note: A3, velocity: MID, dur: 0.9 },
    // The velocity ramp, as a crescendo up a Dm7 rather than one pitch struck
    // five times. Same full range - 24 to 120 covers the whole response curve
    // - but it arrives as a phrase, and the rising pitch is what a player
    // would do to get louder anyway.
    { at: 3.95, note: D4, velocity: 24, dur: 0.15 },
    { at: 4.11, note: F4, velocity: 48, dur: 0.15 },
    { at: 4.27, note: A4, velocity: 72, dur: 0.15 },
    { at: 4.43, note: C5, velocity: 96, dur: 0.15 },
    { at: 4.59, note: D5, velocity: 120, dur: 0.3 },
    // The resolution, held long: the release tail, and the mod wheel sweep.
    { at: 5.05, note: F4, velocity: 74, dur: 2.5 },
  ],
  mod: [
    { at: 0.0, value: 0 },
    { at: 5.2, value: 0 },
    { at: 6.6, value: 1 },
    { at: 7.4, value: 0.15 },
  ],
  totalSec: 8.4,
};

/**
 * The opening of the demo phrase, for hovering.
 *
 * The same notes at the same moments as the start of DEMO_PHRASE, so brushing
 * a point and then clicking it gives the same opening twice rather than two
 * different impressions of the patch. Only the last note is allowed to ring
 * on, since nothing follows it here. It renders in a fifth of the time, which
 * is what keeps a sweep across the map ahead of the mouse.
 */
export const HOVER_PHRASE: Phrase = {
  id: 'hover-v8',
  label: 'hover taste',
  notes: [
    { at: 0.0, note: F4, velocity: MID, dur: 0.42 },
    { at: 0.54, note: C4, velocity: 62, dur: 0.2 },
    { at: 0.76, note: D4, velocity: 68, dur: 0.2 },
    { at: 0.98, note: E4, velocity: 76, dur: 0.45 },
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
