/*
 * Corpus screen: bring files in, run the analysis pass, and choose the
 * near-duplicate threshold.
 *
 * The threshold is deliberately not hard-coded. The sweep table shows what each
 * value would actually do to this corpus - how many clusters, how many voices
 * collapse, how big the biggest family gets - and the user picks from that.
 */
import { clear, downloadBytes, el, fmtDuration, fmtInt } from '../dom.ts';
import type { View, ViewContext } from '../app.ts';
import { SIZE_BUCKETS } from '../../cluster/nearDupe.ts';
import { topTerms } from '../../cluster/taste.ts';
import { FEATURE_DEFS } from '../../features/vector.ts';

const SWEEP_POINTS = [0.01, 0.02, 0.03, 0.05, 0.08, 0.12, 0.16, 0.22, 0.3];

let ctx: ViewContext;
let container: HTMLElement;
let unsubscribe: (() => void) | null = null;
let analysisAbort: AbortController | null = null;
let progressLine: HTMLElement | null = null;

function statBlock(k: string, v: string): HTMLElement {
  return el('div', { class: 'stat' }, el('div', { class: 'k' }, k), el('div', { class: 'v' }, v));
}

function dropZone(): HTMLElement {
  const input = el('input', {
    type: 'file',
    multiple: true,
    style: { display: 'none' },
    onchange: () => {
      const files = [...(input.files ?? [])];
      if (files.length) void ingest(files, pinToggle.checked);
      input.value = '';
    },
  });

  const pinToggle = el('input', { type: 'checkbox' }) as HTMLInputElement;

  const zone = el(
    'div',
    { class: 'dropzone' },
    el('div', { style: { fontSize: '15px', marginBottom: '6px' } }, 'Drop .syx files, folders of them, or a .zip archive here'),
    el('div', {}, 'Bulk 32-voice dumps, single voices, headerless banks and raw packed streams are all read. ',
      'DX7II supplements and performance data are skipped.'),
    el('div', { style: { marginTop: '14px' } },
      el('button', { class: 'btn', onclick: () => input.click() }, 'Choose files'),
      input),
    el('label', { class: 'field', style: { justifyContent: 'center', marginTop: '12px' } },
      pinToggle, 'pin these voices into the final 128 regardless of rating'),
  );

  const stop = (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };
  zone.addEventListener('dragover', (e) => {
    stop(e as DragEvent);
    zone.classList.add('over');
  });
  zone.addEventListener('dragleave', (e) => {
    stop(e as DragEvent);
    zone.classList.remove('over');
  });
  zone.addEventListener('drop', (e) => {
    stop(e as DragEvent);
    zone.classList.remove('over');
    const files = [...((e as DragEvent).dataTransfer?.files ?? [])];
    if (files.length) void ingest(files, pinToggle.checked);
  });
  return zone;
}

async function ingest(files: File[], pinned: boolean): Promise<void> {
  ctx.store.setBusy(`reading ${files.length} file${files.length === 1 ? '' : 's'}`);
  try {
    await ctx.store.ingestFiles(files, {
      pinned,
      userSupplied: pinned,
      onProgress: (label, done, total) => ctx.store.setBusy(`reading ${label} (${done + 1}/${total})`),
    });
  } catch (err) {
    alert(`Could not read those files: ${(err as Error).message}`);
  } finally {
    ctx.store.setBusy(null);
  }
}

async function runAnalysis(): Promise<void> {
  analysisAbort = new AbortController();
  try {
    await ctx.store.runAnalysis({
      signal: analysisAbort.signal,
      onProgress: (p) => {
        if (!progressLine) return;
        clear(progressLine);
        progressLine.append(
          el('progress', { max: p.total, value: p.done }),
          el('span', { class: 'muted', style: { marginLeft: '10px' } },
            `${fmtInt(p.done)} / ${fmtInt(p.total)}  ·  ${p.rate.toFixed(0)} voices/s  ·  ${fmtDuration(p.etaMs)} left`),
        );
      },
    });
  } finally {
    analysisAbort = null;
    render();
  }
}

function sweepTable(): HTMLElement {
  const store = ctx.store;
  const rows = store.sweep(SWEEP_POINTS);
  if (rows.length === 0) return el('p', { class: 'muted' }, 'No candidate pairs yet.');

  const wrap = el('div', {});
  wrap.appendChild(el('p', { class: 'hint' },
    'Both settings are cut-offs, not picks: choosing a row means ',
    el('b', {}, 'that distance and everything closer'),
    '. The shaded bands below show what each one currently covers.'));

  const table = el('table', { class: 'data sweep' });
  table.appendChild(el('thead', {}, el('tr', {},
    el('th', {}, ''),
    el('th', {}, 'distance'),
    el('th', { class: 'num' }, 'groups'),
    el('th', { class: 'num' }, 'collapsed'),
    el('th', { class: 'num' }, 'largest'),
    ...SIZE_BUCKETS.map((b) => el('th', { class: 'num' }, `size ${b[2]}`)),
    el('th', {}, 'set as'),
  )));
  const body = el('tbody');

  for (const row of rows) {
    const inMerge = row.threshold <= store.mergeThreshold + 1e-9;
    const inFamily = !inMerge && row.threshold <= store.threshold + 1e-9;
    const isMergeEdge = Math.abs(row.threshold - store.mergeThreshold) < 1e-9;
    const isFamilyEdge = Math.abs(row.threshold - store.threshold) < 1e-9;

    const zone = inMerge ? 'merged' : inFamily ? 'family' : 'apart';
    const marker = isMergeEdge && isFamilyEdge
      ? 'merge + family cut-off'
      : isMergeEdge ? 'merge cut-off' : isFamilyEdge ? 'family cut-off' : '';

    body.appendChild(el('tr', { class: `zone-${zone}${marker ? ' zone-edge' : ''}` },
      el('td', { class: 'zone-cell' }, el('span', { class: 'zone-bar' }), marker
        ? el('span', { class: 'zone-label' }, marker)
        : null),
      el('td', { class: 'mono' }, row.threshold.toFixed(2)),
      el('td', { class: 'num' }, fmtInt(row.clusters)),
      el('td', { class: 'num' }, fmtInt(row.collapsed)),
      el('td', { class: 'num' }, fmtInt(row.largest)),
      ...row.sizeBuckets.map((n) => el('td', { class: 'num muted' }, fmtInt(n))),
      el('td', { style: { whiteSpace: 'nowrap' } },
        el('button', {
          class: isMergeEdge ? 'btn primary' : 'btn',
          style: { padding: '2px 8px', marginRight: '6px' },
          title: `Treat everything at or below ${row.threshold.toFixed(2)} as the same patch`,
          onclick: () => {
            store.applyThreshold(Math.max(store.threshold, row.threshold), row.threshold);
            render();
          },
        }, 'merge'),
        el('button', {
          class: isFamilyEdge ? 'btn primary' : 'btn',
          style: { padding: '2px 8px' },
          title: `Treat everything at or below ${row.threshold.toFixed(2)} as one face-off family`,
          onclick: () => {
            store.applyThreshold(row.threshold, Math.min(store.mergeThreshold, row.threshold));
            render();
          },
        }, 'family'),
      ),
    ));
  }
  table.appendChild(body);
  wrap.appendChild(table);

  wrap.appendChild(el('div', { class: 'legend', style: { marginTop: '10px' } },
    el('span', {}, el('i', { class: 'swatch-merged' }), 'merged \u2014 treated as the same patch, never compared'),
    el('span', {}, el('i', { class: 'swatch-family' }), 'family \u2014 similar but audibly different, goes to the face-off'),
    el('span', {}, el('i', { class: 'swatch-apart' }), 'apart \u2014 unrelated'),
  ));

  return wrap;
}

function tastePanel(): HTMLElement {
  const store = ctx.store;
  const panel = el('div', { class: 'panel' }, el('h3', { style: { marginTop: 0 } }, 'What your ratings have in common'));
  panel.appendChild(el('p', { class: 'hint' },
    'A linear model fitted from your ratings to the measured features. It is not trying to replace your ears - it is ',
    'answering two things a scatter plot cannot: which measurable properties your high ratings share, and where else ',
    'in the corpus those properties turn up. Features the model finds irrelevant are also down-weighted when deciding ',
    'which patches count as similar.'));

  const model = store.tasteModel;
  if (!model) {
    panel.appendChild(el('p', { class: 'muted' },
      `Needs at least 12 ratings; you have ${fmtInt(store.ratings.size)}.`));
    return panel;
  }

  const quality = model.r2 > 0.25 ? 'good' : model.r2 > 0.08 ? 'warn' : 'muted';
  const verdict = model.r2 > 0.25
    ? 'it has found real structure in your taste'
    : model.r2 > 0.08
      ? 'weak but not nothing'
      : 'no better than guessing the average - rate more, or your taste may just not be a linear function of these features';

  panel.appendChild(el('div', { class: 'stats', style: { marginBottom: '12px' } },
    el('div', { class: 'stat' }, el('div', { class: 'k' }, 'ratings used'), el('div', { class: 'v' }, fmtInt(model.samples))),
    el('div', { class: 'stat' },
      el('div', { class: 'k' }, 'cross-validated R\u00b2'),
      el('div', { class: `v ${quality}` }, model.r2.toFixed(2))),
    el('div', { class: 'stat' }, el('div', { class: 'k' }, 'mean rating'), el('div', { class: 'v' }, model.meanRating.toFixed(2))),
  ));
  panel.appendChild(el('p', { class: quality, style: { marginTop: 0 } }, verdict));

  const { up, down } = topTerms(model, 6);
  const list = (title: string, terms: Array<{ index: number; coefficient: number }>, cls: string) => {
    const box = el('div', { style: { flex: '1', minWidth: '240px' } }, el('h3', {}, title));
    const table = el('table', { class: 'data' });
    const body = el('tbody');
    for (const t of terms) {
      body.appendChild(el('tr', {},
        el('td', {}, FEATURE_DEFS[t.index]?.label ?? String(t.index)),
        el('td', { class: `num ${cls}` }, t.coefficient.toFixed(3)),
      ));
    }
    table.appendChild(body);
    box.appendChild(table);
    return box;
  };
  panel.appendChild(el('div', { class: 'row', style: { alignItems: 'flex-start', gap: '26px' } },
    list('pushes a rating up', up, 'good'),
    list('pushes a rating down', down, 'bad'),
  ));

  panel.appendChild(el('div', { class: 'row', style: { marginTop: '14px' } },
    el('button', {
      class: 'btn',
      onclick: async () => {
        await ctx.store.retrain();
        render();
      },
    }, 'Refit from current ratings'),
    el('label', { class: 'field' }, 'apply to distances',
      el('input', {
        type: 'range', min: 0, max: 100, value: Math.round(store.tasteStrength * 100),
        style: { width: '120px' },
        onchange: (e: Event) => {
          ctx.store.setTasteStrength(Number((e.target as HTMLInputElement).value) / 100);
          render();
        },
      })),
    el('span', { class: 'muted' }, `${Math.round(store.tasteStrength * 100)}%`),
  ));

  if (store.whitener) {
    panel.appendChild(el('p', { class: 'hint', style: { marginTop: '14px', marginBottom: 0 } },
      `Feature space whitened: the raw space was ${store.redundancy.toFixed(1)}x more spread along its dominant `,
      'direction than the average one, which meant whichever property happened to have the most redundant features ',
      `dominated every distance. ${fmtInt(store.whitener.cappedDirections)} near-flat directions were capped rather `,
      'than amplified, since those are mostly noise.'));
  }

  return panel;
}

function exportPanel(): HTMLElement {
  const store = ctx.store;
  const restoreInput = el('input', {
    type: 'file',
    accept: '.json,application/json',
    style: { display: 'none' },
    onchange: async () => {
      const file = restoreInput.files?.[0];
      if (!file) return;
      try {
        const result = await store.importBackup(await file.text());
        alert(
          `Restored ${result.ratings} ratings, ${result.overrides} category overrides and ${result.pinned} pins.` +
          (result.missing ? `
${result.missing} entries referred to voices that are not in this corpus.` : ''),
        );
      } catch (err) {
        alert(`Could not read that backup: ${(err as Error).message}`);
      }
      restoreInput.value = '';
      render();
    },
  }) as HTMLInputElement;

  return el('div', { class: 'panel' },
    el('h3', { style: { marginTop: 0 } }, 'Export and backup'),
    el('p', { class: 'hint' },
      'The deduplicated corpus is written as back-to-back 32-voice bulk dumps in one file, which is what every other DX7 ',
      'tool reads. The session backup is keyed by patch content rather than by row id, so it still applies after the ',
      'corpus has been rebuilt from the original files.'),
    el('div', { class: 'row' },
      el('button', {
        class: 'btn',
        disabled: store.voices.length === 0,
        onclick: () => {
          const { bytes, banks, voices } = store.exportDedupedSyx();
          downloadBytes(bytes, `dx7-deduped-${voices}-voices.syx`);
          alert(`${fmtInt(voices)} unique voices written as ${fmtInt(banks)} banks (${fmtInt(bytes.length)} bytes).`);
        },
      }, `Download deduped corpus (${fmtInt(store.voices.length)} voices)`),
      el('button', {
        class: 'btn',
        disabled: store.ratings.size === 0 && !store.voices.some((v) => v.pinned),
        onclick: () => {
          const blob = new TextEncoder().encode(store.exportBackup());
          downloadBytes(blob, `dx7-curation-backup-${new Date().toISOString().slice(0, 10)}.json`);
        },
      }, 'Download session backup'),
      el('button', { class: 'btn', onclick: () => restoreInput.click() }, 'Restore backup'),
      restoreInput,
    ),
  );
}

function render(): void {
  const store = ctx.store;
  clear(container);
  const page = el('div', { class: 'stack' });

  // ---- ingest ----
  page.appendChild(el('div', { class: 'panel' },
    el('h2', {}, 'Corpus'),
    el('p', { class: 'hint' },
      'Everything here stays on this machine. Voices are deduplicated on the packed bytes with the name field excluded, ',
      'so the same patch under twenty different names collapses to one - and every name and source it arrived under is kept.'),
    dropZone(),
  ));

  if (store.lastIngest) {
    const s = store.lastIngest;
    const panel = el('div', { class: 'panel' },
      el('h3', { style: { marginTop: '0' } }, 'Last import'),
      el('div', { class: 'stats' },
        statBlock('files', fmtInt(s.files)),
        statBlock('voices read', fmtInt(s.voicesRead)),
        statBlock('new', fmtInt(s.added)),
        statBlock('already known', fmtInt(s.merged)),
        statBlock('init / silent', fmtInt(s.rejected)),
        statBlock('bytes clamped', fmtInt(s.clampedBytes)),
        statBlock('checksum fails', fmtInt(s.checksumFailures)),
      ),
    );
    if (s.skipped.length) {
      panel.appendChild(el('h3', {}, 'Skipped'));
      const ul = el('ul', { class: 'muted', style: { margin: '0', paddingLeft: '18px' } });
      for (const sk of s.skipped) ul.appendChild(el('li', {}, `${sk.reason}: ${fmtInt(sk.count)}`));
      panel.appendChild(ul);
    }
    if (s.errors.length) {
      panel.appendChild(el('h3', { class: 'bad' }, 'Errors'));
      const ul = el('ul', { class: 'bad', style: { margin: '0', paddingLeft: '18px' } });
      for (const e of s.errors.slice(0, 12)) ul.appendChild(el('li', {}, `${e.file}: ${e.error}`));
      if (s.errors.length > 12) ul.appendChild(el('li', {}, `and ${s.errors.length - 12} more`));
      panel.appendChild(ul);
    }
    if (s.checksumFailures > 0) {
      panel.appendChild(el('p', { class: 'warn', style: { marginBottom: 0 } },
        `${fmtInt(s.checksumFailures)} voices came from a dump whose checksum did not verify. They were kept anyway - `,
        'a bad checksum usually means a sloppy archiver rather than corrupt patch data - but they are worth a listen.'));
    }
    page.appendChild(panel);
  }

  if (store.voices.length === 0) {
    container.appendChild(page);
    return;
  }

  // ---- analysis ----
  const analysisPanel = el('div', { class: 'panel' }, el('h3', { style: { marginTop: 0 } }, 'Analysis'));
  const pending = store.voices.length - store.analysedCount;
  analysisPanel.appendChild(el('p', { class: 'hint' },
    'Each voice is rendered at three pitches and two velocities, held then released, plus once more with the mod wheel ',
    'up so its response to the wheel can be measured rather than guessed. No audio is kept.'));
  if (store.staleFeatures > 0) {
    analysisPanel.appendChild(el('p', { class: 'warn' },
      `${fmtInt(store.staleFeatures)} voices were analysed by an earlier build whose feature set was different. `,
      'Those results were discarded rather than patched up, since a half-filled vector would corrupt every distance. ',
      'Ratings, pins and category overrides are untouched - only the rendering needs redoing.'));
  }
  progressLine = el('div', { class: 'row' });
  if (store.busy && analysisAbort) {
    analysisPanel.appendChild(progressLine);
    analysisPanel.appendChild(el('div', { class: 'row', style: { marginTop: '10px' } },
      el('button', { class: 'btn danger', onclick: () => analysisAbort?.abort() }, 'Stop')));
  } else {
    analysisPanel.appendChild(el('div', { class: 'row' },
      el('button', {
        class: 'btn primary',
        disabled: pending === 0,
        onclick: () => void runAnalysis(),
      }, pending === 0 ? 'All voices analysed' : `Analyse ${fmtInt(pending)} voices`),
      el('span', { class: 'muted' },
        `${fmtInt(store.analysedCount)} of ${fmtInt(store.voices.length)} done`),
    ));
    analysisPanel.appendChild(progressLine);
  }
  page.appendChild(analysisPanel);

  // ---- clustering ----
  if (store.analysisComplete) {
    const clusterPanel = el('div', { class: 'panel' }, el('h3', { style: { marginTop: 0 } }, 'Near-duplicates'));
    clusterPanel.appendChild(el('p', { class: 'hint' },
      'Distance combines the audio features with parameter distance, scaled so an unrelated pair sits near 1.0. ',
      'There are two thresholds, and both are picked from what they do to this corpus rather than from a default.'));
    clusterPanel.appendChild(el('ul', { class: 'hint', style: { paddingLeft: '18px' } },
      el('li', {}, el('b', {}, 'merge'), ' — below this, voices are treated as the same patch. They collapse to one point ',
        'on the map, one entry in the rating queue, and never reach the face-off, because there would be nothing to hear.'),
      el('li', {}, el('b', {}, 'family'), ' — below this, voices are similar but still audibly different. One representative ',
        'is rated; if it scores well, the rest of the family goes to the face-off.'),
    ));

    if (!store.graph) {
      clusterPanel.appendChild(el('button', {
        class: 'btn primary',
        onclick: async () => {
          await ctx.store.buildClusters({
            onProgress: (done, total, stage) => ctx.store.setBusy(`${stage} ${total ? Math.round((done / total) * 100) : 0}%`),
          });
          render();
        },
      }, 'Find near-duplicates'));
    } else {
      clusterPanel.appendChild(el('div', { class: 'row', style: { marginBottom: '12px' } },
        el('span', {}, `${fmtInt(store.graph.a.length)} candidate pairs in ${fmtInt(store.graph.blocks)} blocks`),
        store.graph.truncated ? el('span', { class: 'warn' }, 'edge list was truncated; raise the limit or lower the max distance') : null,
        el('button', {
          class: 'btn',
          onclick: async () => {
            await ctx.store.buildClusters({});
            render();
          },
        }, 'Recompute'),
      ));
      clusterPanel.appendChild(sweepTable());
      if (store.clusters && store.mergeClusters) {
        clusterPanel.appendChild(el('p', { style: { marginBottom: 0, marginTop: '12px' } },
          `Merging at ${store.mergeThreshold.toFixed(2)} leaves `,
          el('b', {}, fmtInt(store.mergeClusters.clusterCount)),
          ' distinct sounds from ', fmtInt(store.voices.length), ' voices. ',
          `Grouping into families at ${store.threshold.toFixed(2)} gives `,
          el('b', {}, fmtInt(store.clusters.clusterCount)),
          ' representatives to rate in round one.'));
      }
    }
    page.appendChild(clusterPanel);
  }

  if (store.analysisComplete) page.appendChild(tastePanel());
  page.appendChild(exportPanel());

  // ---- danger zone ----
  page.appendChild(el('div', { class: 'panel' },
    el('h3', { style: { marginTop: 0 } }, 'Start over'),
    el('div', { class: 'row', style: { marginBottom: '14px' } },
      el('button', {
        class: 'btn danger',
        disabled: store.ratings.size === 0 && store.faceoffExtras.size === 0,
        onclick: async () => {
          if (!confirm(
            `Delete all ${store.ratings.size} ratings and ${store.faceoffExtras.size} face-off results?

` +
            'The corpus and its analysis are kept, so nothing has to be re-rendered - but every judgement you have ' +
            'made is gone. Download a session backup first if you might want it back.',
          )) return;
          await ctx.store.resetRatings();
          render();
        },
      }, `Reset all ratings (${fmtInt(store.ratings.size)})`),
      el('span', { class: 'muted' }, 'keeps the corpus and the analysis'),
    ),
    el('p', { class: 'hint' }, 'Deletes the voice table, the features and every rating.'),
    el('button', {
      class: 'btn danger',
      onclick: async () => {
        if (!confirm('Delete all voices, features and ratings? This cannot be undone.')) return;
        await ctx.store.reset();
        render();
      },
    }, 'Delete everything'),
  ));

  container.appendChild(page);
}

export const view: View = {
  mount(el_, c) {
    ctx = c;
    container = el_;
    unsubscribe = c.store.subscribe(() => {
      // Only re-render wholesale when not mid-analysis; the progress line
      // updates itself and a full rebuild would fight the user's scroll.
      if (!analysisAbort) render();
    });
    render();
  },
  unmount() {
    unsubscribe?.();
    unsubscribe = null;
    analysisAbort?.abort();
  },
};
