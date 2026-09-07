/*
 * Live polyphonic playing, for a MIDI keyboard.
 *
 * This is the one place the engine has to run in real time rather than offline,
 * so that pressing a key makes a sound now rather than after a render. It uses
 * a ScriptProcessorNode: deprecated, but it works identically in Vite's dev
 * server and in a production build, whereas an AudioWorklet needs the engine
 * bundled into a separate self-contained module and silently fails to load in
 * dev. At a 512-sample buffer the added latency is about 12 ms, which is fine
 * for auditioning patches.
 */
import { Dx7Note } from '../engine/dx7note.ts';
import { Lfo } from '../engine/lfo.ts';
import { N, initEngine } from '../engine/tables.ts';
import { P } from '../sysex/voice.ts';

const BUFFER_SIZE = 512;
const MAX_VOICES = 8;
/**
 * Unity, matching the offline render path. The makeup gain lives in the audio
 * graph so that summing several held notes cannot clip before the volume
 * control gets a chance to help.
 */
const GAIN = 1;

interface LiveVoice {
  note: Dx7Note;
  midi: number;
  released: boolean;
  age: number;
  /** 1 until the voice has settled into a drone, then ramps down to 0. */
  gain: number;
  /** Blocks rendered since key-up, for the hard ceiling on a release. */
  heldBlocks: number;
  /** Peak of the last block this voice rendered, 0 to 1. Read by the UI. */
  level: number;
}

/**
 * How long a drone takes to disappear once its release has finished.
 *
 * Long enough not to click, short enough that letting go of a key means the
 * note stops. See Dx7Note.settled for why this is needed at all: a patch with
 * a non-zero fourth envelope level sounds forever after key-up, which on the
 * hardware ends when the next note steals the voice. Here it would sit in the
 * pool sounding under everything you hovered next.
 */
const DRONE_FADE_SEC = 0.25;

/**
 * The longest a released voice may keep sounding before it is faded out
 * regardless of what its envelope is doing.
 *
 * The settled test alone is not quite enough: TRAIN's release runs for nearly
 * five seconds at close to full level before it settles, so on a real DX7 it
 * simply keeps going. Here that reads as a stuck note. Six seconds is longer
 * than any tail worth auditioning - the demo phrase is seven and a half in
 * total - and it puts a hard ceiling on how long a key you let go of can be
 * heard for.
 */
const MAX_RELEASE_SEC = 6;

export class LiveEngine {
  private ctx: AudioContext | null = null;
  private node: ScriptProcessorNode | null = null;
  private out: AudioNode | null = null;
  private voices: LiveVoice[] = [];
  private lfo = new Lfo();
  private patch: Uint8Array | null = null;
  private transpose = 0;
  private modWheel = 0;
  private pitchBase = 0;
  private buf = new Int32Array(N);
  /** For voices being faded, which have to be scaled before they are summed. */
  private scratch = new Int32Array(N);
  private ageCounter = 0;
  private lastActivity = 0;

  /** Epoch millis of the most recent note-on, for pausing the demo phrase. */
  get lastNoteAt(): number {
    return this.lastActivity;
  }

  get voiceCount(): number {
    return this.voices.length;
  }

  attach(ctx: AudioContext, destination: AudioNode): void {
    // Re-attach rather than bail out when the context has been replaced: the
    // node belongs to the old one and will never make a sound again.
    if (this.node && this.ctx === ctx && this.out === destination) return;
    if (this.node) this.detach();
    this.ctx = ctx;
    this.out = destination;
    initEngine(ctx.sampleRate);
    this.node = ctx.createScriptProcessor(BUFFER_SIZE, 0, 1);
    this.node.onaudioprocess = (ev) => this.process(ev);
    this.node.connect(destination);
  }

  detach(): void {
    if (!this.node) return;
    this.node.onaudioprocess = null;
    this.node.disconnect();
    this.node = null;
    this.voices = [];
  }

  /** The voice a keypress will play. Held notes keep the patch they started on. */
  setPatch(unpacked: Uint8Array | null): void {
    this.patch = unpacked ? Uint8Array.from(unpacked) : null;
    this.transpose = unpacked ? unpacked[P.transpose] - 24 : 0;
    if (unpacked) {
      this.lfo.reset(unpacked.subarray(137, 143));
    }
  }

  /**
   * How detuned the armed patch is, 0 to 1.
   *
   * The mean distance of its operators from centre detune, over the operators
   * that are actually making sound. This is the chorusing control, so a patch
   * with everything at centre is dead straight and one with operators pulled
   * both ways beats against itself - which is the thing worth drawing.
   */
  get patchDetune(): number {
    const v = this.patch;
    if (!v) return 0;
    let sum = 0;
    let count = 0;
    for (let op = 0; op < 6; op++) {
      const off = op * 21;
      if (v[off + 16] === 0) continue;
      sum += Math.abs(v[off + 20] - 7) / 7;
      count++;
    }
    return count ? sum / count : 0;
  }

  get hasPatch(): boolean {
    return this.patch !== null;
  }

  noteOn(midi: number, velocity: number): void {
    if (!this.patch) return;
    this.lastActivity = Date.now();
    if (velocity === 0) {
      this.noteOff(midi);
      return;
    }
    // Retrigger rather than stack when the same key arrives twice.
    this.noteOff(midi);
    if (this.voices.length >= MAX_VOICES) {
      let victim = 0;
      for (let i = 1; i < this.voices.length; i++) {
        const v = this.voices[i];
        const best = this.voices[victim];
        if ((v.released && !best.released) || (v.released === best.released && v.age < best.age)) victim = i;
      }
      this.voices.splice(victim, 1);
    }
    const note = new Dx7Note();
    note.init(this.patch, Math.max(0, Math.min(127, midi + this.transpose)), velocity);
    note.setModWheel(this.modWheel);
    this.voices.push({
      note, midi, released: false, age: ++this.ageCounter, gain: 1, heldBlocks: 0, level: 0,
    });
    this.lfo.keydown();
  }

  noteOff(midi: number): void {
    for (const v of this.voices) {
      if (v.midi === midi && !v.released) {
        v.note.keyup();
        v.released = true;
      }
    }
  }

  allNotesOff(): void {
    for (const v of this.voices) {
      if (!v.released) {
        v.note.keyup();
        v.released = true;
      }
    }
  }

  panic(): void {
    this.voices = [];
  }

  /**
   * Pitch bend, -1 to 1, scaled by the range in semitones.
   *
   * Global, as it is on the hardware: one value for every sounding voice,
   * applied to fixed-frequency operators as well as ratio ones. Stored as a
   * log-frequency offset so the audio thread does nothing but add it.
   */
  setPitchBend(value: number, semitones: number): void {
    const v = Math.max(-1, Math.min(1, value));
    this.pitchBase = Math.round((v * semitones * (1 << 24)) / 12);
  }

  get pitchBend(): number {
    return this.pitchBase;
  }

  /**
   * How loud the newest voice on this note is right now, 0 to 1.
   *
   * The level the engine measured on its last block, which is the envelope and
   * the algorithm and the velocity all together - what you are actually
   * hearing, rather than what the note was struck at.
   */
  levelOf(midi: number): number {
    for (let i = this.voices.length - 1; i >= 0; i--) {
      if (this.voices[i].midi === midi) return this.voices[i].level;
    }
    return 0;
  }

  setModWheel(value01: number): void {
    this.modWheel = Math.max(0, Math.min(1, value01));
    for (const v of this.voices) v.note.setModWheel(this.modWheel);
  }

  private process(ev: AudioProcessingEvent): void {
    const out = ev.outputBuffer.getChannelData(0);
    if (this.voices.length === 0) {
      out.fill(0);
      return;
    }
    const rate = this.ctx?.sampleRate ?? 44100;
    const fadeStep = N / (DRONE_FADE_SEC * rate);
    const maxBlocks = (MAX_RELEASE_SEC * rate) / N;
    for (let start = 0; start < out.length; start += N) {
      this.buf.fill(0);
      const lfoVal = this.lfo.getsample();
      const lfoDelay = this.lfo.getdelay();
      for (const v of this.voices) {
        if (v.released) v.heldBlocks++;
        if (v.released && v.gain === 1 && (v.note.settled || v.heldBlocks > maxBlocks)) v.gain -= fadeStep;
        // Every voice renders on its own and is then summed. It costs one more
        // pass over sixty-four samples and buys two things: the fade a droning
        // voice needs, and a per-voice level for the UI to draw. Knowing how
        // loud each note is right now is not something the mixed buffer can
        // say.
        this.scratch.fill(0);
        v.note.compute(this.scratch, lfoVal, lfoDelay, this.pitchBase);
        const g = Math.min(1, Math.max(0, v.gain));
        let peak = 0;
        for (let j = 0; j < N; j++) {
          const x = this.scratch[j];
          if (x > peak) peak = x;
          else if (-x > peak) peak = -x;
          this.buf[j] += g === 1 ? x : Math.round(x * g);
        }
        // The mixdown below is buf >> 4 >> 9 over 32768, so full scale is 2^28.
        v.level = Math.min(1, (peak / 268435456) * g);
        if (v.gain < 1) v.gain -= fadeStep;
      }
      for (let j = 0; j < N && start + j < out.length; j++) {
        const val = this.buf[j] >> 4;
        const clip = val < -(1 << 24) ? -32768 : val >= 1 << 24 ? 32767 : val >> 9;
        let f = (clip / 32768) * GAIN;
        if (f > 1) f = 1;
        else if (f < -1) f = -1;
        out[start + j] = f;
      }
    }
    for (let i = this.voices.length - 1; i >= 0; i--) {
      const v = this.voices[i];
      if (v.released && (!v.note.isPlaying() || v.gain <= 0)) this.voices.splice(i, 1);
    }
  }
}
