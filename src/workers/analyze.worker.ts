/*
 * Analysis worker: render a voice's probe and reduce it to features.
 *
 * Audio never leaves this worker. Only the feature vector and the summary
 * numbers are transferred back, which keeps messages small enough that the pool
 * scales linearly with cores.
 */
import { renderProbe, DEFAULT_PROBE, type ProbeSpec } from '../render/probe.ts';
import { extractAcoustic, type AcousticFeatures } from '../features/acoustic.ts';
import { extractStructural, type StructuralFeatures } from '../features/structural.ts';
import { buildVector } from '../features/vector.ts';
import { categorize } from '../cluster/category.ts';
import { voiceName } from '../sysex/voice.ts';

export interface AnalyzeRequest {
  type: 'analyze';
  batchId: number;
  spec?: ProbeSpec;
  jobs: Array<{ id: number; unpacked: Uint8Array }>;
}

export interface AnalyzeResultItem {
  id: number;
  /** AcousticFeatures with the per-segment detail stripped. */
  acoustic: Omit<AcousticFeatures, 'segments'>;
  structural: StructuralFeatures;
  vector: Float32Array;
  category: string;
  subcategory: string;
  categoryConfidence: number;
  silent: boolean;
}

export interface AnalyzeResponse {
  type: 'analyzed';
  batchId: number;
  items: AnalyzeResultItem[];
  ms: number;
}

self.onmessage = (ev: MessageEvent<AnalyzeRequest>) => {
  const msg = ev.data;
  if (msg.type !== 'analyze') return;
  const spec = msg.spec ?? DEFAULT_PROBE;
  const t0 = performance.now();
  const items: AnalyzeResultItem[] = [];
  const transfer: ArrayBuffer[] = [];

  for (const job of msg.jobs) {
    const patch = job.unpacked;
    const probe = renderProbe(patch, spec);
    const full = extractAcoustic(probe);
    const structural = extractStructural(patch);
    const vector = buildVector(full, structural);
    const cat = categorize(full, structural, voiceName(patch));
    const { segments: _segments, ...acoustic } = full;
    items.push({
      id: job.id,
      acoustic,
      structural,
      vector,
      category: cat.best,
      subcategory: cat.sub,
      categoryConfidence: cat.confidence,
      silent: full.silent,
    });
    transfer.push(vector.buffer as ArrayBuffer);
  }

  const response: AnalyzeResponse = { type: 'analyzed', batchId: msg.batchId, items, ms: performance.now() - t0 };
  (self as unknown as Worker).postMessage(response, transfer);
};
