/*
 * Audition worker: render a voice on demand for immediate playback.
 *
 * Kept separate from the analysis pool so a hover never queues behind a batch.
 * Requests carry a token and only the newest token is worth playing; the caller
 * discards stale results, which is what makes sweeping the mouse across the map
 * feel like scrubbing rather than like a queue draining.
 */
import { renderPhrase, type Phrase } from '../engine/phrase.ts';

export interface AuditionRequest {
  type: 'audition';
  token: number;
  unpacked: Uint8Array;
  phrase: Phrase;
  sampleRate: number;
  gain: number;
}

export interface AuditionResponse {
  type: 'auditioned';
  token: number;
  samples: Float32Array;
  sampleRate: number;
  peak: number;
  ms: number;
}

self.onmessage = (ev: MessageEvent<AuditionRequest>) => {
  const m = ev.data;
  if (m.type !== 'audition') return;
  const t0 = performance.now();
  const r = renderPhrase(m.unpacked, m.phrase, { sampleRate: m.sampleRate, gain: m.gain });
  const response: AuditionResponse = {
    type: 'auditioned',
    token: m.token,
    samples: r.samples,
    sampleRate: r.sampleRate,
    peak: r.peak,
    ms: performance.now() - t0,
  };
  (self as unknown as Worker).postMessage(response, [r.samples.buffer as ArrayBuffer]);
};
