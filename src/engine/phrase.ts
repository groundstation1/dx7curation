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

const D2 = 38;
const A2 = 45;
const Bb2 = 46;
const D3 = 50;
const A3 = 57;
const C4 = 60;
const Cs4 = 61;
const D4 = 62;
const E4 = 64;
const F4 = 65;
const G4 = 67;
const A4 = 69;
const Bb4 = 70;
const C5 = 72;
const Cs5 = 73;
const D5 = 74;
const E5 = 76;
const F5 = 77;
const A5 = 81;
const D6 = 86;

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
 * Four bars in D minor at 112 BPM, on i - VI - V - i. Everything here has to
 * work twice: as a measurement, and as music.
 *
 * The measurement half is fixed. You cannot judge an FM patch without hearing
 * it low and high, alone and stacked, soft and hard, and with the mod wheel up.
 * Three earlier versions satisfied that list and still sounded wrong, for
 * reasons worth writing down, because they are the easy mistakes:
 *
 *   the first laid the tests out in order - one note, a low note, a high note,
 *   a triad, the same note five times getting louder, a long note. Complete,
 *   and a hearing test.
 *
 *   the second wrapped them in melody but kept a grid underneath: every run was
 *   evenly spaced, so it still ticked, and the seams between the tests were
 *   half-second holes that made it four exercises in a row.
 *
 *   the third fixed the rhythm and stayed on one chord for eight seconds, which
 *   is the thing that separates a phrase from a lick. Nothing moved underneath
 *   it, so nothing arrived.
 *
 * This one moves: D minor, down to the flat sixth, up to a major dominant - the
 * C# is the whole point, it is the one note outside the scale and it is what
 * makes the last bar sound like a return rather than a stop - and home. One
 * chord per bar, each anticipated by its bass note half a beat early, which is
 * what makes a change feel played rather than programmed.
 *
 * What each part still measures:
 *
 *   A-F-E-D falling         keyboard scaling across the middle, in a line
 *   Bb2 before bar 2        the bottom of the keyboard, anticipating rather
 *                           than sitting on its own
 *   C5-Bb-A-F5-D5-D6        the top, reached by leap
 *   spread A major triad    how it stacks, and the harmonic event at once; the
 *                           30 ms spread is diagnostic too, since a slow attack
 *                           smears three notes into one swell
 *   the rising figure       velocity, 28 through 120, as a crescendo up the
 *                           dominant rather than one pitch struck five times
 *   the held Dm triad       the release tail, under the mod wheel sweep
 *
 * Never more than three notes at once: the DX7's output stage clips on a loud
 * four-note chord for about one patch in seven, and that distortion would be
 * baked into every measurement taken from the render. Velocities sit in the
 * 45-75 range except where the crescendo deliberately leaves it, because the
 * velocity lookup is heavily compressed at the top and a phrase played at 100
 * throughout gives a bright, hard impression of every patch in the corpus.
 */
export const DEMO_PHRASE: Phrase = {
  id: 'demo-v12',
  label: 'demo phrase',
  notes: [
    // Bar 1 - D minor. One note, alone, then the answer entering off the beat.
    // No bass here: bar 1 being thin is what makes bar 2 arrive.
    { at: 0.0, note: A4, velocity: 62, dur: 0.46 },
    { at: 0.804, note: F4, velocity: 52, dur: 0.25 },
    { at: 1.072, note: E4, velocity: 58, dur: 0.25 },
    { at: 1.339, note: D4, velocity: 70, dur: 0.54 },

    // Bar 2 - B flat, the flat sixth. The bass gets there half a beat early,
    // which is the difference between a phrase and a grid.
    { at: 1.875, note: Bb2, velocity: 66, dur: 0.78 },
    { at: 2.143, note: C5, velocity: 60, dur: 0.25 },
    { at: 2.411, note: A4, velocity: 50, dur: 0.25 },
    { at: 2.679, note: Bb4, velocity: 68, dur: 0.4 },
    { at: 3.08, note: A4, velocity: 54, dur: 0.13 },
    { at: 3.214, note: F5, velocity: 74, dur: 0.13 },
    { at: 3.348, note: D5, velocity: 62, dur: 0.13 },
    { at: 3.482, note: D6, velocity: 48, dur: 0.2 },

    // Bar 3 - A major. The dominant, and the only accidental in the piece: that
    // C# is what the whole phrase has been leaning towards.
    { at: 3.75, note: A2, velocity: 64, dur: 0.52 },
    { at: 4.286, note: A3, velocity: 58, dur: 0.88 },
    { at: 4.316, note: Cs4, velocity: 58, dur: 0.86 },
    { at: 4.346, note: E4, velocity: 58, dur: 0.84 },
    // A breath, then the crescendo climbs the dominant: three sixteenths and an
    // eighth, twice. The whole velocity curve, with a shape.
    { at: 5.357, note: E4, velocity: 28, dur: 0.13 },
    { at: 5.491, note: G4, velocity: 45, dur: 0.13 },
    { at: 5.625, note: A4, velocity: 62, dur: 0.13 },
    { at: 5.759, note: Cs5, velocity: 82, dur: 0.26 },
    { at: 6.027, note: E5, velocity: 100, dur: 0.13 },
    { at: 6.161, note: A5, velocity: 120, dur: 0.26 },

    // Bar 4 - home. The full triad, held under the mod wheel.
    { at: 6.429, note: D3, velocity: 58, dur: 2.2 },
    { at: 6.459, note: A3, velocity: 54, dur: 2.2 },
    { at: 6.489, note: F4, velocity: 62, dur: 2.2 },
  ],
  mod: [
    { at: 0.0, value: 0 },
    { at: 6.6, value: 0 },
    { at: 8.0, value: 1 },
    { at: 8.8, value: 0.15 },
  ],
  totalSec: 9.2,
};

/**
 * The opening of the demo phrase, for hovering.
 *
 * Bar one, note for note, so brushing a point and then clicking it gives the
 * same opening twice rather than two different impressions of the patch. Only
 * the last note is allowed to ring on, since nothing follows it here. It
 * renders in a fifth of the time, which is what keeps a sweep across the map
 * ahead of the mouse.
 */
export const HOVER_PHRASE: Phrase = {
  id: 'hover-v10',
  label: 'hover taste',
  notes: [
    { at: 0.0, note: A4, velocity: 62, dur: 0.46 },
    { at: 0.804, note: F4, velocity: 52, dur: 0.25 },
    { at: 1.072, note: E4, velocity: 58, dur: 0.25 },
    { at: 1.339, note: D4, velocity: 70, dur: 0.6 },
  ],
  mod: [{ at: 0, value: 0 }],
  totalSec: 2.3,
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
