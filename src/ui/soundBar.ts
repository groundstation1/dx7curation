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
import { getSetting, setSetting } from './settings.ts';
import { keyboard } from '../audio/keyboard.ts';
import { midiSupported } from '../midi/webmidi.ts';
import { LAYOUTS, keyRows, typingKeys, type KeyCap } from '../audio/typingKeys.ts';
import { AUTO_PLAY_LABELS, type AutoPlay, type Player } from '../audio/player.ts';

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

  if (midiSupported()) {
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

  rows.push(typingSection());
  append(panel, rows);
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

  // Drawn as a keyboard: blacks on top with the gaps a piano has, whites below.
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
  section.appendChild(el('div', { class: 'keymap' },
    drawRow(rows.black, true),
    drawRow(rows.white, false),
    drawRow(rows.soft, false, true)));
  section.appendChild(el('div', { class: 'muted', style: { fontSize: '10.5px', marginTop: '4px' } },
    'The bottom row plays the same notes softly; shift plays harder. ',
    'Page up and page down shift the octave, as do minus and equals. ',
    'Rating (1-5), pinning (P) and space keep working.'));
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
    el('span', { class: 'sound-label' }, 'sound'),

    el('input', {
      type: 'range', min: 0, max: 100, value: Math.round(player.getVolume() * 100),
      class: 'sound-vol',
      title: 'output volume',
      oninput: (e: Event) => {
        const v = Number((e.target as HTMLInputElement).value) / 100;
        player.setVolume(v);
        setSetting('audio.volume', v);
      },
    }),

    el('button', {
      class: player.isMuted ? 'btn on' : 'btn',
      title: player.isMuted ? 'Muted. Click to hear things again.' : 'Silence everything, including the MIDI keyboard.',
      onclick: () => {
        player.setMuted(!player.isMuted);
        setSetting('audio.muted', player.isMuted);
        render();
      },
    }, player.isMuted ? 'muted' : 'mute'),

    el('label', {
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
      }, AUTO_PLAY_LABELS[mode])))),

    el('span', { class: 'sound-sep' }),

    toggle('phrase', usePhrase(), 'Audition the demo phrase rather than one held note.',
      (v) => setSetting('audition.phrase', v)),
    toggle('loop', loopPhrase(), 'Repeat the phrase until something else plays.',
      (v) => setSetting('audition.loop', v)),

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

    keyboard.connected && keyboard.modWheel > 0
      ? el('span', { class: 'warn mono', title: `raw CC ${Math.round(keyboard.modWheelRaw * 127)} of 127` },
        `mod ${Math.round(keyboard.modWheel * 100)}%`)
      : null,

    el('span', { style: { flex: '1' } }),
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
  // On unless it was switched off last time. The audio context is still locked
  // at this point, but `enable` only attaches listeners - the first key press
  // is itself the gesture that unlocks it.
  if (typingKeys.wanted) typingKeys.enable(keyboard, p);
  render();
}
