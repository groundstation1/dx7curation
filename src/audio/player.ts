/*
 * Playback.
 *
 * Rendering is offline and effectively instant, so auditioning is
 * render-then-play rather than a live synth voice. That has two useful
 * consequences: what the user hears is bit-identical to what the feature
 * extractor measured, and an A/B switch can be sample-accurate because both
 * sides already exist as buffers.
 *
 * Live playing from a MIDI keyboard is a different problem and lives in
 * liveEngine.ts, which shares the master gain declared here.
 */
import type { AuditionRequest, AuditionResponse } from '../workers/audition.worker.ts';
import { DEMO_PHRASE, type Phrase } from '../engine/phrase.ts';

/**
 * Rendering happens at unity.
 *
 * The makeup gain that brings Dexed's quiet unity level up to something useful
 * used to be applied inside the render, before the engine's hard clip. That
 * baked the clipping into the buffer, so a four-note chord distorted and the
 * volume knob - a separate node further down the graph - could not undo it. The
 * makeup now lives in the audio graph instead, where turning the volume down
 * genuinely helps.
 */
const RENDER_GAIN = 1;

/**
 * Makeup gain applied in the graph, ahead of the soft clip.
 *
 * Kept modest on purpose: the loudest factory patch peaks near 0.5 at unity and
 * the quietest is twenty times below that, and those differences are worth
 * hearing when you are deciding between patches. A bigger makeup would push
 * everything into the limiter and flatten exactly the distinction you are
 * listening for.
 */
const MAKEUP_GAIN = 1.8;

/** Fade applied when a sound is cut off, to avoid a click. */
const CUT_FADE_SEC = 0.012;

export const DEFAULT_VOLUME = 0.7;

/** What may start playing without being asked for. */
export type AutoPlay = 'never' | 'click' | 'hover';
export const AUTO_PLAY_LABELS: Record<AutoPlay, string> = {
  never: 'never',
  click: 'on click',
  hover: 'on hover',
};

/**
 * Linear up to 0.9, then asymptotic. Everything that is not actually about to
 * clip passes through unchanged, so dynamics are untouched.
 */
function softClipCurve(size = 4096): Float32Array<ArrayBuffer> {
  const curve = new Float32Array(new ArrayBuffer(size * 4));
  const knee = 0.9;
  for (let i = 0; i < size; i++) {
    const x = (i / (size - 1)) * 2 - 1;
    const a = Math.abs(x);
    const y = a <= knee ? a : knee + (1 - knee) * Math.tanh((a - knee) / (1 - knee));
    curve[i] = x < 0 ? -y : y;
  }
  return curve;
}

export class Player {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private softClip: WaveShaperNode | null = null;
  private volumeNode: GainNode | null = null;
  private worker: Worker;
  private token = 0;
  private pending = new Map<number, (r: AuditionResponse) => void>();
  private current: {
    source: AudioBufferSourceNode; gain: GainNode; id: number;
    startedAt: number; offset: number; key: string;
  } | null = null;
  private sourceSeq = 0;
  private cache = new Map<string, AudioBuffer>();
  private cacheOrder: string[] = [];
  private cacheLimit = 48;
  private volume = DEFAULT_VOLUME;
  private muted = false;
  /**
   * How far the app is allowed to go in playing things you did not ask for.
   *
   *   hover  sweeping the map plays what is under the cursor
   *   click  only a deliberate act - landing on a patch, advancing the rating
   *          queue, loading a face-off pair - starts a sound
   *   never  nothing plays by itself
   *
   * Three settings rather than a switch because the middle one is the one most
   * people actually want and it did not exist: hover auditions are wonderful
   * for exploring and maddening while reading, but turning them off used to
   * take the rating queue's own playback with them.
   *
   * Explicit play - a Play button, the space bar, the MIDI keyboard - ignores
   * this entirely.
   */
  autoPlay: AutoPlay = 'hover';

  /** Whether a sound of this kind may start right now. */
  mayPlay(kind: 'click' | 'hover'): boolean {
    if (this.autoPlay === 'never') return false;
    return this.autoPlay === 'hover' || kind === 'click';
  }

  constructor() {
    this.worker = new Worker(new URL('../workers/audition.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (ev: MessageEvent<AuditionResponse>) => {
      const resolve = this.pending.get(ev.data.token);
      if (resolve) {
        this.pending.delete(ev.data.token);
        resolve(ev.data);
      }
    };
  }

  /**
   * Must be called from a user gesture before any sound will play.
   *
   * The chain is makeup -> soft clip -> volume -> out.
   *
   * This used to be a DynamicsCompressor, on the reasoning that patch levels
   * across a corpus this size vary by more than 20 dB and something should
   * catch the loud ones. That was a mistake: a compressor pulls loud sounds
   * down towards quiet ones, which is precisely what velocity response is, so
   * the demo phrase's soft note and hard note came out at nearly the same
   * level and every patch sounded like it was being played flat out.
   *
   * A waveshaper cannot do that. It is memoryless - each sample is mapped
   * through a fixed curve with no gain that varies over time - so a quiet note
   * passes through completely untouched no matter what came before it. All it
   * does is round off the handful of peaks that would otherwise clip.
   */
  async unlock(): Promise<void> {
    // A context whose device has gone away - an audio driver crash, a USB
    // interface unplugged - ends up closed, and every node hanging off it is
    // dead with it. Nothing revives it, so build a fresh one; without this the
    // only cure is a page reload, which is not obvious when the symptom is
    // simply that the app went quiet.
    if (this.ctx && this.ctx.state === 'closed') {
      this.current = null;
      this.ctx = null;
    }
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.master = this.ctx.createGain();
      this.master.gain.value = MAKEUP_GAIN;

      this.softClip = this.ctx.createWaveShaper();
      this.softClip.curve = softClipCurve();
      this.softClip.oversample = '2x';

      this.volumeNode = this.ctx.createGain();
      this.volumeNode.gain.value = this.muted ? 0 : this.volume;

      this.master.connect(this.softClip);
      this.softClip.connect(this.volumeNode);
      this.volumeNode.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') await this.ctx.resume();
  }

  get ready(): boolean {
    return this.ctx !== null && this.ctx.state === 'running';
  }

  get sampleRate(): number {
    return this.ctx?.sampleRate ?? 44100;
  }

  /** The node live MIDI playback should connect to. */
  get output(): GainNode | null {
    return this.master;
  }

  get context(): AudioContext | null {
    return this.ctx;
  }

  getVolume(): number {
    return this.volume;
  }

  setVolume(v: number): void {
    this.volume = Math.max(0, Math.min(1, v));
    this.applyVolume();
  }

  private applyVolume(): void {
    if (!this.volumeNode || !this.ctx) return;
    const target = this.muted ? 0 : this.volume;
    this.volumeNode.gain.setTargetAtTime(target, this.ctx.currentTime, 0.01);
  }

  /**
   * Silence, without losing the volume you had set.
   *
   * Muting also stops whatever is sounding rather than letting it play out
   * inaudibly: the point of reaching for mute is usually that something is
   * making a noise right now, and an audition that carries on silently would
   * come back the moment you unmuted.
   */
  setMuted(v: boolean): void {
    this.muted = v;
    if (v) this.stop();
    this.applyVolume();
  }

  get isMuted(): boolean {
    return this.muted;
  }

  private remember(key: string, buf: AudioBuffer): void {
    this.cache.set(key, buf);
    this.cacheOrder.push(key);
    while (this.cacheOrder.length > this.cacheLimit) {
      const drop = this.cacheOrder.shift();
      if (drop) this.cache.delete(drop);
    }
  }

  /**
   * Render a voice playing a phrase. `id` is only used as a cache key, so pass
   * something stable per voice.
   */
  async render(id: number | string, unpacked: Uint8Array, phrase: Phrase = DEMO_PHRASE): Promise<AudioBuffer> {
    await this.unlock();
    const key = `${id}|${phrase.id}`;
    const hit = this.cache.get(key);
    if (hit) return hit;

    const token = ++this.token;
    const request: AuditionRequest = {
      type: 'audition',
      token,
      // A copy, so the caller's record survives for later renders.
      unpacked: Uint8Array.from(unpacked),
      phrase,
      sampleRate: this.sampleRate,
      gain: RENDER_GAIN,
    };
    const response = await new Promise<AuditionResponse>((resolve) => {
      this.pending.set(token, resolve);
      this.worker.postMessage(request);
    });

    const ctx = this.ctx!;
    const buf = ctx.createBuffer(1, response.samples.length, response.sampleRate);
    buf.getChannelData(0).set(response.samples);
    this.remember(key, buf);
    return buf;
  }

  /** Stop whatever is sounding, with a short fade so it does not click. */
  stop(): void {
    if (!this.current || !this.ctx) return;
    const { source, gain } = this.current;
    const now = this.ctx.currentTime;
    // Detach the ended handler first: this source is about to end because we
    // are replacing it, and letting its callback run would clobber the state of
    // whatever starts next.
    source.onended = null;
    gain.gain.cancelScheduledValues(now);
    gain.gain.setValueAtTime(gain.gain.value, now);
    gain.gain.linearRampToValueAtTime(0, now + CUT_FADE_SEC);
    try {
      source.stop(now + CUT_FADE_SEC + 0.005);
    } catch {
      // Already stopped; nothing to do.
    }
    this.current = null;
  }

  /**
   * Play a buffer, cutting anything already sounding. `onEnded` only fires if
   * the buffer actually reaches its end, never when it is cut short.
   */
  playBuffer(
    buf: AudioBuffer, offsetSec = 0, onEnded?: () => void,
    opts: { loop?: boolean; key?: string } = {},
  ): AudioBufferSourceNode {
    this.stop();
    const ctx = this.ctx!;
    const id = ++this.sourceSeq;
    const source = ctx.createBufferSource();
    source.buffer = buf;
    source.loop = opts.loop ?? false;
    const gain = ctx.createGain();
    gain.gain.value = 1;
    source.connect(gain).connect(this.master!);
    source.onended = () => {
      if (this.current?.id === id) {
        this.current = null;
        onEnded?.();
      }
    };
    const offset = Math.max(0, Math.min(offsetSec, buf.duration - 0.005));
    source.start(ctx.currentTime, offset);
    this.current = { source, gain, id, startedAt: ctx.currentTime, offset, key: opts.key ?? '' };
    return source;
  }

  /** Seconds into the buffer that is sounding right now, or 0. */
  playbackPosition(): number {
    if (!this.current || !this.ctx) return 0;
    const buf = this.current.source.buffer;
    const elapsed = this.ctx.currentTime - this.current.startedAt + this.current.offset;
    if (!buf) return elapsed;
    return this.current.source.loop ? elapsed % buf.duration : elapsed;
  }

  get playingKey(): string {
    return this.current?.key ?? '';
  }

  /**
   * Render and play in one step. Returns false when a newer request superseded
   * this one, which is the normal case while sweeping across the map.
   */
  async audition(
    id: number | string, unpacked: Uint8Array, phrase: Phrase = DEMO_PHRASE,
    opts: { loop?: boolean } = {},
  ): Promise<boolean> {
    // Silence first, then render. Cutting the old sound only when the new
    // buffer arrives means a patch with a long tail - or a looping phrase -
    // keeps sounding over the gap, and if this render is superseded it never
    // gets cut at all. Rendering is fast enough that the gap is inaudible.
    this.stop();
    const myToken = this.token + 1;
    const buf = await this.render(id, unpacked, phrase);
    // Another audition started while this one was rendering.
    if (this.token > myToken) return false;
    this.playBuffer(buf, 0, undefined, { loop: opts.loop, key: `${id}|${phrase.id}` });
    return true;
  }

  /**
   * Play a short prefix straight away, then slide onto the full phrase without
   * a seam once it has rendered.
   *
   * The full phrase takes long enough to render that starting it cold would lag
   * behind a sweep across the map. The prefix is the same audio as the phrase's
   * opening, so when the full render lands it can be started at the position
   * the prefix has already reached and nothing is audible at the join. If the
   * pointer has moved on by then, the upgrade is simply dropped.
   */
  async auditionProgressive(
    id: number | string, unpacked: Uint8Array, quick: Phrase, full: Phrase,
    opts: { loop?: boolean } = {},
  ): Promise<void> {
    const quickKey = `${id}|${quick.id}`;
    const fullKey = `${id}|${full.id}`;
    this.stop();
    const myToken = this.token + 1;
    const quickBuf = await this.render(id, unpacked, quick);
    if (this.token > myToken) return;
    this.playBuffer(quickBuf, 0, undefined, { key: quickKey });

    const fullBuf = await this.render(id, unpacked, full);
    // Only upgrade if the prefix we started is still the thing playing.
    if (this.playingKey !== quickKey) return;
    const position = this.playbackPosition();
    if (position >= fullBuf.duration - 0.01) return;
    this.playBuffer(fullBuf, position, undefined, { loop: opts.loop, key: fullKey });
  }
}

/**
 * An A/B pair that can be switched mid-phrase. Both sides are rendered up front
 * and the playback position carries across the switch, so what changes is only
 * the sound - which is the only way release-tail differences are audible.
 *
 * Position is tracked against the AudioContext clock rather than
 * performance.now(): the two run at different rates, and the drift was enough
 * to make a switch late in a phrase land past the end of the buffer, where it
 * played silence and looked like a failure to trigger.
 */
export class AbPlayer {
  private a: AudioBuffer | null = null;
  private b: AudioBuffer | null = null;
  private startedAtCtxTime = 0;
  private startOffset = 0;
  private side: 'a' | 'b' = 'a';
  private playing = false;

  constructor(private player: Player) {}

  async load(
    idA: number | string, patchA: Uint8Array,
    idB: number | string, patchB: Uint8Array,
    phrase?: Phrase,
  ): Promise<void> {
    // The pair being replaced must not play on underneath the two renders.
    this.stop();
    this.a = await this.player.render(idA, patchA, phrase);
    this.b = await this.player.render(idB, patchB, phrase);
  }

  get currentSide(): 'a' | 'b' {
    return this.side;
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  private buffer(side: 'a' | 'b'): AudioBuffer | null {
    return side === 'a' ? this.a : this.b;
  }

  /** Seconds into the phrase, right now. */
  position(): number {
    const ctx = this.player.context;
    if (!this.playing || !ctx) return 0;
    return ctx.currentTime - this.startedAtCtxTime + this.startOffset;
  }

  start(side: 'a' | 'b' = this.side, offsetSec = 0): void {
    const buf = this.buffer(side);
    const ctx = this.player.context;
    if (!buf || !ctx) return;
    this.side = side;
    this.startOffset = offsetSec;
    this.startedAtCtxTime = ctx.currentTime;
    this.playing = true;
    this.player.playBuffer(buf, offsetSec, () => {
      this.playing = false;
    });
  }

  /**
   * Swap sides at the current playback position. If the phrase has already run
   * out, this starts the other side from the top instead of dropping the
   * playhead into silence past the end of the buffer.
   */
  toggle(): 'a' | 'b' {
    const next = this.side === 'a' ? 'b' : 'a';
    const buf = this.buffer(next);
    if (!buf) return this.side;
    const elapsed = this.position();
    const offset = this.playing && elapsed < buf.duration - 0.05 ? Math.max(0, elapsed) : 0;
    this.start(next, offset);
    return next;
  }

  restart(): void {
    this.start(this.side, 0);
  }

  stop(): void {
    this.playing = false;
    this.player.stop();
  }
}
