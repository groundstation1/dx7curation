/*
 * One core's worth of measuring, for the bundle builder.
 *
 * The same three calls the browser's analyse worker makes - render, acoustic,
 * structural - and nothing else, because everything that follows needs the
 * whole corpus and cannot be split. Voices arrive as packed bytes and leave as
 * numbers, so nothing large crosses between threads.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { unpackVoice, clampVoice, voiceName, isSilentByParams } from '../src/sysex/voice.ts';
import { isCarrier } from '../src/engine/fmcore.ts';
import { renderProbe } from '../src/render/probe.ts';
import { extractAcoustic } from '../src/features/acoustic.ts';
import { extractStructural } from '../src/features/structural.ts';
import { buildVector } from '../src/features/vector.ts';
import { categorize } from '../src/cluster/category.ts';

export interface MeasureRequest {
  /** Indices into the caller's list, with the packed bytes to measure. */
  items: Array<{ index: number; packed: Uint8Array }>;
}

export interface MeasureResult {
  index: number;
  vector: Float32Array;
  acoustic: unknown;
  structural: unknown;
  category: string;
  subcategory: string;
  confidence: number;
  silent: boolean;
}

const port = parentPort;
if (!port) throw new Error('measure.worker must be run as a worker');

void workerData;

port.on('message', (req: MeasureRequest) => {
  const out: MeasureResult[] = [];
  for (const item of req.items) {
    const packed = item.packed instanceof Uint8Array ? item.packed : new Uint8Array(item.packed);
    const { voice: unpacked } = clampVoice(unpackVoice(packed));
    const a = extractAcoustic(renderProbe(unpacked));
    const s = extractStructural(unpacked);
    const cat = categorize(a, s, voiceName(unpacked));
    out.push({
      index: item.index,
      vector: buildVector(a, s),
      acoustic: a,
      structural: s,
      category: cat.category,
      subcategory: cat.sub,
      confidence: cat.confidence,
      silent: isSilentByParams(unpacked, isCarrier),
    });
  }
  port.postMessage(out);
});
