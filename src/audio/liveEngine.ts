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
}

export class LiveEngine {
  private ctx: AudioContext | null = null;
  private node: ScriptProcessorNode | null = null;
  private out: AudioNode | null = null;
  private voices: LiveVoice[] = [];
  private lfo = new Lfo();
  private patch: Uint8Array | null = null;
  private transpose = 0;
  private modWheel = 0;
  private buf = new Int32Array(N);
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
    if (this.node) return;
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
    this.voices.push({ note, midi, released: false, age: ++this.ageCounter });
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
    for (let start = 0; start < out.length; start += N) {
      this.buf.fill(0);
      const lfoVal = this.lfo.getsample();
      const lfoDelay = this.lfo.getdelay();
      for (const v of this.voices) v.note.compute(this.buf, lfoVal, lfoDelay);
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
      if (this.voices[i].released && !this.voices[i].note.isPlaying()) this.voices.splice(i, 1);
    }
  }
}
