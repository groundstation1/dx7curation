/*
 * The MIDI keyboard: plays whatever voice is currently under the cursor or
 * selected, live.
 *
 * Also the reason the demo phrase knows to get out of the way. Once you start
 * playing, an audition firing underneath you is just noise, so any note-on
 * suppresses the phrase until you stop.
 */
import { LiveEngine } from './liveEngine.ts';
import type { Player } from './player.ts';
import { attachInputs, listInputs, midiSupported, onPortsChanged, requestMidi, type MidiPort } from '../midi/webmidi.ts';

/** How long after the last played note the demo phrase stays out of the way. */
export const PLAY_SUPPRESSION_MS = 2500;

/**
 * Default dead zone at the bottom of the mod wheel's travel.
 *
 * A wheel that does not quite return to zero, or a knob brushed in passing,
 * otherwise sits at CC 2 or 3 permanently and quietly detunes or wobbles
 * everything you audition - which is very hard to notice and very confusing
 * once you do. Below this fraction the wheel reads as off, and the remaining
 * travel is rescaled so full deflection still reaches 1.
 */
export const DEFAULT_MOD_DEADZONE = 0.06;

export class Keyboard {
  readonly engine = new LiveEngine();
  private detach: (() => void) | null = null;
  private player: Player | null = null;
  private listeners = new Set<() => void>();
  inputs: MidiPort[] = [];
  connected = false;
  error = '';
  /** The value actually applied, after the dead zone. */
  modWheel = 0;
  /** The raw controller value, so the UI can show what the hardware is sending. */
  modWheelRaw = 0;
  modDeadzone = DEFAULT_MOD_DEADZONE;

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  get supported(): boolean {
    return midiSupported();
  }

  /** True while the user is playing, so auditions should hold off. */
  get playing(): boolean {
    return Date.now() - this.engine.lastNoteAt < PLAY_SUPPRESSION_MS;
  }

  /**
   * Keep the engine on whatever context the player is currently using.
   *
   * The player rebuilds its context if the browser closes it, which leaves the
   * engine's node attached to a corpse - the keyboard would look connected and
   * make no sound.
   */
  private ensureEngine(): void {
    const player = this.player;
    if (!player) return;
    if (!player.ready) {
      void player.unlock().then(() => this.ensureEngine());
      return;
    }
    const ctx = player.context;
    const out = player.output;
    if (ctx && out) this.engine.attach(ctx, out);
  }

  async connect(player: Player): Promise<void> {
    this.player = player;
    await player.unlock();
    const ctx = player.context;
    const out = player.output;
    if (!ctx || !out) return;
    this.engine.attach(ctx, out);

    const state = await requestMidi();
    this.inputs = listInputs();
    if (!state.granted) {
      this.error = state.error ?? 'MIDI access was refused';
      this.connected = false;
      this.emit();
      return;
    }
    this.error = this.inputs.length ? '' : 'No MIDI inputs found. Connect a keyboard and press Connect again.';
    this.detach?.();
    this.detach = attachInputs({
      noteOn: (note, velocity) => {
        // Anything sounding from an audition is in the way now.
        this.player?.stop();
        this.ensureEngine();
        this.engine.noteOn(note, velocity);
      },
      noteOff: (note) => this.engine.noteOff(note),
      modWheel: (raw) => {
        this.modWheelRaw = raw;
        const value = raw <= this.modDeadzone
          ? 0
          : Math.min(1, (raw - this.modDeadzone) / (1 - this.modDeadzone));
        if (Math.abs(value - this.modWheel) < 0.002) return;
        this.modWheel = value;
        this.engine.setModWheel(value);
        this.emit();
      },
      allNotesOff: () => this.engine.allNotesOff(),
    });
    this.connected = true;
    // Keyboards get plugged in after the page loads more often than not.
    onPortsChanged(() => {
      const before = this.inputs.length;
      this.inputs = listInputs();
      if (this.inputs.length !== before && this.player) void this.connect(this.player);
      else this.emit();
    });
    this.emit();
  }

  setModDeadzone(v: number): void {
    this.modDeadzone = Math.max(0, Math.min(0.5, v));
    // Re-apply, so raising the dead zone past where the wheel is resting
    // silences it immediately rather than at the next twitch.
    const raw = this.modWheelRaw;
    const value = raw <= this.modDeadzone ? 0 : Math.min(1, (raw - this.modDeadzone) / (1 - this.modDeadzone));
    this.modWheel = value;
    this.engine.setModWheel(value);
    this.emit();
  }

  /**
   * Connect without asking, but only if permission has already been granted.
   *
   * Browsers remember a sysex grant per origin, so after the first explicit
   * Connect the keyboard can simply be there on every subsequent load. Querying
   * the permission first is what keeps this from throwing a prompt at someone
   * who has never asked for MIDI and may not own a keyboard.
   */
  async autoConnect(player: Player): Promise<boolean> {
    if (!midiSupported() || this.connected) return false;
    try {
      const perms = (navigator as unknown as {
        permissions?: { query(d: { name: string; sysex?: boolean }): Promise<{ state: string }> };
      }).permissions;
      if (!perms) return false;
      const status = await perms.query({ name: 'midi', sysex: true });
      if (status.state !== 'granted') return false;
    } catch {
      // Firefox and Safari reject the midi permission name outright; there is
      // nothing to auto-connect to there anyway.
      return false;
    }
    await this.connect(player);
    return this.connected;
  }

  /** The voice the next key press will sound. */
  setPatch(unpacked: Uint8Array | null): void {
    this.engine.setPatch(unpacked);
  }

  disconnect(): void {
    this.detach?.();
    this.detach = null;
    this.engine.allNotesOff();
    this.connected = false;
    this.emit();
  }
}

export const keyboard = new Keyboard();
