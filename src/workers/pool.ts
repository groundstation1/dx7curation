/*
 * A small worker pool for the analysis pass.
 *
 * Batches are handed out one at a time per worker rather than split up front,
 * so a worker that lands a run of expensive patches does not hold up the rest.
 */
import type { AnalyzeRequest, AnalyzeResponse, AnalyzeResultItem } from './analyze.worker.ts';
import type { ProbeSpec } from '../render/probe.ts';

export interface AnalyzeJob {
  id: number;
  unpacked: Uint8Array;
}

export interface PoolProgress {
  done: number;
  total: number;
  /** Voices per second, averaged over the run so far. */
  rate: number;
  elapsedMs: number;
  etaMs: number;
}

export interface AnalyzePoolOptions {
  spec?: ProbeSpec;
  workers?: number;
  batchSize?: number;
  onProgress?: (p: PoolProgress) => void;
  onBatch?: (items: AnalyzeResultItem[]) => void | Promise<void>;
  signal?: AbortSignal;
}

export function suggestedWorkerCount(): number {
  const cores = navigator.hardwareConcurrency || 4;
  // Leave one core for the UI thread and the audition worker.
  return Math.max(1, Math.min(cores - 1, 12));
}

export async function analyzeAll(jobs: AnalyzeJob[], opts: AnalyzePoolOptions = {}): Promise<AnalyzeResultItem[]> {
  const workerCount = Math.max(1, Math.min(opts.workers ?? suggestedWorkerCount(), jobs.length || 1));
  const batchSize = opts.batchSize ?? 24;
  const results: AnalyzeResultItem[] = [];
  if (jobs.length === 0) return results;

  const batches: AnalyzeJob[][] = [];
  for (let i = 0; i < jobs.length; i += batchSize) batches.push(jobs.slice(i, i + batchSize));

  const workers: Worker[] = [];
  for (let i = 0; i < workerCount; i++) {
    workers.push(new Worker(new URL('./analyze.worker.ts', import.meta.url), { type: 'module' }));
  }

  const started = performance.now();
  let nextBatch = 0;
  let done = 0;
  let aborted = false;

  const report = () => {
    const elapsedMs = performance.now() - started;
    const rate = done / (elapsedMs / 1000);
    opts.onProgress?.({
      done,
      total: jobs.length,
      rate,
      elapsedMs,
      etaMs: rate > 0 ? ((jobs.length - done) / rate) * 1000 : 0,
    });
  };

  let onAbort: (() => void) | null = null;
  try {
    await new Promise<void>((resolve, reject) => {
      let active = 0;

      onAbort = () => {
        aborted = true;
        resolve();
      };
      opts.signal?.addEventListener('abort', onAbort, { once: true });

      const pump = (w: Worker) => {
        if (aborted || nextBatch >= batches.length) {
          if (active === 0 && (aborted || nextBatch >= batches.length)) resolve();
          return;
        }
        const batch = batches[nextBatch++];
        active++;
        const req: AnalyzeRequest = { type: 'analyze', batchId: nextBatch, jobs: batch, spec: opts.spec };
        w.postMessage(req);
      };

      for (const w of workers) {
        w.onmessage = (ev: MessageEvent<AnalyzeResponse>) => {
          active--;
          const items = ev.data.items;
          results.push(...items);
          done += items.length;
          report();
          void Promise.resolve(opts.onBatch?.(items)).then(() => pump(w));
        };
        w.onerror = (err) => {
          reject(new Error(`analysis worker failed: ${err.message}`));
        };
      }
      for (const w of workers) pump(w);
    });
  } finally {
    if (onAbort) opts.signal?.removeEventListener('abort', onAbort);
    for (const w of workers) w.terminate();
  }

  return results;
}
