/*
 * Which MIDI output the synth is on, and sending one patch to it.
 *
 * Once any patch in any sidebar can go to the hardware, the output is a
 * setting of the whole app rather than of the Build page, so it lives here:
 * chosen in the sound settings, shown on the sound strip, remembered between
 * visits, and read by every send button and by Build.
 *
 * A single patch goes as a DX7 single-voice dump - 163 bytes, format 0. The
 * FM-1 accepts the format, needs no receive mode, and ignores the channel
 * nibble, so channel 0 is as good as any.
 *
 * Where it lands is the thing to be careful about. A DX7 puts a single-voice
 * dump in its edit buffer and leaves the stored voices alone. The FM-1 does
 * not: it writes the patch over whichever preset is selected, and there is no
 * undo. So the first send asks first - see `confirmOverwrite`.
 */
import { listOutputs, midiSupported, onPortsChanged, requestMidi, sendRaw, type MidiPort } from '../midi/webmidi.ts';
import { buildSingleVoice } from '../sysex/write.ts';
import { getSetting, setSetting } from './settings.ts';
import { el } from './dom.ts';

const listeners = new Set<() => void>();

export function subscribeOutput(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit(): void {
  for (const fn of listeners) fn();
}

/*
 * Plugged in, unplugged, and back again.
 *
 * Registered once, the first time there is access to watch. Everything that
 * shows or uses the output re-reads it on the way through, so the moment the
 * remembered synth appears it is the one in use - nobody has to go and pick it
 * again after a replug or a reboot.
 */
let watching = false;

function watchPorts(): void {
  if (watching || listOutputs().length === 0) return;
  watching = true;
  onPortsChanged(() => {
    adoptLikelyOutput(listOutputs());
    emit();
  });
  adoptLikelyOutput(listOutputs());
}

const LOOKS_LIKE_FM1 = /fm-?1|m-?vave/i;

/*
 * An FM-1 found with nothing chosen yet is remembered as if it had been chosen.
 *
 * Without this the guess was never written down - it was already the ticked
 * one, and ticking a radio that is already ticked fires nothing - so there was
 * no preference, and the rule that stops a send falling through to some other
 * port never applied. Unplugging the synth then sent the next patch to the
 * Windows wavetable, reported it as sent, and nothing happened anywhere.
 */
function adoptLikelyOutput(ports: MidiPort[]): void {
  if (getSetting('midi.outputId', '') || getSetting('midi.outputName', '')) return;
  const likely = ports.find((p) => LOOKS_LIKE_FM1.test(`${p.name} ${p.manufacturer}`));
  if (likely) {
    setSetting('midi.outputId', likely.id);
    setSetting('midi.outputName', likely.name);
  }
}

/** Whether this session can already see the outputs, without asking. */
export function hasOutputAccess(): boolean {
  const any = listOutputs().length > 0;
  if (any) watchPorts();
  return any;
}

/** The outputs, asking for access if that has not happened yet. */
export async function ensureOutputAccess(): Promise<MidiPort[]> {
  let ports = listOutputs();
  if (ports.length === 0) {
    const state = await requestMidi();
    if (state.error) throw new Error(state.error);
    ports = state.outputs;
  }
  watchPorts();
  adoptLikelyOutput(ports);
  emit();
  return ports;
}

/**
 * The port to send to, or '' if there is none that should be used.
 *
 * Remembered by id and by name, because an id is not guaranteed to survive
 * the device being unplugged and plugged back in, and a name almost always is.
 *
 * With a preference set and that device absent, the answer is nothing - not
 * the first port that happens to be there. A sysex send makes no sound, so a
 * dump sent to the wrong output is indistinguishable from one that worked,
 * and on Windows the first output is usually the built-in wavetable synth.
 *
 * With no preference, an FM-1 is taken; anything else is not a guess worth
 * making, and the answer is nothing until somebody picks.
 */
export function chosenOutput(ports: MidiPort[] = listOutputs()): string {
  const id = getSetting('midi.outputId', '');
  const name = getSetting('midi.outputName', '');
  if (id || name) {
    const byId = ports.find((p) => p.id === id);
    if (byId) return byId.id;
    return (name ? ports.find((p) => p.name === name) : undefined)?.id ?? '';
  }
  return ports.find((p) => LOOKS_LIKE_FM1.test(`${p.name} ${p.manufacturer}`))?.id ?? '';
}

/** The remembered device's name, for saying which one is missing. */
export function preferredOutputName(): string {
  return getSetting('midi.outputName', '');
}

export function chooseOutput(port: MidiPort): void {
  setSetting('midi.outputId', port.id);
  setSetting('midi.outputName', port.name);
  emit();
}

export function canSendToDevice(): boolean {
  return midiSupported();
}

/** Send one voice to the synth. Resolves with the port name it went to. */
export async function sendVoiceToDevice(unpacked: Uint8Array): Promise<string> {
  const ports = await ensureOutputAccess();
  const id = chosenOutput(ports);
  if (!id) {
    const missing = preferredOutputName();
    throw new Error(missing
      ? `${missing} is not connected. Plug it in, or pick another output in the sound settings.`
      : listOutputs().length
        ? 'No output chosen yet. Pick one in the sound settings.'
        : 'No MIDI outputs found. Connect the synth and try again.');
  }
  sendRaw(id, buildSingleVoice(unpacked));
  return ports.find((p) => p.id === id)?.name ?? 'the synth';
}

// Generic on purpose: the output can be any DX7-compatible synth, and the
// strip already says which one.
const SEND_LABEL = '→ synth';

const SKIP_WARNING = 'midi.skipOverwriteWarning';

/**
 * Say, once, that this is destructive on the FM-1.
 *
 * A single-voice dump there is written over the selected preset with no undo,
 * and nothing about a small arrow button in a sidebar suggests that - so the
 * first press explains it and asks. Worded conditionally, because on a DX7
 * and on most things that copy it the same message goes to an edit buffer and
 * nothing is lost.
 *
 * "Don't show again" is only remembered when the answer is Send. Ticking it
 * and then backing out is not agreeing to be sent without asking.
 */
function confirmOverwrite(): Promise<boolean> {
  if (getSetting(SKIP_WARNING, false)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const skip = el('input', { type: 'checkbox' }) as HTMLInputElement;
    const close = (ok: boolean) => {
      window.removeEventListener('keydown', onKey, true);
      scrim.remove();
      if (ok && skip.checked) setSetting(SKIP_WARNING, true);
      resolve(ok);
    };
    // Escape declines. Every other key is kept from the views underneath - the
    // space bar plays a patch on the rating screen - but not prevented, so
    // Enter and space press whichever button has focus, which is Send to begin
    // with and Cancel once somebody tabs to it.
    const onKey = (e: KeyboardEvent) => {
      e.stopPropagation();
      if (e.key === 'Escape') {
        e.preventDefault();
        close(false);
      }
    };
    const send = el('button', { class: 'btn danger', onclick: () => close(true) }, 'Send');
    const dialog = el('div', { class: 'modal', role: 'alertdialog', 'aria-modal': 'true' },
      el('h2', {}, 'This overwrites a sound'),
      el('p', {},
        'If you use the FM-1, the patch replaces the currently selected sound, ',
        'and there is no way to undo it. Pick a preset you don\u2019t mind losing first.'),
      el('label', { class: 'field modal-skip' }, skip, 'Don\u2019t show this again'),
      el('div', { class: 'modal-act' },
        el('button', { class: 'btn', onclick: () => close(false) }, 'Cancel'),
        send));
    // A click on the dimmed page is a no, and so is anything but the buttons.
    const scrim = el('div', {
      class: 'modal-scrim',
      onclick: (e: Event) => { if (e.target === scrim) close(false); },
    }, dialog);
    // Capture phase, so the typing keyboard and the views' own shortcuts do not
    // also act on Enter and Escape while the question is open.
    window.addEventListener('keydown', onKey, true);
    document.body.appendChild(scrim);
    send.focus();
  });
}

/**
 * The send button, for anywhere a patch is shown.
 *
 * Says what happened in its own label for a moment - sent, or why not - since a
 * sysex send is otherwise completely silent: nothing plays, and the only
 * evidence it worked is the synth sounding different next time you touch it.
 * Absent where the browser has no WebMIDI rather than dead, because there is
 * nothing a person on that browser can do to make it work.
 */
export function sendToDeviceButton(unpacked: Uint8Array, className: string): HTMLElement | null {
  if (!canSendToDevice()) return null;
  const button = document.createElement('button');
  button.className = className;
  button.textContent = SEND_LABEL;
  button.title = 'Send to the synth as a single-voice dump. On the FM-1 this overwrites the selected preset.';
  let timer = 0;
  const flash = (text: string, title?: string) => {
    button.textContent = text;
    if (title) button.title = title;
    window.clearTimeout(timer);
    timer = window.setTimeout(() => { button.textContent = SEND_LABEL; }, 1600);
  };
  button.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!(await confirmOverwrite())) return;
    sendVoiceToDevice(unpacked).then(
      (port) => flash('sent', `Sent to ${port}.`),
      (err: Error) => flash('not sent', err.message),
    );
  });
  return button;
}

/**
 * Every output, as a list you can see, and which one is in use.
 *
 * One builder for the sound settings and the Build page, so the two can never
 * disagree about which port a send goes to. Callers draw it again whenever
 * `subscribeOutput` fires, which includes the device being plugged in.
 */
export function outputPicker(): HTMLElement {
  const wrap = el('div', { class: 'out-picker' });
  if (!canSendToDevice()) {
    wrap.appendChild(el('p', { class: 'muted' }, 'This browser has no WebMIDI.'));
    return wrap;
  }
  if (!hasOutputAccess()) {
    wrap.appendChild(el('button', {
      class: 'btn',
      onclick: () => void ensureOutputAccess().catch(() => {}),
    }, 'Find MIDI outputs'));
    return wrap;
  }

  const ports = listOutputs();
  const current = chosenOutput(ports);
  const list = el('div', { class: 'port-list' });
  // One name for the whole set, or they are not a radio group at all. Unique
  // per picker, because two pickers can be on screen at once.
  const group = `midi-out-${Math.random().toString(36).slice(2, 9)}`;
  for (const port of ports) {
    const name = `${port.name} ${port.manufacturer}`.trim();
    list.appendChild(el('label', { class: port.id === current ? 'port on' : 'port' },
      el('input', {
        type: 'radio', name: group,
        checked: port.id === current,
        // A click rather than a change: picking the one already ticked is
        // still a choice, and a change event never fires for it.
        onclick: () => chooseOutput(port),
      }),
      el('span', {}, name)));
  }
  wrap.appendChild(list);

  const missing = preferredOutputName();
  if (!current && missing) {
    wrap.appendChild(el('p', { class: 'warn out-missing' },
      `${missing} is not connected. It will be picked again as soon as it is plugged in.`));
  }
  return wrap;
}

/** A short name for the strip: the port in use, or why there is none. */
export function outputSummary(): { text: string; missing: boolean } | null {
  if (!canSendToDevice() || !hasOutputAccess()) return null;
  const ports = listOutputs();
  const id = chosenOutput(ports);
  const port = ports.find((p) => p.id === id);
  if (port) return { text: port.name, missing: false };
  const wanted = preferredOutputName();
  return { text: wanted ? `${wanted} unplugged` : 'none chosen', missing: true };
}
