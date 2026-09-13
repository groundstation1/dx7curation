/*
 * Neighbourhood map worker.
 *
 * Two passes that between them take a few seconds on a large corpus: the
 * nearest-neighbour graph, then the force layout over it. Neither can yield,
 * both are pure arithmetic over typed arrays, and a few seconds of frozen tab
 * is a few seconds too many - so they happen here and report as they go.
 *
 * Only the distance matrix crosses the wire, and it crosses as a transfer, so
 * nothing is copied.
 */
import { buildKnn } from '../cluster/neighbours.ts';
import { embed } from '../cluster/embed.ts';

export interface EmbedRequest {
  type: 'embed';
  data: Float32Array;
  n: number;
  dim: number;
  init?: Float32Array;
  k?: number;
  epochs?: number;
  minDist?: number;
}

export interface EmbedProgress {
  type: 'progress';
  done: number;
  total: number;
  stage: string;
}

export interface EmbedDone {
  type: 'done';
  coords: Float32Array;
  ms: number;
}

export interface EmbedFailed {
  type: 'failed';
  message: string;
}

export type EmbedResponse = EmbedProgress | EmbedDone | EmbedFailed;

self.onmessage = (ev: MessageEvent<EmbedRequest>) => {
  const req = ev.data;
  if (req.type !== 'embed') return;
  const started = performance.now();
  const post = (m: EmbedResponse, transfer: Transferable[] = []) =>
    (self as unknown as Worker).postMessage(m, transfer);

  try {
    // The two passes are roughly one to three in cost, so the reported
    // fraction is split that way rather than each running 0 to 100.
    const KNN_SHARE = 0.3;
    const knn = buildKnn(req.data, req.n, req.dim, {
      k: req.k,
      onProgress: (pass, total) => {
        post({ type: 'progress', done: Math.round(pass * KNN_SHARE * 100 / total), total: 100, stage: 'finding neighbours' });
      },
    });

    const coords = embed(knn, {
      init: req.init,
      epochs: req.epochs,
      minDist: req.minDist,
      onProgress: (epoch, total) => {
        // Every tenth epoch: posting four hundred messages achieves nothing
        // except making the main thread do the work the worker was avoiding.
        if (epoch % 10 !== 0 && epoch !== total) return;
        post({
          type: 'progress',
          done: Math.round((KNN_SHARE + (1 - KNN_SHARE) * (epoch / total)) * 100),
          total: 100,
          stage: 'settling the layout',
        });
      },
    });

    post({ type: 'done', coords, ms: performance.now() - started }, [coords.buffer]);
  } catch (err) {
    post({ type: 'failed', message: err instanceof Error ? err.message : String(err) });
  }
};
