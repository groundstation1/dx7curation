/*
 * The computer keyboard as an instrument.
 *
 * Auditioning tells you what a patch does when it is played the way the demo
 * phrase plays it. Playing it yourself tells you what it does under your
 * hands, and that is a different judgement - but it required owning a MIDI
 * keyboard and having it plugged in, which is a high price for "what does this
 * bass do an octave down".
 *
 * Two rows, chromatic, in the arrangement every tracker and DAW has used for
 * thirty years: the bottom row is the white keys, the row above it carries the
 * black keys in the gaps, and it runs an octave and a bit before you shift.
 *
 * Keys are read by physical position (`KeyboardEvent.code`), never by the
 * character they produce. That is not a shortcut - it is the only mapping that
 * is correct on more than one layout. `code` says "the key where Z is on a US
 * board", so the piano stays a piano on QWERTZ, AZERTY, Dvorak and Neo 2,
 * where the letters printed on those keys are completely different. The layout
 * setting therefore changes only what the on-screen legend prints, which is the
 * one thing the browser genuinely cannot work out for itself.
 */
import type { Keyboard } from './keyboard.ts';
import type { Player } from './player.ts';
import { getSetting, setSetting } from '../ui/settings.ts';

/**
 * Physical key to semitone, relative to the current base octave.
 *
 * Deliberately stops short of the number row and the top letter row. Those
 * would add a second octave, and they would also take 1-5 (rate), P (pin) and
 * space (audition) away from the app - and rating the patch you are playing is
 * the entire point of the screens this sits on. An octave shift costs one key
 * press and no shortcuts.
 */
const NOTES: Record<string, number> = {
  KeyZ: 0, KeyS: 1, KeyX: 2, KeyD: 3, KeyC: 4,
  KeyV: 5, KeyG: 6, KeyB: 7, KeyH: 8, KeyN: 9, KeyJ: 10, KeyM: 11,
  Comma: 12, KeyL: 13, Period: 14, Semicolon: 15, Slash: 16,
};

/** Physical keys that shift the octave, either side of the number row's end. */
const OCTAVE_DOWN = 'Minus';
const OCTAVE_UP = 'Equal';

/**
 * What is printed on those keys, per layout.
 *
 * Only ever used to draw the legend. Rows are in physical order starting from
 * the key at the left end of each row, so a layout is three strings.
 */
export interface KeyLayout {
  id: string;
  label: string;
  /** KeyA row, eleven keys from A to Quote. */
  home: string[];
  /** KeyZ row, ten keys from Z to Slash. */
  bottom: string[];
}

const ROW_HOME = ['KeyA', 'KeyS', 'KeyD', 'KeyF', 'KeyG', 'KeyH', 'KeyJ', 'KeyK', 'KeyL', 'Semicolon', 'Quote'];
const ROW_BOTTOM = ['KeyZ', 'KeyX', 'KeyC', 'KeyV', 'KeyB', 'KeyN', 'KeyM', 'Comma', 'Period', 'Slash'];

export const LAYOUTS: KeyLayout[] = [
  {
    id: 'qwerty', label: 'QWERTY',
    home: [...'asdfghjkl;\''],
    bottom: [...'zxcvbnm,./'],
  },
  {
    id: 'qwertz', label: 'QWERTZ (German)',
    home: [...'asdfghjkl', 'ö', 'ä'],
    bottom: [...'yxcvbnm,.-'],
  },
  {
    id: 'azerty', label: 'AZERTY (French)',
    home: [...'qsdfghjklm', 'ù'],
    bottom: [...'wxcvbn,;:!'],
  },
  {
    // The user's own: a Neo 2 board puts the vowels under the left hand and
    // nothing where any other layout expects it, which is exactly the case
    // that makes reading `code` rather than `key` non-negotiable.
    id: 'neo2', label: 'Neo 2',
    home: [...'uiaeosnrtdy'],
    bottom: ['ü', 'ö', 'ä', 'p', 'z', 'b', 'm', ',', '.', 'j'],
  },
];

export function layoutById(id: string): KeyLayout {
  return LAYOUTS.find((l) => l.id === id) ?? LAYOUTS[0];
}

/** The character printed on a physical key, under the chosen layout. */
export function keyLabel(code: string, layout: KeyLayout): string {
  const h = ROW_HOME.indexOf(code);
  if (h >= 0) return layout.home[h] ?? '';
  const b = ROW_BOTTOM.indexOf(code);
  if (b >= 0) return layout.bottom[b] ?? '';
  return '';
}

/** The mapping as an ordered list, for drawing a legend. */
export function keyMapping(layout: KeyLayout, baseNote: number): Array<{ label: string; note: number; sharp: boolean }> {
  return Object.entries(NOTES)
    .sort((a, b) => a[1] - b[1])
    .map(([code, offset]) => ({
      label: keyLabel(code, layout),
      note: baseNote + offset,
      sharp: [1, 3, 6, 8, 10].includes(offset % 12),
    }));
}

export class TypingKeys {
  enabled = false;
  /** MIDI note the leftmost key sounds. C3 by default. */
  base = getSetting('typing.base', 48);
  velocity = getSetting('typing.velocity', 96);
  layoutId = getSetting('typing.layout', 'qwerty');

  private held = new Map<string, number>();
  private handler: ((e: KeyboardEvent) => void) | null = null;
  private upHandler: ((e: KeyboardEvent) => void) | null = null;
  private blurHandler: (() => void) | null = null;
  private listeners = new Set<() => void>();

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  get layout(): KeyLayout {
    return layoutById(this.layoutId);
  }

  setLayout(id: string): void {
    this.layoutId = id;
    setSetting('typing.layout', id);
    this.emit();
  }

  setVelocity(v: number): void {
    this.velocity = Math.max(1, Math.min(127, Math.round(v)));
    setSetting('typing.velocity', this.velocity);
    this.emit();
  }

  setBase(note: number): void {
    // Two octaves either side of the middle is as far as the row reaches
    // before the top of it leaves the keyboard entirely.
    this.base = Math.max(12, Math.min(96, note));
    setSetting('typing.base', this.base);
    this.emit();
  }

  toggle(keyboard: Keyboard, player: Player): void {
    if (this.enabled) this.disable(keyboard);
    else this.enable(keyboard, player);
  }

  enable(keyboard: Keyboard, player: Player): void {
    if (this.enabled) return;
    keyboard.usePlayer(player);
    void player.unlock();

    this.handler = (e: KeyboardEvent) => {
      if (!this.enabled) return;
      // Never steal a keystroke from something being typed into.
      const t = e.target as HTMLElement | null;
      if (t && (t instanceof HTMLInputElement || t instanceof HTMLSelectElement || t instanceof HTMLTextAreaElement)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      if (e.code === OCTAVE_DOWN || e.code === OCTAVE_UP) {
        e.preventDefault();
        e.stopPropagation();
        this.setBase(this.base + (e.code === OCTAVE_UP ? 12 : -12));
        return;
      }

      const offset = NOTES[e.code];
      if (offset === undefined) return;
      e.preventDefault();
      // Capture-phase, so the views' own single-key shortcuts never also fire
      // for a key that is currently a piano key.
      e.stopPropagation();
      if (e.repeat || this.held.has(e.code)) return;

      const note = this.base + offset;
      this.held.set(e.code, note);
      // Shift is the accent, which is the one dynamic a typing keyboard can
      // offer without a second row of keys.
      keyboard.noteOn(note, e.shiftKey ? Math.min(127, this.velocity + 28) : this.velocity);
      this.emit();
    };

    this.upHandler = (e: KeyboardEvent) => {
      const note = this.held.get(e.code);
      if (note === undefined) return;
      this.held.delete(e.code);
      keyboard.noteOff(note);
      this.emit();
    };

    // A key held while the window loses focus never sends its keyup, which
    // leaves a note on forever - and these patches can sustain forever.
    this.blurHandler = () => {
      for (const note of this.held.values()) keyboard.noteOff(note);
      this.held.clear();
      this.emit();
    };

    window.addEventListener('keydown', this.handler, { capture: true });
    window.addEventListener('keyup', this.upHandler, { capture: true });
    window.addEventListener('blur', this.blurHandler);
    this.enabled = true;
    this.emit();
  }

  disable(keyboard: Keyboard): void {
    if (this.handler) window.removeEventListener('keydown', this.handler, { capture: true });
    if (this.upHandler) window.removeEventListener('keyup', this.upHandler, { capture: true });
    if (this.blurHandler) window.removeEventListener('blur', this.blurHandler);
    this.handler = null;
    this.upHandler = null;
    this.blurHandler = null;
    for (const note of this.held.values()) keyboard.noteOff(note);
    this.held.clear();
    this.enabled = false;
    this.emit();
  }

  /** Notes currently down, for drawing the legend. */
  get sounding(): Set<number> {
    return new Set(this.held.values());
  }
}

export const typingKeys = new TypingKeys();
