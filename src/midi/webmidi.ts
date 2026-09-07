/*
 * WebMIDI transfer to the FM-1 (or any DX7-compatible receiver).
 *
 * Chrome only, and sysex access needs an explicit permission grant. Everything
 * here is optional: the same four files can be exported and loaded through
 * DXcompanion.uk or dx7-to-fm1.dev instead.
 */

export interface MidiPort {
  id: string;
  name: string;
  manufacturer: string;
}

export interface MidiState {
  supported: boolean;
  granted: boolean;
  outputs: MidiPort[];
  error?: string;
}

type MIDIInputLike = {
  id: string;
  name?: string;
  manufacturer?: string;
  onmidimessage: ((e: { data: Uint8Array }) => void) | null;
};

type MIDIAccessLike = {
  outputs: Map<string, { id: string; name?: string; manufacturer?: string; send(data: number[] | Uint8Array): void }>;
  inputs: Map<string, MIDIInputLike>;
  onstatechange: ((e: unknown) => void) | null;
};

let access: MIDIAccessLike | null = null;

export function midiSupported(): boolean {
  return typeof navigator !== 'undefined' && 'requestMIDIAccess' in navigator;
}

export async function requestMidi(): Promise<MidiState> {
  if (!midiSupported()) {
    return { supported: false, granted: false, outputs: [], error: 'This browser has no WebMIDI. Chrome is required, or export the .syx files instead.' };
  }
  try {
    const nav = navigator as unknown as { requestMIDIAccess(o: { sysex: boolean }): Promise<MIDIAccessLike> };
    access = await nav.requestMIDIAccess({ sysex: true });
    return { supported: true, granted: true, outputs: listOutputs() };
  } catch (err) {
    return {
      supported: true,
      granted: false,
      outputs: [],
      error: `MIDI access was refused: ${(err as Error).message}`,
    };
  }
}

export function listOutputs(): MidiPort[] {
  if (!access) return [];
  return [...access.outputs.values()].map((o) => ({
    id: o.id,
    name: o.name ?? 'unnamed output',
    manufacturer: o.manufacturer ?? '',
  }));
}

export function onPortsChanged(fn: () => void): void {
  if (access) access.onstatechange = () => fn();
}

export function listInputs(): MidiPort[] {
  if (!access) return [];
  return [...access.inputs.values()].map((i) => ({
    id: i.id,
    name: i.name ?? 'unnamed input',
    manufacturer: i.manufacturer ?? '',
  }));
}

export interface MidiInputHandlers {
  noteOn(note: number, velocity: number): void;
  noteOff(note: number): void;
  /** Mod wheel position, 0..1. */
  modWheel(value: number): void;
  /** Pitch bend, -1 to 1, with 0 at the centre detent. */
  pitchBend(value: number): void;
  allNotesOff(): void;
}

/**
 * Listen on every connected input.
 *
 * CC 1 is the DX7's own mod wheel. CC 74 is added alongside it because that is
 * what most modern controllers put under the second slider or a knob, and there
 * is no reason to make the user remap their hardware to hear the LFO.
 */
export const MOD_WHEEL_CCS = [1, 74];

export function attachInputs(handlers: MidiInputHandlers): () => void {
  if (!access) return () => {};
  const inputs = [...access.inputs.values()];
  for (const input of inputs) {
    input.onmidimessage = (e) => {
      const d = e.data;
      if (!d || d.length < 2) return;
      const status = d[0] & 0xf0;
      if (status === 0x90) {
        if (d[2] > 0) handlers.noteOn(d[1], d[2]);
        else handlers.noteOff(d[1]);
      } else if (status === 0x80) {
        handlers.noteOff(d[1]);
      } else if (status === 0xe0) {
        // 14 bits, little end first, centred at 8192. The two halves of the
        // range are not the same size - 8192 below, 8191 above - so they are
        // scaled separately rather than pretending the centre is at 8191.5.
        const raw = (d[1] & 0x7f) | ((d[2] & 0x7f) << 7);
        handlers.pitchBend(raw < 8192 ? (raw - 8192) / 8192 : (raw - 8192) / 8191);
      } else if (status === 0xb0) {
        const cc = d[1];
        if (MOD_WHEEL_CCS.includes(cc)) handlers.modWheel(d[2] / 127);
        else if (cc === 120 || cc === 123) handlers.allNotesOff();
      }
    };
  }
  return () => {
    for (const input of inputs) input.onmidimessage = null;
  };
}

function outputById(id: string) {
  if (!access) throw new Error('MIDI access has not been granted');
  const out = access.outputs.get(id);
  if (!out) throw new Error(`MIDI output ${id} is no longer connected`);
  return out;
}

export interface SendOptions {
  /** Pause between banks. Some receivers drop a dump that arrives too soon. */
  gapMs?: number;
  onProgress?: (sent: number, total: number, label: string) => void;
  signal?: AbortSignal;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Send the four bank files in order.
 *
 * Note the receiving end decides where a bulk dump lands - there is no slot
 * addressing in a 32-voice dump - so the FM-1 must be put into the right
 * receive state between banks. That is a manual step on the unit.
 */
export async function sendBanks(
  outputId: string, banks: Uint8Array[], labels: string[], opts: SendOptions = {},
): Promise<void> {
  const out = outputById(outputId);
  const gap = opts.gapMs ?? 750;
  for (let i = 0; i < banks.length; i++) {
    if (opts.signal?.aborted) throw new Error('transfer cancelled');
    opts.onProgress?.(i, banks.length, labels[i] ?? `bank ${i + 1}`);
    out.send(banks[i]);
    if (i < banks.length - 1) await sleep(gap);
  }
  opts.onProgress?.(banks.length, banks.length, 'done');
}

export function sendRaw(outputId: string, bytes: Uint8Array): void {
  outputById(outputId).send(bytes);
}

/** Program change, for checking that the last slot of bank D is reachable. */
export function sendProgramChange(outputId: string, program: number, channel = 0): void {
  outputById(outputId).send([0xc0 | (channel & 0x0f), program & 0x7f]);
}

/** A short note, for confirming the device is listening at all. */
export function sendTestNote(outputId: string, note = 60, velocity = 100, channel = 0, ms = 700): void {
  const out = outputById(outputId);
  out.send([0x90 | (channel & 0x0f), note & 0x7f, velocity & 0x7f]);
  setTimeout(() => out.send([0x80 | (channel & 0x0f), note & 0x7f, 0]), ms);
}
