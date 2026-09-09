/*
 * Near-duplicate worker.
 *
 * The pass is a few tens of millions of distance computations and, on a corpus
 * of 36,000 voices, minutes rather than seconds. Run on the main thread it took
 * the UI with it: the progress callbacks fired, but nothing repainted between
 * them, so the honest report of what it was doing arrived all at once when it
 * had already finished. A tab that is frozen for two minutes is indisting-
 * uishable from one that has crashed.
 *
 * So it runs here, posts progress as it goes, and can be killed by terminating
 * the worker. Only the feature matrix and the packed parameters cross the wire.
 */
import { buildNearDupeGraph, type NearDupeGraph, type NearDupeOptions } from '../cluster/nearDupe.ts';

export interface DupeRequest {
  type: 'dupe';
  data: Float32Array;
  n: number;
  dim: number;
  unpacked: Uint8Array[];
  opts: Omit<NearDupeOptions, 'onProgress'>;
}

export interface DupeProgress {
  type: 'progress';
  done: number;
  total: number;
  stage: string;
}

export interface DupeDone {
  type: 'done';
  graph: NearDupeGraph;
  ms: number;
}

export interface DupeFailed {
  type: 'failed';
  message: string;
}

export type DupeResponse = DupeProgress | DupeDone | DupeFailed;

/**
 * At most this often, so a fast stage cannot flood the main thread with
 * messages it will only throw away.
 */
const PROGRESS_MS = 120;

self.onmessage = (ev: MessageEvent<DupeRequest>) => {
  const msg = ev.data;
  if (msg.type !== 'dupe') return;
  const t0 = performance.now();
  let lastPost = 0;

  try {
    const graph = buildNearDupeGraph(msg.data, msg.n, msg.dim, msg.unpacked, {
      ...msg.opts,
      onProgress: (done, total, stage) => {
        const now = performance.now();
        if (now - lastPost < PROGRESS_MS) return;
        lastPost = now;
        const out: DupeProgress = { type: 'progress', done, total, stage };
        self.postMessage(out);
      },
    });
    const done: DupeDone = { type: 'done', graph, ms: performance.now() - t0 };
    self.postMessage(done, [graph.a.buffer, graph.b.buffer, graph.d.buffer]);
  } catch (err) {
    const failed: DupeFailed = { type: 'failed', message: (err as Error).message };
    self.postMessage(failed);
  }
};
