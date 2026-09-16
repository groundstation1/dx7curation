/*
 * Everything audible, in one place along the bottom edge.
 *
 * These controls used to be crammed into the right-hand end of the title bar,
 * between the brand and the voice counts, because they are global: the MIDI
 * keyboard plays whatever is under the cursor on the map, whatever is up for
 * rating, and whichever side of a face-off is sounding, so they cannot live
 * inside any one view. Global is not the same as chrome, though - volume, the
 * mod wheel and what is allowed to play are the things you reach for most, and
 * they were the smallest text on screen.
 *
 * So they get a strip of their own, docked under the app and directly above the
 * piano roll that draws what the keyboard is playing. Sound in one corner.
 *
 * The rarely-touched half - which input, how far the pitch wheel bends, where
 * the mod wheel's dead zone sits - opens upward as a panel, so the layout never
 * moves when you go looking for it.
 */
import { append, clear, el } from './dom.ts';
import { adv, subscribeAdvanced } from './advanced.ts';
import { getSetting, setSetting } from './settings.ts';
import { keyboard } from '../audio/keyboard.ts';
import { midiSupported } from '../midi/webmidi.ts';
import { LAYOUTS, keyRows, typingKeys, type KeyCap } from '../audio/typingKeys.ts';
import { AUTO_PLAY_LABELS, type AutoPlay, type Player } from '../audio/player.ts';
import { ensureOutputAccess, outputPicker, outputSummary, subscribeOutput } from './midiOut.ts';

/**
 * Audition preferences, read where they are used rather than copied.
 *
 * Three views each kept their own `usePhrase` and `loopPhrase`, each read from
 * storage once at module load and each with its own pair of checkboxes. Three
 * copies of one preference means changing it in one place leaves the other two
 * stale until a reload, and it is the same question in all three.
 */
export function usePhrase(): boolean {
  return getSetting('audition.phrase', true);
}

export function loopPhrase(): boolean {
  return getSetting('audition.loop', true);
}

/**
 * Mute as a speaker, because that is what a speaker means.
 *
 * It was a button reading `mute` that changed to `muted`, which are one letter
 * apart and are the two states - so telling them apart meant reading a word
 * carefully to work out whether it described the button's effect or the app's
 * condition. A crossed-out speaker cannot be read the wrong way round.
 *
 * Drawn rather than set in a font: the emoji speakers are colour glyphs and
 * arrive at whatever size and hue the platform feels like, in the middle of a
 * strip of 11px monochrome type.
 */
function speakerIcon(muted: boolean): HTMLElement {
  const cone = '<path d="M2.5 5.5h2L7.5 3v9L4.5 9.5h-2z" fill="currentColor"/>';
  const waves = muted
    ? '<path d="M10 5.5l3.7 4M13.7 5.5L10 9.5" stroke="currentColor" stroke-width="1.3" '
      + 'fill="none" stroke-linecap="round"/>'
    : '<path d="M10 5.2a3.4 3.4 0 0 1 0 4.6M12.2 3.4a6.2 6.2 0 0 1 0 8.2" '
      + 'stroke="currentColor" stroke-width="1.2" fill="none" stroke-linecap="round"/>';
  return el('span', {
    class: 'sound-icon',
    innerHTML: '<svg viewBox="0 0 15 15" width="15" height="15" aria-hidden="true">' + cone + waves + '</svg>',
  });
}

/**
 * The octave the typing keys are in, as a distance rather than a note name.
 *
 * `C3` is a fact about the keyboard and not about what you did to it: to read
 * it you have to remember what it said before you pressed 9. What the readout
 * is for is telling you how far from home you have wandered, so it says that -
 * and says nothing at all while you are at home, which is where it sits nearly
 * all of the time.
 */
const HOME_BASE = 48;

function octaveShift(): number {
  return Math.round((typingKeys.base - HOME_BASE) / 12);
}

function outputReadout(): HTMLElement | null {
  const summary = outputSummary();
  const openList = () => {
    open = true;
    render();
  };
  if (!summary) {
    // No access yet: asking for it is the button's whole job.
    return midiSupported()
      ? el('button', {
        class: 'sound-midi',
        title: 'Choose which MIDI output patches are sent to',
        onclick: () => void ensureOutputAccess().then(openList, openList),
      }, 'choose output')
      : null;
  }
  return el('button', {
    class: summary.missing ? 'sound-midi warn' : 'sound-midi',
    title: summary.missing
      ? 'The output patches are sent to is not connected. Click to choose another.'
      : 'Patches are sent here. Click to choose another output.',
    onclick: openList,
  }, `out: ${summary.text}`);
}

let bar: HTMLElement | null = null;
let panel: HTMLElement | null = null;
let player: Player;
let open = false;

function toggle(
  label: string, on: boolean, title: string, onchange: (v: boolean) => void,
): HTMLElement {
  return el('label', { class: 'field', title },
    el('input', {
      type: 'checkbox',
      checked: on,
      onchange: (e: Event) => onchange((e.target as HTMLInputElement).checked),
    }), label);
}

function renderPanel(): void {
  if (!panel) return;
  clear(panel);
  panel.hidden = !open;
  if (!open) return;

  const rows: Node[] = [];

  // Closed from inside as well as from the gear, which is at the other end of
  // the strip and easy to lose once the panel is open above it.
  rows.push(el('button', {
    class: 'sound-close',
    title: 'Close sound settings',
    onclick: () => {
      open = false;
      render();
    },
  }, '\u00d7'));

  if (midiSupported()) {
    // Headed, like the output below it: without one, "not connected" under a
    // Connect button read as being about where patches go.
    rows.push(el('h3', { class: 'sound-head' }, 'Play from a MIDI keyboard'));
    rows.push(el('div', { class: 'sound-row' },
      el('button', {
        class: keyboard.connected ? 'btn on' : 'btn',
        onclick: async () => {
          if (keyboard.connected) keyboard.disconnect();
          else await keyboard.connect(player);
          render();
        },
      }, keyboard.connected ? 'Disconnect' : 'Connect MIDI'),
      el('span', { class: 'muted' }, keyboard.connected
        ? keyboard.inputs.map((i) => i.name).join(', ') || 'no inputs'
        : keyboard.error || 'not connected'),
    ));

    if (keyboard.connected) {
      rows.push(el('div', { class: 'sound-row' },
        el('label', {
          class: 'field',
          title: 'Mod wheel values below this read as fully off, so a wheel that does not quite rest at zero cannot colour everything you audition. CC 1 and CC 74.',
        }, 'mod dead zone',
          el('input', {
            type: 'number', min: 0, max: 50, step: 1,
            value: Math.round(keyboard.modDeadzone * 100),
            style: { width: '56px' },
            onchange: (e: Event) => {
              const v = Number((e.target as HTMLInputElement).value) / 100;
              keyboard.setModDeadzone(v);
              setSetting('midi.modDeadzone', v);
            },
          }), '%'),
        el('label', {
          class: 'field',
          title: 'How far your pitch wheel bends, in semitones. The controller decides this and cannot be asked, so it has to be told.',
        }, 'bend range',
          el('input', {
            type: 'number', min: 1, max: 24, step: 1,
            value: keyboard.bendRange,
            style: { width: '50px' },
            onchange: (e: Event) => {
              keyboard.setBendRange(Number((e.target as HTMLInputElement).value));
              setSetting('midi.bendRange', keyboard.bendRange);
            },
          }), 'semitones'),
      ));
    }
  } else {
    rows.push(el('div', { class: 'sound-row muted' }, 'This browser has no WebMIDI.'));
  }

  /*
   * Where patches go, as well as where notes come from.
   *
   * Since any patch can be sent to the synth from any sidebar, the output is
   * as much a setting of the whole app as the input is, and it belongs next
   * to it rather than on the one page that sends banks.
   */
  rows.push(el('div', { class: 'sound-out' },
    el('h3', { class: 'sound-head' }, 'Send patches to'),
    outputPicker()));

  rows.push(typingSection());
  rows.push(shortcutSection());
  append(panel, rows);
}

/**
 * Every key the app answers to, in one table.
 *
 * All of these were discoverable only by reading the source or by accident:
 * the octave shift was a tooltip on a readout that only appeared once the
 * typing keys were on, the soft row was drawn in the legend without saying
 * what made it soft, and the mod wheel was nowhere at all.
 *
 * The mod wheel one is the reason this panel exists. It is not a shortcut so
 * much as a consequence - the soft row plays the same notes as the home row,
 * so holding both keys for one note is a gesture with nothing else to mean -
 * and an FM patch heard without its mod wheel is half a patch.
 */
function shortcutSection(): HTMLElement {
  const keys = (...caps: string[]) => {
    const out: Node[] = [];
    caps.forEach((c, i) => {
      if (i) out.push(document.createTextNode(' '));
      out.push(c === '\u2013' ? document.createTextNode(c) : el('kbd', {}, c));
    });
    return el('span', { class: 'sc-keys' }, ...out);
  };
  const line = (k: HTMLElement, what: string) => el('div', { class: 'sc-row' },
    k, el('span', { class: 'sc-what' }, what));

  return el('div', { class: 'sound-shortcuts' },
    el('h3', {}, 'Keys'),
    el('div', { class: 'sc-list' },
      line(keys('shift'), 'accent'),
      line(keys('9', '0'), 'octave down, up'),
      line(keys('1', '\u2013', '5'), 'rate'),
      line(keys('6'), 'favourite'),
      line(keys('space'), 'play, stop'),
    ),
    el('p', { class: 'sc-note' },
      'Hold both keys for one note \u2014 the soft row doubles the home row \u2014 and the '
      + 'spare one rolls the mod wheel up while you keep it down.'),
  );
}

/**
 * The typing keyboard's own settings, and a picture of where the notes are.
 *
 * The layout picker deliberately changes nothing about how the keys play - the
 * mapping is by physical position, which is correct on every layout - it only
 * decides which letters the legend prints. Saying so here is cheaper than
 * having someone on a Neo 2 board wonder why their keys are in the wrong place
 * when they are not.
 */
function typingSection(): HTMLElement {
  const section = el('div', {});
  section.appendChild(el('div', { class: 'sound-row' },
    el('button', {
      class: typingKeys.enabled ? 'btn on' : 'btn',
      onclick: () => {
        typingKeys.toggle(keyboard, player);
        render();
      },
    }, typingKeys.enabled ? 'Typing keys are on' : 'Play from the computer keyboard'),
    el('label', { class: 'field', title: 'Only changes the letters drawn below. The keys themselves are read by position, so any layout plays the same.' }, 'layout',
      el('select', {
        onchange: (e: Event) => {
          typingKeys.setLayout((e.target as HTMLSelectElement).value);
          render();
        },
      }, ...LAYOUTS.map((l) => el('option', {
        value: l.id, selected: l.id === typingKeys.layoutId,
      }, l.label)))),
    el('label', { class: 'field' }, 'octave',
      el('input', {
        type: 'number', min: 1, max: 8, value: Math.floor(typingKeys.base / 12) - 1,
        style: { width: '48px' },
        onchange: (e: Event) => {
          typingKeys.setBase((Number((e.target as HTMLInputElement).value) + 1) * 12);
          render();
        },
      })),
    el('label', { class: 'field', title: 'Hold shift while playing for an accent.' }, 'velocity',
      el('input', {
        type: 'number', min: 1, max: 127, value: typingKeys.velocity,
        style: { width: '54px' },
        onchange: (e: Event) => {
          typingKeys.setVelocity(Number((e.target as HTMLInputElement).value));
          render();
        },
      })),
  ));

  /*
   * Drawn as a keyboard: blacks on top with the gaps a piano has, whites below.
   *
   * Each row says what it is, beside it. The same three facts were rows in the
   * key table underneath - "A to L: white keys" - which asked somebody to read
   * a range of letters and then find those letters in a picture of a keyboard
   * printed directly above it. The picture already answers the question; it
   * only had to be captioned.
   */
  const sounding = typingKeys.soundingKeys;
  const rows = keyRows(typingKeys.layout, typingKeys.base);
  const drawRow = (caps: KeyCap[], sharp: boolean, soft = false) => {
    const row = el('div', { class: 'keyrow' });
    for (const k of caps) {
      row.appendChild(k.empty
        ? el('span', { class: 'keycap gap' })
        : el('span', {
          class: `keycap${sharp ? ' sharp' : ''}${soft ? ' soft' : ''}${sounding.has(k.label.toLowerCase()) ? ' down' : ''}`,
          title: soft ? `${noteName(k.note)}, softly` : noteName(k.note),
        }, k.label));
    }
    return row;
  };
  const labelled = (what: string, row: HTMLElement) => el('div', { class: 'keyrow-wrap' },
    row, el('span', { class: 'keyrow-label' }, what));
  section.appendChild(el('div', { class: 'keymap' },
    labelled('black keys', drawRow(rows.black, true)),
    labelled('white keys', drawRow(rows.white, false)),
    labelled('the same notes, softer', drawRow(rows.soft, false, true))));
  return section;
}

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

function noteName(midi: number): string {
  return `${NOTE_NAMES[midi % 12]}${Math.floor(midi / 12) - 1}`;
}

function render(): void {
  if (!bar) return;
  clear(bar);

  append(bar, [
    /*
     * The name of the strip, at the weight of a name.
     *
     * As 11px muted type immediately to the left of the volume slider it was
     * not read as the title of anything - it was read as that slider's label,
     * which made the one word on the bar that says what the whole bar is look
     * like a mislabelled control.
     */
    el('span', { class: 'sound-title' }, 'sound'),

    // Mute before volume: it is the coarse control, the one reached for in a
    // hurry, and a slider you cannot hear is a puzzle unless the reason is
    // sitting immediately before it.
    el('button', {
      class: player.isMuted ? 'sound-mute on' : 'sound-mute',
      title: player.isMuted ? 'Muted. Click to hear things again.' : 'Silence everything, including the MIDI keyboard.',
      onclick: () => {
        player.setMuted(!player.isMuted);
        setSetting('audio.muted', player.isMuted);
        render();
      },
    }, speakerIcon(player.isMuted)),

    // Dead while muted rather than merely ineffective: it still remembers where
    // it was, and moving it to find out that nothing happens is not
    // information.
    el('input', {
      type: 'range', min: 0, max: 100, value: Math.round(player.getVolume() * 100),
      class: 'sound-vol',
      disabled: player.isMuted,
      title: player.isMuted ? 'Muted - the speaker beside it turns the sound back on' : 'output volume',
      oninput: (e: Event) => {
        const v = Number((e.target as HTMLInputElement).value) / 100;
        player.setVolume(v);
        setSetting('audio.volume', v);
      },
    }),

    /*
     * What plays by itself, and what an audition is, are settled once.
     *
     * Three permanent controls for three preferences that have a right answer
     * and get changed about twice: hover-to-play, the demo phrase rather than
     * one note, and looping it. They are still here under the switch, and they
     * still work on their stored values when it is off.
     */
    adv(el('span', { class: 'sound-sep' })),

    adv(el('label', {
      class: 'field',
      title: 'What is allowed to start playing without being asked. Buttons, the space bar and the MIDI keyboard always play.',
    }, 'play',
      el('select', {
        onchange: (e: Event) => {
          player.autoPlay = (e.target as HTMLSelectElement).value as AutoPlay;
          setSetting('audio.autoPlay', player.autoPlay);
          if (player.autoPlay === 'never') player.stop();
        },
      }, ...(['hover', 'click', 'never'] as const).map((mode) => el('option', {
        value: mode, selected: player.autoPlay === mode,
      }, AUTO_PLAY_LABELS[mode]))))),

    adv(toggle('phrase', usePhrase(), 'Audition the demo phrase rather than one held note.',
      (v) => setSetting('audition.phrase', v))),
    adv(toggle('loop', loopPhrase(), 'Repeat the phrase until something else plays.',
      (v) => setSetting('audition.loop', v))),

    el('span', { class: 'sound-sep' }),

    // The computer keyboard as an instrument. Off by default, because while it
    // is on the letter keys are piano keys and nothing else.
    el('button', {
      class: typingKeys.enabled ? 'sound-midi on' : 'sound-midi',
      title: typingKeys.enabled
        ? 'Letter keys are piano keys. Press again to give them back.'
        : 'Play patches from the computer keyboard: bottom row white, row above black.',
      onclick: () => {
        typingKeys.toggle(keyboard, player);
        render();
      },
    }, 'typing keys'),

    // How far the keys have been shifted, while you are playing them - and
    // nothing at all while they are where they started, which is the case that
    // needs no readout.
    typingKeys.enabled && octaveShift() !== 0
      ? el('span', {
        class: 'sound-oct',
        title: 'Shifted ' + Math.abs(octaveShift()) + ' octave' + (Math.abs(octaveShift()) === 1 ? '' : 's')
          + ' ' + (octaveShift() > 0 ? 'up' : 'down') + ', starting at ' + noteName(typingKeys.base)
          + '. 9 and 0 shift it.',
      }, (octaveShift() > 0 ? '+' : '\u2212') + Math.abs(octaveShift()) + ' oct')
      : null,

    midiSupported() ? el('span', { class: 'sound-sep' }) : null,

    midiSupported()
      ? el('button', {
        class: keyboard.connected ? 'sound-midi on' : 'sound-midi',
        title: keyboard.connected
          ? keyboard.inputs.map((i) => i.name).join(', ')
          : 'Play the patch under the cursor from a MIDI keyboard.',
        onclick: async () => {
          if (!keyboard.connected) await keyboard.connect(player);
          render();
        },
      }, keyboard.connected ? `MIDI ${keyboard.inputs.length} in` : 'connect MIDI')
      : null,

    /*
     * Which output a send goes to, always in view.
     *
     * A sysex send makes no sound, so sending to the wrong port looks exactly
     * like sending to the right one. The strip is on every screen, which makes
     * it the one place this can be seen before pressing a send button rather
     * than after wondering why nothing happened. Clicking opens the list.
     */
    outputReadout(),

    // Shown whenever the wheel is open, whatever opened it: a hardware wheel,
    // or two fingers on one note. It was gated on a MIDI connection, which is
    // exactly the case where the typing keys are not what moved it.
    keyboard.modWheel > 0
      ? el('span', {
        class: 'warn mono',
        title: keyboard.connected
          ? `raw CC ${Math.round(keyboard.modWheelRaw * 127)} of 127`
          : 'held open by the second key on a note',
      }, `mod ${Math.round(keyboard.modWheel * 100)}%`)
      : null,

    /*
     * No spacer before it: the gear belongs to the controls, not to the far
     * edge. Pushed right it read as a separate thing at the end of an empty
     * stretch of bar, and on a wide screen it was a long way from everything
     * it opens.
     */
    el('button', {
      class: open ? 'sound-more on' : 'sound-more',
      title: 'Sound settings: MIDI input, bend range, mod wheel dead zone, typing keyboard',
      onclick: () => {
        open = !open;
        render();
      },
    }, '⚙'),
  ]);

  renderPanel();
}

/** Dock the sound strip under the app. Call once. */
export function mountSoundBar(p: Player): void {
  player = p;
  panel = el('div', { class: 'sound-panel', hidden: true });
  bar = el('div', { class: 'sound-bar' });
  document.body.appendChild(el('footer', { class: 'sound-dock' }, panel, bar));
  keyboard.subscribe(() => render());
  typingKeys.subscribe(() => render());
  // The strip is docked outside the view, so the app's rebuild-on-toggle does
  // not reach it: without this, switching advanced off left three controls on
  // it that the switch had just taken away everywhere else.
  subscribeAdvanced(() => render());
  // A remembered synth being plugged back in, or a choice made on Build.
  subscribeOutput(() => render());
  // On unless it was switched off last time. The audio context is still locked
  // at this point, but `enable` only attaches listeners - the first key press
  // is itself the gesture that unlocks it.
  if (typingKeys.wanted) typingKeys.enable(keyboard, p);
  render();
}
