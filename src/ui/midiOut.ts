/*
 * Which MIDI output the synth is on, and sending one patch to it.
 *
 * The Build page used to own the choice of output and forget it on every
 * visit, defaulting to whichever port the browser listed first. That was
 * tolerable while banks were the only thing sent. Now any patch in any sidebar
 * can go to the hardware, so the choice is made once, remembered, and shared:
 * picking the FM-1 on the Build page is picking it for the send button too.
 *
 * A single patch goes as a DX7 single-voice dump - 163 bytes, format 0. On a
 * DX7 that lands in the edit buffer: it replaces the sound you are playing and
 * leaves every stored preset alone, which is exactly right for "what does this
 * sound like on the real thing". The FM-1 accepts the format and needs no
 * receive mode, and ignores the channel nibble, so channel 0 is as good as any.
 */
import { listOutputs, midiSupported, requestMidi, sendRaw, type MidiPort } from '../midi/webmidi.ts';
import { buildSingleVoice } from '../sysex/write.ts';
import { getSetting, setSetting } from './settings.ts';

/** The remembered output if it is still plugged in, else the first there is. */
export function chosenOutput(ports: MidiPort[] = listOutputs()): string {
  const stored = getSetting('midi.outputId', '');
  if (stored && ports.some((p) => p.id === stored)) return stored;
  return ports[0]?.id ?? '';
}

export function chooseOutput(id: string): void {
  setSetting('midi.outputId', id);
}

export function canSendToDevice(): boolean {
  return midiSupported();
}

/**
 * Send one voice to the synth. Resolves with the port name it went to.
 *
 * Asks for MIDI access the first time, which is a permission prompt - fine,
 * because this only ever runs from a button press.
 */
export async function sendVoiceToDevice(unpacked: Uint8Array): Promise<string> {
  let ports = listOutputs();
  if (ports.length === 0) {
    const state = await requestMidi();
    if (state.error) throw new Error(state.error);
    ports = state.outputs;
  }
  const id = chosenOutput(ports);
  if (!id) throw new Error('No MIDI outputs found. Connect the synth and try again.');
  sendRaw(id, buildSingleVoice(unpacked));
  return ports.find((p) => p.id === id)?.name ?? 'the synth';
}

const SEND_LABEL = '→ FM-1';

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
  button.title = 'Send to the synth as a single-voice dump. It replaces the sound you are playing, not a stored preset.';
  let timer = 0;
  const flash = (text: string, title?: string) => {
    button.textContent = text;
    if (title) button.title = title;
    window.clearTimeout(timer);
    timer = window.setTimeout(() => { button.textContent = SEND_LABEL; }, 1600);
  };
  button.addEventListener('click', (e) => {
    e.stopPropagation();
    sendVoiceToDevice(unpacked).then(
      (port) => flash('sent', `Sent to ${port}.`),
      (err: Error) => flash('no MIDI', err.message),
    );
  });
  return button;
}
