/*
 * The computer keyboard as an instrument.
 *
 * Auditioning tells you what a patch does when it is played the way the demo
 * phrase plays it. Playing it yourself tells you what it does under your
 * hands, and that is a different judgement - but it required owning a MIDI
 * keyboard and having it plugged in, which is a high price for "what does this
 * bass do an octave down".
 *
 * Two rows, chromatic: the home row is the white keys and the row above carries
 * the black keys in the gaps, so the two rows sit the way the two rows of a
 * piano do and your hands are already on them. It runs an octave and a tone
 * before you shift.
 *
 * Which physical key plays which note depends on the layout you tell it you
 * have, and it has to: the browser will not say. `KeyboardEvent.code` reports
 * position on a notional US board and `key` reports the character your layout
 * produced, and neither one alone is enough. Position alone would be layout-
 * independent, which sounds like the right answer and is not - it makes the
 * setting cosmetic, so picking Neo 2 changes the picture and nothing else,
 * which is precisely the complaint that produced this comment.
 *
 * So the note is looked up by character, against the characters of the layout
 * you chose. On a board that really is the chosen layout the two agree exactly
 * and the white keys are the home row, as they should be. On a board that is
 * not, choosing that layout gets you its arrangement anyway - which is the
 * only way the picker can mean anything.
 *
 * The consequence is worth stating plainly: choose the wrong layout and the
 * keys do not play. That is the correct failure. The alternative - falling
 * back to position when the character is unknown - would give two different
 * keys the same note and no way to tell which mapping you were in.
 */
import type { Keyboard } from './keyboard.ts';
import type { Player } from './player.ts';
import { getSetting, setSetting } from '../ui/settings.ts';

/**
 * Physical key to semitone, relative to the current base octave.
 *
 * Whites on the home row, blacks in the gaps on the row above - which is where
 * your hands already are, and which maps the two rows onto the two rows of a
 * piano the way they actually sit. The first version had it an octave lower,
 * whites on the bottom row, which is what trackers do and which means reaching
 * down for every note you play.
 *
 * It stops at L rather than running on to the apostrophe, which costs a tone at
 * the top and keeps P free. P pins the patch you are listening to, and pinning
 * the thing you are playing is half the reason to be playing it. The digits
 * stay clear for the same reason: they are the ratings.
 *
 *     W  E     T  Y  U          blacks
 *   A  S  D  F  G  H  J  K  L   whites
 */
const NOTES: Record<string, number> = {
  KeyA: 0, KeyW: 1, KeyS: 2, KeyE: 3, KeyD: 4,
  KeyF: 5, KeyT: 6, KeyG: 7, KeyY: 8, KeyH: 9, KeyU: 10, KeyJ: 11,
  KeyK: 12, KeyO: 13, KeyL: 14,
};

/** The three physical rows, in order, so the legend can be drawn as a keyboard. */
const WHITE_ROW = ['KeyA', 'KeyS', 'KeyD', 'KeyF', 'KeyG', 'KeyH', 'KeyJ', 'KeyK', 'KeyL'];
const BLACK_ROW = ['KeyW', 'KeyE', null, 'KeyT', 'KeyY', 'KeyU', null, 'KeyO', null];
/*
 * The row under the home row: the same white notes, played softly.
 *
 * Velocity is most of what an FM patch has to say. It does not merely set the
 * level - it drives the modulators, so a soft note has audibly fewer sidebands
 * rather than being the same sound quieter, and how a patch behaves when
 * played gently is half of what you are judging. Shift-as-accent only ever
 * offered one direction away from a fixed middle.
 *
 * Below the home row rather than above it because that is where the hand goes:
 * it drops for a soft note the way it lifts for a hard one. Whites only, since
 * there is no fourth row for the black keys - a real limit, and the scale is
 * still playable both ways.
 */
const SOFT_ROW = ['KeyZ', 'KeyX', 'KeyC', 'KeyV', 'KeyB', 'KeyN', 'KeyM', 'Comma', 'Period'];

/** How hard a soft-row note is played, against the set velocity. */
const SOFT_SCALE = 0.5;
/** Seconds for the held-key mod wheel to reach full, and to fall back. */
const MOD_RISE_SEC = 0.9;
const MOD_FALL_SEC = 0.35;
/** Control rate for that ramp. Far finer than the ear needs for a swell. */
const MOD_STEP_MS = 30;
/** And how hard a shifted one is, since the two are a pair. */
const ACCENT_ADD = 28;

/** What one key does: which note, and whether it came from the soft row. */
export interface KeyAction {
  offset: number;
  soft: boolean;
}

/**
 * Character to action, for one layout.
 *
 * Built from the same two tables the legend is drawn from, so what is printed
 * on a key and what that key plays cannot drift apart: both come from
 * `NOTES[code]` and `keyLabel(code, layout)`.
 */
export function charNotes(layout: KeyLayout): Map<string, KeyAction> {
  const out = new Map<string, KeyAction>();
  for (const [code, offset] of Object.entries(NOTES)) {
    const label = keyLabel(code, layout).toLowerCase();
    if (label) out.set(label, { offset, soft: false });
  }
  // A character already claimed by a piano row is not overwritten. On a layout
  // where the two collide the note wins: losing a note costs more than losing
  // one way of playing it quietly.
  SOFT_ROW.forEach((code, k) => {
    const label = keyLabel(code, layout).toLowerCase();
    const white = NOTES[WHITE_ROW[k]];
    if (label && white !== undefined && !out.has(label)) out.set(label, { offset: white, soft: true });
  });
  return out;
}

/*
 * Shifting the octave: 9 and 0.
 *
 * The number row is where this app already puts its utility keys - 1 to 5 rate
 * - so the rest of that row is the obvious home for the others, and the digits
 * are the same keys on every board. Minus and equals, which these replace, are
 * at the far end of a number row a compact keyboard may not have, and on
 * several layouts need a modifier to type at all.
 *
 * Matched by character and by position, because on a layout whose top row is
 * unshifted punctuation - AZERTY, say - the character is not a digit but the
 * key still is. Page Up and Page Down come along for free: the same gesture,
 * present everywhere, impossible to confuse with a note.
 */
const OCTAVE_DOWN_CODES = ['Digit9', 'PageDown'];
const OCTAVE_UP_CODES = ['Digit0', 'PageUp'];

/**
 * What is printed on those keys, per layout.
 *
 * Only ever used to draw the legend. Rows are in physical order starting from
 * the key at the left end of each row, so a layout is three strings.
 */
export interface KeyLayout {
  id: string;
  label: string;
  /** KeyQ row, eleven keys from Q to BracketLeft. */
  top: string[];
  /** KeyA row, eleven keys from A to Quote. */
  home: string[];
  /** KeyZ row, ten keys from Z to Slash. */
  bottom: string[];
}

const ROW_TOP = ['KeyQ', 'KeyW', 'KeyE', 'KeyR', 'KeyT', 'KeyY', 'KeyU', 'KeyI', 'KeyO', 'KeyP', 'BracketLeft'];
const ROW_HOME = ['KeyA', 'KeyS', 'KeyD', 'KeyF', 'KeyG', 'KeyH', 'KeyJ', 'KeyK', 'KeyL', 'Semicolon', 'Quote'];
const ROW_BOTTOM = ['KeyZ', 'KeyX', 'KeyC', 'KeyV', 'KeyB', 'KeyN', 'KeyM', 'Comma', 'Period', 'Slash'];

export const LAYOUTS: KeyLayout[] = [
  {
    id: 'qwerty', label: 'QWERTY',
    top: [...'qwertyuiop['],
    home: [...'asdfghjkl;\''],
    bottom: [...'zxcvbnm,./'],
  },
  {
    id: 'qwertz', label: 'QWERTZ (German)',
    top: [...'qwertzuiop', 'ü'],
    home: [...'asdfghjkl', 'ö', 'ä'],
    bottom: [...'yxcvbnm,.-'],
  },
  {
    id: 'azerty', label: 'AZERTY (French)',
    top: [...'azertyuiop', '^'],
    home: [...'qsdfghjklm', 'ù'],
    bottom: [...'wxcvbn,;:!'],
  },
  {
    // The user's own: a Neo 2 board puts the vowels under the left hand and
    // nothing where any other layout expects it, which is exactly the case
    // that makes reading `code` rather than `key` non-negotiable.
    id: 'neo2', label: 'Neo 2',
    top: [...'xvlcwkhgfq', 'ß'],
    home: [...'uiaeosnrtdy'],
    bottom: ['ü', 'ö', 'ä', 'p', 'z', 'b', 'm', ',', '.', 'j'],
  },
];

export function layoutById(id: string): KeyLayout {
  return LAYOUTS.find((l) => l.id === id) ?? LAYOUTS[0];
}

/** The character printed on a physical key, under the chosen layout. */
export function keyLabel(code: string, layout: KeyLayout): string {
  const t = ROW_TOP.indexOf(code);
  if (t >= 0) return layout.top[t] ?? '';
  const h = ROW_HOME.indexOf(code);
  if (h >= 0) return layout.home[h] ?? '';
  const b = ROW_BOTTOM.indexOf(code);
  if (b >= 0) return layout.bottom[b] ?? '';
  return '';
}

export interface KeyCap {
  label: string;
  note: number;
  /** Absent where the piano has no black key between two whites. */
  empty?: boolean;
}

/**
 * The mapping as two rows that line up, for drawing a legend.
 *
 * The black row carries holes where a piano has none - between E and F, and
 * between B and C - which is the whole reason a keyboard is recognisable at a
 * glance. A sorted flat list of every key loses exactly that.
 */
export function keyRows(
  layout: KeyLayout, baseNote: number,
): { black: KeyCap[]; white: KeyCap[]; soft: KeyCap[] } {
  const cap = (code: string | null): KeyCap => (code === null
    ? { label: '', note: -1, empty: true }
    : { label: keyLabel(code, layout), note: baseNote + NOTES[code] });
  return {
    black: BLACK_ROW.map(cap),
    white: WHITE_ROW.map(cap),
    // Each soft key is labelled from itself and sounds the white above it.
    soft: SOFT_ROW.map((code, k) => ({
      label: keyLabel(code, layout),
      note: baseNote + NOTES[WHITE_ROW[k]],
    })),
  };
}

export class TypingKeys {
  enabled = false;
  /**
   * Whether to switch on as soon as there is something to play.
   *
   * On by default: the cost is that the letter keys are piano keys, and the
   * mapping is chosen so that costs nothing the app actually uses - the digits
   * are still the ratings, P still pins, space still auditions. The benefit is
   * that you can play any patch you are looking at without first finding a
   * setting that says you are allowed to.
   */
  wanted = getSetting('typing.enabled', true);
  /** MIDI note the leftmost key sounds. C3 by default. */
  base = getSetting('typing.base', 48);
  velocity = getSetting('typing.velocity', 96);
  layoutId = getSetting('typing.layout', 'qwerty');

  private held = new Map<string, number>();
  /**
   * Notes currently sounding, and which keys are holding each one.
   *
   * Two keys can mean one note - the soft row plays what the home row plays -
   * and without this the second press retriggered it and the first release
   * stopped it while the other key was still down. A note sounds while at
   * least one key holds it.
   */
  private voices = new Map<number, { keys: Set<string>; velocity: number }>();
  /**
   * Keys being held as the mod wheel rather than as notes.
   *
   * A note has two keys - the soft row mirrors the home row - so the second
   * one pressed on a note already sounding has nothing useful to do as a note.
   * It opens the wheel instead. See the note-on handler.
   */
  private modKeys = new Set<string>();
  /** Where the wheel was before a key took it, so it can be given back. */
  private modBefore = 0;
  private modTarget = 0;
  private modTimer: number | null = null;

  /**
   * Move the wheel towards a target rather than jumping to it.
   *
   * A wheel is a thing you roll. Snapping to full deflection the instant the
   * second key lands is not what the gesture looks like and not what it sounds
   * like either: on a patch with any vibrato depth the jump arrives as a click
   * rather than as a swell, which is the opposite of what the control is for.
   *
   * Falling back is quicker than rising, the way a sprung wheel returns.
   *
   * On a timer rather than a frame callback because this is control rate, not
   * video: thirty milliseconds is far finer than the ear needs for a swell and
   * costs a fraction of what redrawing would.
   */
  private rampMod(keyboard: Keyboard, to: number): void {
    this.modTarget = to;
    if (this.modTimer !== null) return;
    this.modTimer = window.setInterval(() => {
      const from = keyboard.modWheel;
      const rising = this.modTarget > from;
      const per = MOD_STEP_MS / 1000 / (rising ? MOD_RISE_SEC : MOD_FALL_SEC);
      const next = rising ? Math.min(this.modTarget, from + per) : Math.max(this.modTarget, from - per);
      keyboard.setModWheel(next);
      if (Math.abs(next - this.modTarget) < 1e-3) this.stopRamp();
    }, MOD_STEP_MS);
  }

  private stopRamp(): void {
    if (this.modTimer === null) return;
    window.clearInterval(this.modTimer);
    this.modTimer = null;
  }
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

  /** Character to semitone for the current layout; see `charNotes`. */
  private notes = charNotes(layoutById(getSetting('typing.layout', 'qwerty')));

  setLayout(id: string): void {
    this.layoutId = id;
    setSetting('typing.layout', id);
    // Rebuilt here rather than looked up per keystroke: this is the whole
    // point of the setting, and it changes about once in a keyboard's life.
    this.notes = charNotes(this.layout);
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
    this.wanted = this.enabled;
    setSetting('typing.enabled', this.wanted);
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

      // The octave keys are taken by position as well as by character: they
      // are not notes, and on a layout that puts the minus sign somewhere
      // unexpected the key beside the digits is still the obvious place.
      const down = e.key === '9' || OCTAVE_DOWN_CODES.includes(e.code);
      const up = e.key === '0' || OCTAVE_UP_CODES.includes(e.code);
      if (down || up) {
        e.preventDefault();
        e.stopPropagation();
        this.setBase(this.base + (up ? 12 : -12));
        return;
      }

      // Shift produces an upper-case character, so the lookup is folded down;
      // every key in the map is a letter, which makes that safe.
      const char = e.key.toLowerCase();
      const action = this.notes.get(char);
      if (action === undefined) return;
      e.preventDefault();
      // Capture-phase, so the views' own single-key shortcuts never also fire
      // for a key that is currently a piano key.
      e.stopPropagation();
      if (e.repeat || this.held.has(char)) return;

      const note = this.base + action.offset;
      this.held.set(char, note);
      // Three levels: the row below plays soft, shift plays hard, the home row
      // is what you set. Shift on a soft key is a contradiction, and the soft
      // row wins - you chose that one with your hand.
      const velocity = action.soft
        ? Math.max(1, Math.round(this.velocity * SOFT_SCALE))
        : e.shiftKey ? Math.min(127, this.velocity + ACCENT_ADD) : this.velocity;

      const voice = this.voices.get(note);
      if (!voice) {
        this.voices.set(note, { keys: new Set([char]), velocity });
        keyboard.noteOn(note, velocity);
      } else if (!voice.keys.has(char) && !this.modKeys.has(char)) {
        /*
         * The second key on a note that is already sounding is the mod wheel.
         *
         * Every note has two keys, one in the home row and its twin below, and
         * pressing both is otherwise a contradiction: retriggering throws away
         * the note you are holding, and doing nothing wastes the gesture. What
         * the gesture is good for is the thing a typing keyboard has no room
         * for - the wheel. Hold a note, drop a finger onto the row below, and
         * the wheel opens; lift it and the wheel goes back where it was.
         *
         * Either order. Soft first then the home key, or the other way round:
         * whichever arrives second modulates, because by then the note it
         * would have played is already sounding.
         *
         * The wheel is global - one instrument, one wheel - so this bends
         * everything currently down, not only the note under the two fingers.
         * That is what a wheel does, and it is why this is worth having.
         */
        /*
         * Only remember where the wheel rests when it is actually at rest.
         *
         * Reading it whenever the first mod key goes down looks right and is
         * not: releasing starts a fall that takes a third of a second, and a
         * second press inside that window read the wheel mid-fall and called
         * that the resting position. Roll it twice quickly and the wheel
         * settled wherever the second press happened to catch it - stuck at
         * 83% with nothing held.
         */
        if (this.modKeys.size === 0 && this.modTimer === null) this.modBefore = keyboard.modWheel;
        this.modKeys.add(char);
        this.rampMod(keyboard, 1);
      }
      this.emit();
    };

    this.upHandler = (e: KeyboardEvent) => {
      const char = e.key.toLowerCase();
      const note = this.held.get(char);
      if (note === undefined) return;
      this.held.delete(char);

      // A key that was holding the wheel gives it back rather than stopping a
      // note it never started.
      if (this.modKeys.delete(char)) {
        if (this.modKeys.size === 0) this.rampMod(keyboard, this.modBefore);
        this.emit();
        return;
      }

      const voice = this.voices.get(note);
      if (!voice) return;
      voice.keys.delete(char);
      // Only the last key off the note stops it.
      if (voice.keys.size === 0) {
        this.voices.delete(note);
        keyboard.noteOff(note);
      }
      this.emit();
    };

    // A key held while the window loses focus never sends its keyup, which
    // leaves a note on forever - and these patches can sustain forever.
    this.blurHandler = () => {
      for (const note of this.voices.keys()) keyboard.noteOff(note);
      this.voices.clear();
      this.held.clear();
      if (this.modKeys.size) {
        this.modKeys.clear();
        this.rampMod(keyboard, this.modBefore);
      }
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
    for (const note of this.voices.keys()) keyboard.noteOff(note);
    this.voices.clear();
    this.held.clear();
    // Switching off is not a performance gesture, so the wheel goes straight
    // back rather than gliding after the keyboard has gone.
    this.stopRamp();
    if (this.modKeys.size) {
      this.modKeys.clear();
      keyboard.setModWheel(this.modBefore);
    }
    this.enabled = false;
    this.emit();
  }

  /**
   * The keys currently down, for drawing the legend.
   *
   * Keys rather than notes: a soft key and its home-row twin sound the same
   * note, so lighting by note lit both of them and pressing one looked like
   * pressing two.
   */
  get soundingKeys(): Set<string> {
    return new Set(this.held.keys());
  }
}

export const typingKeys = new TypingKeys();
