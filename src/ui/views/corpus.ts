/*
 * Sources: bring patches in, and let the app get them ready.
 *
 * This screen used to be a worklist. You dropped files, then pressed Analyse
 * and waited, then pressed Find near-duplicates and waited, then read a table
 * of nine distances and chose two of them - four decisions and about four
 * hundred words of explanation before anything was listenable. Every one of
 * those steps has a right answer nearly all of the time.
 *
 * So it runs itself. Dropping files starts the analysis, the analysis starts
 * the near-duplicate pass, and the thresholds take the defaults that have held
 * up across every corpus tried so far. All of it reports through the one
 * progress bar and all of it can be stopped. The sweep table that used to be
 * the point of the screen is still here, under the advanced switch, for when
 * you want to disagree with the defaults - which is a thing worth doing, just
 * not a thing worth requiring.
 */
import { clear, downloadBytes, el, fmtInt, pageHead, patchFile } from '../dom.ts';
import type { View, ViewContext } from '../app.ts';
import { adv, disclosure, isAdvanced } from '../advanced.ts';
import { getSetting, setSetting } from '../settings.ts';
import { Store } from '../state.ts';
import { SIZE_BUCKETS } from '../../cluster/nearDupe.ts';
import { listenForSysex, listInputs, midiSupported, requestBulkDump, requestMidi, type MidiPort } from '../../midi/webmidi.ts';
import { parseSysexFile } from '../../sysex/parse.ts';
import { topTerms } from '../../cluster/taste.ts';
import { CATEGORY_LABELS, type Category } from '../../cluster/category.ts';
import { categoryColour } from '../colour.ts';
import { FEATURE_DEFS } from '../../features/vector.ts';
import { rankSources, sortSources, SOURCE_LEVELS, type SourceLevel, type SourceScore } from '../sourceRanking.ts';
import { ratingColour } from '../colour.ts';
import { runTask } from '../task.ts';

const SWEEP_POINTS = [0.01, 0.02, 0.03, 0.05, 0.08, 0.12, 0.16, 0.22, 0.3];

/** How many sources the table shows before it stops. */
const SOURCE_ROWS = 24;

/** Where to get a lot of patches at once, for someone who has none. */
const BULK_SOURCE = 'https://bobbyblues.recup.ch/yamaha_dx7/dx7_patches.html';

let ctx: ViewContext;
let container: HTMLElement;
let unsubscribe: (() => void) | null = null;
let analysisAbort: AbortController | null = null;
let dupeAbort: AbortController | null = null;
let embedAbort: AbortController | null = null;
/** Set while the chain is running, and cleared if any step is cancelled. */
let advancing = false;
let lastNote = '';
/** Device read-back: which output to ask, and what has arrived so far. */
let deviceOutputs: MidiPort[] = [];
let deviceOutputId = '';
let deviceChannel = 1;
let listening: (() => void) | null = null;
let deviceLog: string[] = [];
let deviceBanks: Array<{ bytes: Uint8Array; from: string; voices: number; at: number }> = [];

function statBlock(k: string, v: string): HTMLElement {
  return el('div', { class: 'stat' }, el('div', { class: 'k' }, k), el('div', { class: 'v' }, v));
}

// ------------------------------------------------------------------ intake

function dropZone(big: boolean): HTMLElement {
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
    el('div', { class: big ? 'drop-big' : '' }, 'Drop .syx files, folders or a .zip here'),
    el('div', { style: { marginTop: big ? '14px' : '10px' } },
      el('button', { class: big ? 'btn primary big' : 'btn', onclick: () => input.click() }, 'Choose files'),
      input),
    // Pinning on import is how you say "these are mine, keep them" before you
    // have listened to anything. Hidden until asked for, since the common case
    // is dropping an archive you have never heard.
    adv(el('label', { class: 'field', style: { justifyContent: 'center', marginTop: '12px' } },
      pinToggle, 'pin these into the final 128 regardless of rating')),
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

/**
 * The whole screen, when there is nothing in the corpus yet.
 *
 * The restore line is not decoration. Coming back to an empty browser with a
 * saved session in hand is the second most likely reason to be on this screen,
 * and an onboarding page that only offers .syx files leaves that person with
 * nowhere to put their file.
 */
function onboarding(): HTMLElement {
  return el('div', { class: 'onboard' },
    el('h1', {}, 'Start with some patches'),
    el('p', { class: 'lede' }, 'Everything stays on this machine. Nothing is uploaded.'),
    dropZone(true),
    el('div', { class: 'tipoff' },
      el('div', {}, 'Want a lot at once? Take ', el('b', {}, 'ALL THE WEB PATCHES'), ' from ',
        el('a', { href: BULK_SOURCE, target: '_blank', rel: 'noreferrer' }, 'bobbyblues.recup.ch'),
        ' and drop the zip straight in.'),
      el('div', { class: 'muted', style: { marginTop: '6px' } },
        'About 40,000 voices. Duplicates collapse on import, and the rest is automatic.')),
    el('div', { style: { marginTop: '18px' } }, exportPanel()),
  );
}

async function ingest(files: File[], pinned: boolean): Promise<void> {
  try {
    await ctx.store.ingestFiles(files, { pinned, userSupplied: pinned });
  } catch (err) {
    lastNote = `Could not read those files: ${(err as Error).message}`;
    render();
    return;
  }
  void autoAdvance();
}

// ------------------------------------------------------------- the pipeline

/** True when the app is allowed to run the slow passes without being asked. */
function autoPipeline(): boolean {
  return getSetting('pipeline.auto', true);
}

async function runAnalysis(): Promise<void> {
  analysisAbort = new AbortController();
  try {
    await ctx.store.runAnalysis({ signal: analysisAbort.signal });
  } finally {
    analysisAbort = null;
    render();
  }
}

async function runDupes(): Promise<void> {
  if (dupeAbort) return;
  dupeAbort = new AbortController();
  render();
  try {
    await ctx.store.buildClusters({ signal: dupeAbort.signal });
  } catch (err) {
    if ((err as Error).name !== 'AbortError') lastNote = `Near-duplicate pass failed: ${(err as Error).message}`;
    throw err;
  } finally {
    dupeAbort = null;
    render();
  }
}

async function runEmbedding(): Promise<void> {
  if (embedAbort) return;
  embedAbort = new AbortController();
  render();
  try {
    await ctx.store.buildEmbedding({ signal: embedAbort.signal });
  } catch (err) {
    if ((err as Error).name !== 'AbortError') lastNote = `Laying out the map failed: ${(err as Error).message}`;
    throw err;
  } finally {
    embedAbort = null;
    render();
  }
}

/**
 * Carry the corpus as far as it can go on its own.
 *
 * Analysis, then near-duplicates, then the map layout - each only if it has
 * not already been done. Cancelling one stops the chain rather than rolling
 * straight into the next thing you just said no to.
 *
 * The layout is in the chain rather than behind a button because it is the
 * default view, and being told on arrival that the map you are looking at is
 * the second best one and the good one is a button elsewhere is not a choice
 * worth offering. It is also why adding patches re-runs it: the coordinates
 * are per-voice, so new arrivals have no position at all until it does.
 */
async function autoAdvance(): Promise<void> {
  if (advancing || !autoPipeline()) {
    render();
    return;
  }
  advancing = true;
  try {
    if (ctx.store.voices.length > 0 && !ctx.store.analysisComplete) await runAnalysis();
    if (ctx.store.analysisComplete && !ctx.store.graph) await runDupes();
    if (ctx.store.analysisComplete && !ctx.store.embedding && ctx.store.voices.length > 8) await runEmbedding();
  } catch {
    // Cancelled, or failed and already reported. Either way the chain stops
    // and the buttons come back so it can be started again by hand.
  } finally {
    advancing = false;
    render();
  }
}

/** Analysis and de-duplication, as one line of status and at most one button. */
function pipelinePanel(): HTMLElement {
  const store = ctx.store;
  const panel = el('div', { class: 'panel' });
  const pending = store.voices.length - store.analysedCount;
  const running = analysisAbort !== null || dupeAbort !== null || embedAbort !== null;

  const state = running
    ? 'working'
    : pending > 0
      ? 'needs analysis'
      : !store.graph
        ? 'needs de-duplication'
        : !store.embedding
          ? 'needs a map'
          : 'ready';

  panel.appendChild(el('div', { class: 'row' },
    el('h2', { style: { margin: 0 } }, state === 'ready' ? 'Ready' : 'Getting ready'),
    el('div', { style: { flex: '1' } }),

    running
      ? el('button', {
        class: 'btn danger',
        onclick: () => {
          analysisAbort?.abort();
          dupeAbort?.abort();
          embedAbort?.abort();
        },
      }, 'Stop')
      : state !== 'ready'
        ? el('button', { class: 'btn primary', onclick: () => void autoAdvance() },
          pending > 0
            ? `Analyse ${fmtInt(pending)} voices`
            : !store.graph ? 'Find near-duplicates' : 'Lay out the map')
        : null,
  ));

  const bits: string[] = [];
  bits.push(`${fmtInt(store.analysedCount)} of ${fmtInt(store.voices.length)} analysed`);
  if (store.clusters && store.mergeClusters) {
    bits.push(`${fmtInt(store.mergeClusters.clusterCount)} distinct sounds`);
    bits.push(`${fmtInt(store.clusters.clusterCount)} families to rate`);
  }
  if (store.embedding) bits.push('neighbourhood map ready');
  panel.appendChild(el('p', { class: 'hint', style: { margin: '6px 0 0' } }, bits.join('  ·  ')));

  if (store.staleFeatures > 0) {
    panel.appendChild(el('p', { class: 'warn', style: { margin: '8px 0 0' } },
      `${fmtInt(store.staleFeatures)} voices were analysed by an older build and have to be redone. `,
      'Ratings and pins are untouched.'));
  }

  /*
   * The neighbourhood layout, offered rather than run.
   *
   * It is a few seconds of work and the map has a perfectly usable projection
   * without it, so it is not part of the automatic pipeline. It is here rather
   * than on the map because this is where the other expensive passes live.
   */
  if (!running && store.embedding) {
    const redo = el('div', { class: 'row', style: { marginTop: '10px' } },
      el('button', { class: 'btn', onclick: () => void runEmbedding().catch(() => {}) }, 'Lay out the map again'),
      el('span', { class: 'note', style: { flex: '1 1 260px' } },
        'It settles from a fixed start, so this gives the same answer unless the corpus changed.'),
    );
    panel.appendChild(adv(redo) ?? el('span'));
  }

  if (isAdvanced()) {
    panel.appendChild(el('div', { class: 'row', style: { marginTop: '12px' } },
      el('label', {
        class: 'field',
        title: 'Run the analysis and near-duplicate passes on their own after an import.',
      },
        el('input', {
          type: 'checkbox', checked: autoPipeline(),
          onchange: (e: Event) => {
            setSetting('pipeline.auto', (e.target as HTMLInputElement).checked);
            render();
          },
        }), 'run these automatically'),
      store.graph
        ? el('button', { class: 'btn', onclick: () => void runDupes() }, 'Recompute near-duplicates')
        : null,
    ));
  }

  return panel;
}

// ----------------------------------------------------------- read a device

/**
 * Read what is already on the device, before overwriting it.
 *
 * Sending four banks replaces whatever the unit shipped with, and on a clone
 * whose factory content is not published anywhere that is not recoverable. The
 * dump request is the polite way to ask; whether anything answers is up to the
 * device, so the listener runs regardless - on a unit that ignores requests,
 * starting the transmit from its own front panel produces the same bytes and
 * lands here just the same.
 */
function startListening(): void {
  if (listening) return;
  deviceLog = ['listening for a bank…'];
  listening = listenForSysex(({ bytes, from }) => {
    // Anything that is not a voice dump is worth reporting rather than
    // swallowing: it is how you find out the device answered with something
    // else, which is the interesting failure.
    const parsed = parseSysexFile(bytes, `device (${from})`);
    if (parsed.voices.length > 0) {
      deviceBanks.push({ bytes, from, voices: parsed.voices.length, at: Date.now() });
      deviceLog.push(`${fmtInt(parsed.voices.length)} voices from ${from} (${fmtInt(bytes.length)} bytes)`);
    } else {
      const head = [...bytes.slice(0, 5)].map((b) => b.toString(16).padStart(2, '0')).join(' ');
      deviceLog.push(`${fmtInt(bytes.length)} bytes from ${from}, no voices in it (starts ${head})`);
    }
    render();
  });
  render();
}

function stopListening(): void {
  listening?.();
  listening = null;
  render();
}

/** Everything received so far, as one file the normal import path can read. */
async function keepDeviceBanks(pinned: boolean): Promise<void> {
  if (deviceBanks.length === 0) return;
  const total = deviceBanks.reduce((n, b) => n + b.bytes.length, 0);
  const all = new Uint8Array(total);
  let at = 0;
  for (const b of deviceBanks) {
    all.set(b.bytes, at);
    at += b.bytes.length;
  }
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  const file = new File([all as BlobPart], `device-readback-${stamp}.syx`, { type: 'application/octet-stream' });
  deviceBanks = [];
  await ingest([file], pinned);
}

function devicePanel(): HTMLElement {
  const panel = el('div', {});
  if (!midiSupported()) {
    return el('p', { class: 'muted' }, 'This browser has no WebMIDI, so nothing can be read back here.');
  }
  panel.appendChild(el('div', { class: 'row' },
    el('button', {
      class: 'btn',
      onclick: async () => {
        const state = await requestMidi();
        deviceOutputs = state.outputs;
        deviceOutputId = deviceOutputs[0]?.id ?? '';
        deviceLog.push(state.error ?? `${deviceOutputs.length} out, ${listInputs().length} in`);
        render();
      },
    }, deviceOutputs.length ? 'Rescan MIDI' : 'Connect MIDI'),
    deviceOutputs.length
      ? el('select', {
        onchange: (e: Event) => { deviceOutputId = (e.target as HTMLSelectElement).value; },
      }, ...deviceOutputs.map((o) => el('option', { value: o.id, selected: o.id === deviceOutputId }, `${o.name} ${o.manufacturer}`.trim())))
      : null,
    el('label', { class: 'field', title: 'The MIDI channel the device transmits on, 1 to 16.' }, 'channel',
      el('input', {
        type: 'number', min: 1, max: 16, value: deviceChannel,
        style: { width: '58px' },
        onchange: (e: Event) => { deviceChannel = Number((e.target as HTMLInputElement).value); },
      })),
    el('button', {
      class: listening ? 'btn on' : 'btn',
      onclick: () => (listening ? stopListening() : startListening()),
    }, listening ? 'Stop listening' : 'Listen'),
    el('button', {
      class: 'btn',
      disabled: !deviceOutputId,
      onclick: () => {
        startListening();
        try {
          requestBulkDump(deviceOutputId, Math.max(0, Math.min(15, deviceChannel - 1)));
          deviceLog.push(`asked for a 32-voice dump on channel ${deviceChannel}`);
        } catch (err) {
          deviceLog.push((err as Error).message);
        }
        render();
      },
    }, 'Request a dump'),
  ));

  if (deviceBanks.length) {
    const voices = deviceBanks.reduce((n, b) => n + b.voices, 0);
    panel.appendChild(el('div', { class: 'row', style: { marginTop: '12px' } },
      el('b', {}, `${fmtInt(voices)} voices in ${fmtInt(deviceBanks.length)} dump${deviceBanks.length === 1 ? '' : 's'}`),
      el('button', { class: 'btn', onclick: () => void keepDeviceBanks(false) }, 'Add to corpus'),
      el('button', {
        class: 'btn',
        onclick: () => {
          const total = deviceBanks.reduce((n, b) => n + b.bytes.length, 0);
          const all = new Uint8Array(total);
          let at = 0;
          for (const b of deviceBanks) {
            all.set(b.bytes, at);
            at += b.bytes.length;
          }
          downloadBytes(all, patchFile(`DX7 device read-back ${new Date().toISOString().slice(0, 10)}`));
        },
      }, 'Download as .syx'),
      el('button', {
        class: 'btn danger',
        onclick: () => {
          deviceBanks = [];
          render();
        },
      }, 'Discard'),
    ));
  }

  if (deviceLog.length) {
    panel.appendChild(el('div', { class: 'muted mono', style: { fontSize: '11.5px', marginTop: '10px' } },
      ...deviceLog.slice(-6).map((line) => el('div', {}, line))));
  }
  return panel;
}

// --------------------------------------------------------- the sweep table

function sweepTable(): HTMLElement {
  const store = ctx.store;
  const rows = store.sweep(SWEEP_POINTS);
  if (rows.length === 0) return el('p', { class: 'muted' }, 'No candidate pairs yet.');

  const wrap = el('div', {});
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
          class: isMergeEdge ? 'btn on' : 'btn',
          style: { padding: '2px 8px', marginRight: '6px' },
          title: `Treat everything at or below ${row.threshold.toFixed(2)} as the same patch`,
          onclick: () => {
            store.applyThreshold(Math.max(store.threshold, row.threshold), row.threshold);
            render();
          },
        }, 'merge'),
        el('button', {
          class: isFamilyEdge ? 'btn on' : 'btn',
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
    el('span', {}, el('i', { class: 'swatch-merged' }), 'merged'),
    el('span', {}, el('i', { class: 'swatch-family' }), 'family'),
    el('span', {}, el('i', { class: 'swatch-apart' }), 'unrelated'),
  ));

  return wrap;
}

// ------------------------------------------------- where the good ones are

let sourceLevel: SourceLevel = getSetting<SourceLevel>('sources.level', 'archive');
let sourceBy: 'score' | 'expected' = getSetting<'score' | 'expected'>('sources.by', 'score');
let sourceWorst = false;
let sourceRows: SourceScore[] | null = null;

/**
 * Which of the files you dropped in were worth it.
 *
 * Ranking is in sourceRanking.ts, including why the order is not by the
 * average you can see. This is the table and the three controls.
 */
function sourcePanel(): HTMLElement {
  const wrap = el('div', {});
  const body = el('div', {});

  const compute = async () => {
    const store = ctx.store;
    const wantPredictions = sourceBy === 'expected' && store.tasteModel !== null;
    if (wantPredictions) {
      const all = store.voices.map((_, i) => i);
      await runTask('guessing what is in each file', async (task) => {
        await store.fillPredictions(all, async (done, total) => {
          task.set(total ? done / total : null, `${fmtInt(done)} of ${fmtInt(total)}`);
          await new Promise((r) => setTimeout(r, 0));
        });
      });
    }
    sourceRows = rankSources({
      count: store.voices.length,
      filesOf: (i) => store.voices[i].sources.map((src) => src.file),
      ratingOf: (i) => store.effectiveRating(i),
      predictedOf: wantPredictions ? (i) => store.predictedRating(i) : undefined,
      level: sourceLevel,
    });
  };

  const fill = () => {
    clear(body);
    const rows = sortSources(sourceRows ?? [], sourceBy, sourceWorst)
      .filter((r) => (sourceBy === 'score' ? r.score !== null : r.expected !== null));
    if (rows.length === 0) {
      body.appendChild(el('p', { class: 'muted' }, sourceBy === 'score'
        ? 'Rate a few patches and this fills in.'
        : 'The model needs a few more ratings before it can guess.'));
      return;
    }

    const table = el('table', { class: 'data fixed' });
    table.appendChild(el('thead', {}, el('tr', {},
      el('th', {}, sourceLevel),
      el('th', { class: 'num src-num' }, 'voices'),
      el('th', { class: 'num src-num' }, 'rated'),
      el('th', { class: 'num src-num' }, 'average'),
      el('th', { class: 'num src-num' }, 'expected'),
      el('th', { class: 'src-bar' }, ''),
    )));
    const tbody = el('tbody');
    for (const row of rows.slice(0, SOURCE_ROWS)) {
      const shown = sourceBy === 'score' ? row.average : row.expected;
      const cut = row.key.lastIndexOf('/');
      tbody.appendChild(el('tr', {
        class: 'clickable',
        title: `${row.key}\nClick to browse everything that came from here`,
        onclick: () => void browseSource(row.key),
      },
        el('td', { class: 'src-name' },
          cut >= 0 ? el('span', { class: 'muted' }, row.key.slice(0, cut + 1)) : null,
          el('span', {}, cut >= 0 ? row.key.slice(cut + 1) : row.key)),
        el('td', { class: 'num src-num' }, fmtInt(row.voices)),
        el('td', { class: 'num muted src-num' }, row.rated > 0 ? fmtInt(row.rated) : '-'),
        el('td', { class: 'num src-num' }, row.average === null ? '-' : row.average.toFixed(2)),
        el('td', { class: 'num muted src-num' }, row.expected === null ? '-' : row.expected.toFixed(2)),
        el('td', { class: 'src-bar' }, el('div', { class: 'stat-bar' }, el('i', {
          style: {
            left: '0',
            width: `${Math.max(2, Math.min(1, (shown ?? 0) / 5) * 100)}%`,
            background: ratingColour(Math.round(shown ?? 0)),
          },
        }))),
      ));
    }
    table.appendChild(tbody);
    body.appendChild(table);

    if (rows.length > SOURCE_ROWS) {
      body.appendChild(el('p', { class: 'muted', style: { marginTop: '8px' } },
        `${fmtInt(rows.length - SOURCE_ROWS)} more not shown.`));
    }
  };

  const redraw = async (recompute: boolean) => {
    if (recompute) await compute();
    fill();
  };

  // The direction is a property of the same table, so it updates in place
  // rather than through a rebuild of the screen around it.
  const flip = el('button', {
    class: sourceWorst ? 'btn on' : 'btn',
    title: 'The other end of the list - the folders worth deleting',
    onclick: () => {
      sourceWorst = !sourceWorst;
      flip.className = sourceWorst ? 'btn on' : 'btn';
      flip.textContent = sourceWorst ? 'worst first' : 'best first';
      fill();
    },
  }, sourceWorst ? 'worst first' : 'best first');

  wrap.appendChild(el('div', { class: 'row' },
    el('select', {
      title: 'How much of the path to group by',
      onchange: (e: Event) => {
        sourceLevel = (e.target as HTMLSelectElement).value as SourceLevel;
        setSetting('sources.level', sourceLevel);
        void redraw(true);
      },
    }, ...SOURCE_LEVELS.map((l) => el('option', { value: l.id, selected: l.id === sourceLevel }, `by ${l.label}`))),
    el('select', {
      title: 'Rank by the ratings you gave, or by the model filling in the rest',
      onchange: (e: Event) => {
        sourceBy = (e.target as HTMLSelectElement).value as 'score' | 'expected';
        setSetting('sources.by', sourceBy);
        void redraw(true);
      },
    },
      el('option', { value: 'score', selected: sourceBy === 'score' }, 'by your ratings'),
      el('option', { value: 'expected', selected: sourceBy === 'expected' }, 'by expected'),
    ),
    flip,
  ));
  wrap.appendChild(body);
  wrap.appendChild(el('p', { class: 'note' },
    'Ordered by an average pulled toward the corpus mean, so one lucky five-star patch in a file of three does not beat a folder of sixty good ones.'));

  void redraw(true);
  return wrap;
}

/** Open Browse with everything from one source, using the search's own syntax. */
async function browseSource(key: string): Promise<void> {
  const map = await import('./map.ts');
  map.presetSearch(`"${key}"`);
  ctx.go('map');
}

// ------------------------------------------------------------ save and load

/**
 * Getting things out, and back in.
 *
 * Two files, and the difference between them used to be buried in a paragraph
 * nobody reads: one carries the patches, the other carries only what you
 * decided about them. Restoring the second one into a browser that has never
 * seen the patches matches nothing and looks exactly like a broken button, so
 * both the names and the result now say which is which.
 */
/**
 * Ask a yes/no question inside the page and wait for the answer.
 *
 * The one thing confirm() has over this is that it blocks; the several things
 * this has over confirm() are that it cannot be suppressed by the browser, it
 * cannot be mistaken for a phishing dialog, and it is visible in a screenshot
 * when someone reports that a button did nothing.
 */
function askInPage(host: HTMLElement, question: string): Promise<boolean> {
  return new Promise((resolve) => {
    let answered = false;
    const answer = (value: boolean) => {
      if (answered) return;
      answered = true;
      clear(host);
      resolve(value);
    };
    clear(host);
    host.className = 'warn';
    host.appendChild(el('div', { class: 'row' },
      el('span', {}, question),
      el('button', { class: 'btn', onclick: () => answer(true) }, 'Replace'),
      el('button', { class: 'btn', onclick: () => answer(false) }, 'Cancel'),
    ));
  });
}

function exportPanel(): HTMLElement {
  const store = ctx.store;
  const result = el('div', { class: 'muted', style: { marginTop: '10px' } });

  const restoreInput = el('input', {
    type: 'file',
    accept: '.json,application/json',
    style: { display: 'none' },
    onchange: async () => {
      const file = restoreInput.files?.[0];
      if (!file) return;
      const text = await file.text();
      restoreInput.value = '';
      clear(result);
      try {
        if (Store.isSession(text)) {
          /*
           * Asked in the page, not through confirm().
           *
           * A browser is allowed to suppress confirm() - after a few dialogs
           * Chrome offers to stop showing them, and some embedded contexts
           * never show them at all - and a suppressed confirm() returns false.
           * This used to be `if (!confirm(...)) return;`, so in exactly those
           * browsers loading a session did nothing whatsoever: no dialog, no
           * import, no error, no message. Reproduced with a real hundred-and
           * -sixteen-megabyte session: zero voices, zero exceptions, and the
           * screen unchanged. Stubbing confirm() to true imported all
           * thirty-four thousand of them on the first try.
           *
           * A question drawn in the page cannot be suppressed, and answering
           * no now says so instead of looking like a broken button.
           *
           * And it is only asked when there is something to lose.
           */
          if (store.voices.length > 0) {
            const ok = await askInPage(result,
              `Replace all ${fmtInt(store.voices.length)} patches in this browser with the session in that file?`);
            if (!ok) {
              result.className = 'muted';
              result.textContent = 'Left everything as it was.';
              return;
            }
          }
          const { voices } = await store.importSession(text);
          result.className = 'good';
          result.textContent = `Restored ${fmtInt(voices)} voices and their ratings.`;
          void autoAdvance();
          return;
        }
        const r = await store.importBackup(text);
        const applied = r.ratings + r.overrides + r.pinned;
        result.className = applied > 0 ? 'good' : 'warn';
        result.textContent = applied > 0
          ? `Restored ${fmtInt(r.ratings)} ratings, ${fmtInt(r.overrides)} category overrides and ${fmtInt(r.pinned)} pins.`
            + (r.missing ? ` ${fmtInt(r.missing)} referred to patches this corpus does not have.` : '')
          : `Nothing applied: all ${fmtInt(r.missing)} entries refer to patches that are not in this corpus. `
            + 'This file holds ratings only — import the patches themselves first, or use a full session file.';
      } catch (err) {
        result.className = 'bad';
        result.textContent = `Could not read that file: ${(err as Error).message}`;
      }
      render();
    },
  }) as HTMLInputElement;

  const empty = store.voices.length === 0;
  const panel = el('div', { class: 'panel' },
    el('h2', {}, empty ? 'Or load a file you saved earlier' : 'Save and load'),
    el('div', { class: 'row' },
      empty ? el('button', { class: 'btn', onclick: () => restoreInput.click() }, 'Load a session or ratings file…') : null,
      empty ? restoreInput : null,
      empty ? null : el('button', {
        class: 'btn',
        title: 'Patches and ratings together. This is the one to move to another machine.',
        onclick: () => {
          const json = new TextEncoder().encode(store.exportSession());
          downloadBytes(json, patchFile(`DX7 session ${new Date().toISOString().slice(0, 10)}`, 'json'));
        },
      }, `Full session (${fmtInt(store.voices.length)} patches + ratings)`),
      empty ? null : el('button', {
        class: 'btn',
        disabled: store.ratings.size === 0 && !store.voices.some((v) => v.pinned),
        title: 'Ratings, pins and category overrides only, keyed by patch content. Reapplies to a corpus you already have.',
        onclick: () => {
          const blob = new TextEncoder().encode(store.exportBackup());
          downloadBytes(blob, patchFile(`DX7 ratings ${new Date().toISOString().slice(0, 10)}`, 'json'));
        },
      }, `Ratings only (${fmtInt(store.ratings.size)})`),
      empty ? null : el('button', { class: 'btn', onclick: () => restoreInput.click() }, 'Load a file…'),
      empty ? null : restoreInput,
      empty ? null : el('button', {
        class: 'btn',
        title: 'The deduplicated corpus as back-to-back 32-voice bulk dumps, which is what every other DX7 tool reads.',
        onclick: () => {
          const { bytes, voices } = store.exportDedupedSyx();
          downloadBytes(bytes, patchFile(`DX7 corpus, ${voices} voices`));
        },
      }, 'Deduped .syx'),
    ),
    result,
  );
  return panel;
}

// -------------------------------------------------------------------- page

function render(): void {
  const store = ctx.store;
  clear(container);

  if (store.voices.length === 0 && !isAdvanced()) {
    container.appendChild(onboarding());
    return;
  }

  const page = el('div', { class: 'stack page-narrow' });
  page.appendChild(pageHead('Sources'));

  if (lastNote) {
    page.appendChild(el('p', { class: 'bad' }, lastNote));
    lastNote = '';
  }

  if (store.voices.length === 0) {
    page.appendChild(el('div', { class: 'panel' }, dropZone(true)));
  } else {
    page.appendChild(pipelinePanel());
    page.appendChild(el('div', { class: 'panel' },
      el('h2', {}, 'Add more'),
      dropZone(false),
      store.lastIngest ? lastImport(store.lastIngest) : null,
    ));
  }

  if (store.voices.length > 0 && (store.ratings.size > 0 || store.tasteModel)) {
    page.appendChild(el('div', { class: 'panel' },
      disclosure('Where the good ones come from', sourcePanel, {
        key: 'sourceScores',
        note: `${fmtInt(store.ratings.size)} rated`,
      })));
  }

  page.appendChild(exportPanel());

  if (isAdvanced()) {
    page.appendChild(el('div', { class: 'panel' },
      disclosure('Read patches off a device', devicePanel, { key: 'device' }),
      store.graph
        ? disclosure('Near-duplicate thresholds', sweepTable, {
          key: 'sweep',
          note: `merge ${store.mergeThreshold.toFixed(2)}  ·  family ${store.threshold.toFixed(2)}`,
        })
        : null,
      disclosure('Start over', dangerZone, { key: 'danger' }),
    ));
  }

  container.appendChild(page);
}

/** What the last import did, as a line, with the awkward parts on request. */
function lastImport(s: NonNullable<typeof ctx.store.lastIngest>): HTMLElement {
  const awkward = s.skipped.length > 0 || s.errors.length > 0 || s.checksumFailures > 0 || s.clampedBytes > 0;
  const wrap = el('div', { style: { marginTop: '12px' } },
    el('p', { class: 'muted', style: { margin: 0, fontSize: '12px' } },
      `Last import: ${fmtInt(s.voicesRead)} voices read from ${fmtInt(s.files)} file${s.files === 1 ? '' : 's'} — `,
      el('b', { class: 'good' }, `${fmtInt(s.added)} new`), `, ${fmtInt(s.merged)} already known`,
      s.rejected ? `, ${fmtInt(s.rejected)} init or silent` : '',
    ));

  if (!awkward) return wrap;

  wrap.appendChild(disclosure('What was skipped', () => {
    const body = el('div', {});
    if (s.skipped.length) {
      const ul = el('ul', { class: 'muted', style: { margin: '0 0 8px', paddingLeft: '18px' } });
      for (const sk of s.skipped) ul.appendChild(el('li', {}, `${sk.reason}: ${fmtInt(sk.count)}`));
      body.appendChild(ul);
    }
    if (s.clampedBytes) {
      body.appendChild(el('p', { class: 'muted', style: { margin: '0 0 8px' } },
        `${fmtInt(s.clampedBytes)} out-of-range bytes were clamped.`));
    }
    if (s.checksumFailures) {
      body.appendChild(el('p', { class: 'warn', style: { margin: '0 0 8px' } },
        `${fmtInt(s.checksumFailures)} voices came from a dump whose checksum did not verify. `,
        'Kept anyway — usually a sloppy archiver rather than corrupt data — but worth a listen.'));
    }
    if (s.errors.length) {
      const ul = el('ul', { class: 'bad', style: { margin: 0, paddingLeft: '18px' } });
      for (const e of s.errors.slice(0, 12)) ul.appendChild(el('li', {}, `${e.file}: ${e.error}`));
      if (s.errors.length > 12) ul.appendChild(el('li', {}, `and ${fmtInt(s.errors.length - 12)} more`));
      body.appendChild(ul);
    }
    return body;
  }, { note: `${fmtInt(s.skipped.reduce((n, x) => n + x.count, 0) + s.errors.length)} entries` }));

  return wrap;
}

function dangerZone(): HTMLElement {
  const store = ctx.store;
  return el('div', {},
    el('div', { class: 'row' },
      el('button', {
        class: 'btn danger',
        disabled: store.ratings.size === 0 && store.faceoffExtras.size === 0,
        onclick: async () => {
          if (!confirm(`Delete all ${store.ratings.size} ratings and ${store.faceoffExtras.size} face-off results? `
            + 'The corpus and its analysis are kept. Save a file first if you might want them back.')) return;
          await ctx.store.resetRatings();
          render();
        },
      }, `Reset all ratings (${fmtInt(store.ratings.size)})`),
      el('button', {
        class: 'btn danger',
        onclick: async () => {
          if (!confirm('Delete all voices, features and ratings? This cannot be undone.')) return;
          await ctx.store.reset();
          render();
        },
      }, 'Delete everything'),
    ),
  );
}

export const view: View = {
  mount(el_, c) {
    ctx = c;
    container = el_;
    unsubscribe = c.store.subscribe(() => {
      // The progress bar updates itself; a full rebuild mid-pass would fight
      // the user's scroll for no gain.
      if (!analysisAbort && !dupeAbort) render();
    });
    render();
    // Anything left half-done from a previous visit carries on by itself.
    void autoAdvance();
  },
  unmount() {
    unsubscribe?.();
    unsubscribe = null;
    analysisAbort?.abort();
    // Leaving the screen releases the inputs back to the keyboard handler.
    listening?.();
    listening = null;
  },
};
